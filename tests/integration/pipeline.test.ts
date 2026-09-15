// End-to-end tests against a real PixInsight. Skipped unless PI_INTEGRATION=1.
// Uses the synthetic fixtures (192×128 RGGB) so a full run finishes in well under two minutes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateFixtures } from "../fixtures/gen.js";

const ENABLED = process.env.PI_INTEGRATION === "1";
const d = ENABLED ? describe : describe.skip;

function txt(r: unknown): string {
  return (r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === "text")?.text ?? "";
}

d("pixinsight-mcp end to end (fixtures)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pimcp-e2e-"));
  const dataRoot = path.join(tmp, "data");
  const workdir = path.join(tmp, "work");
  let client: Client;
  let call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

  beforeAll(async () => {
    generateFixtures(dataRoot, 5);
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: process.cwd(),
      env: { ...process.env, PIMCP_DATA_ROOT: dataRoot, PIMCP_WORKDIR: workdir, PIMCP_REQUIRE_FLATS: "true", PIMCP_CONFIG: path.join(tmp, "none.json") },
      stderr: "inherit",
    });
    client = new Client({ name: "e2e", version: "0.0.1" });
    await client.connect(transport);
    call = async (name, args = {}) => JSON.parse(txt(await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })));
  }, 120_000);

  afterAll(async () => {
    // Close the PixInsight instance this suite launched (its own workdir → its own daemon).
    try { await client?.callTool({ name: "pi_stop", arguments: { mode: "kill" } }); } catch { /* ignore */ }
    await client?.close();
  });

  it("launches the daemon and reports capabilities", async () => {
    const st = await call("pi_status", { launch: true });
    expect(st.daemon_alive).toBe(true);
    expect((st.capabilities as { processes: Record<string, boolean> }).processes.ImageIntegration).toBe(true);
  }, 120_000);

  it("scans and matches the fixture set (darks + flats + bias, CMOS policy)", async () => {
    const scan = await call("scan_frames", {});
    expect((scan.summary as { by_type: Record<string, number> }).by_type).toEqual({ light: 5, dark: 15, flat: 5, bias: 5 });
    const plan = await call("match_calibration", { light_group_id: "light_01" });
    const policy = plan.policy as Record<string, unknown>;
    expect(policy.mode).toBe("dark+flat");
    expect(policy.master_bias_enabled).toBe(false);
    expect((plan.dark as { chosen: { grade: string } }).chosen.grade).toBe("ok");
    expect(policy.flat_calibration).toBe("bias"); // no flat-dark in fixtures; bias exists
  });

  it("runs the whole pipeline to a master light and the stats are sane", async () => {
    const start = await call("pipeline_run", { light_group_id: "light_01", engine: "native", skip_local_normalization: true, keep_intermediates: true });
    expect(start.pipeline_id).toBeTruthy();
    let st: Record<string, unknown> = {};
    const t0 = Date.now();
    while (Date.now() - t0 < 500_000) {
      await new Promise((r) => setTimeout(r, 5000));
      st = await call("pipeline_status", { pipeline_id: start.pipeline_id });
      if (st.status !== "running") break;
    }
    expect(st.status, JSON.stringify(st, null, 1)).toBe("ok");
    expect(st.master_light).toMatch(/\.xisf$/);
    const stats = await call("image_statistics", { id: st.master_view_id as string });
    const ch = stats.channels as Array<{ median: number; clipped_low_pct: number; noise_sigma: number }>;
    expect(ch.length).toBe(3);
    for (const c of ch) {
      expect(c.median).toBeGreaterThan(0);
      expect(c.clipped_low_pct).toBeLessThan(0.05);
    }
    // Golden: the synthetic sky has 35 % corner vignetting that the master flat must remove.
    // Compare a corner background patch with a top-middle background patch (both away from the galaxy):
    // uncorrected ratio ≈ 0.5, flat-fielded ≈ 1.
    const mid = await call("image_statistics", { id: st.master_view_id as string, rect: [84, 4, 24, 12] });
    const corner = await call("image_statistics", { id: st.master_view_id as string, rect: [4, 4, 20, 14] });
    const ratio = (corner.channels as Array<{ median: number }>)[1].median / (mid.channels as Array<{ median: number }>)[1].median;
    expect(ratio, `corner/mid background ratio ${ratio}`).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.25);
    // Master library populated
    const masters = await call("list_masters", {});
    expect((masters.masters as unknown[]).length).toBeGreaterThanOrEqual(3);
    // Preview renders
    const prev = await client.callTool({ name: "render_preview", arguments: { id: st.master_view_id } });
    expect((prev as { content: Array<{ type: string }> }).content[0].type).toBe("image");
  }, 600_000);

  it("refuses to write into the data root", async () => {
    const r = await call("save_image", { id: "integration", path: path.join(dataRoot, "x.xisf") });
    expect(r.error).toBe("UNSAFE_OUTPUT");
  });

  it("chaos: killing PixInsight surfaces DAEMON_DEAD and relaunch recovers", async () => {
    const k = await call("pi_stop", { mode: "kill" });
    expect(k.killed).toBe(true);
    const st = await call("pi_status", {});
    expect(st.daemon_alive).toBe(false);
    const st2 = await call("pi_status", { launch: true });
    expect(st2.daemon_alive).toBe(true);
  }, 180_000);
});
