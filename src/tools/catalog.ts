import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool } from "./registry.js";
import { piPath, readJsonSafe } from "../util/fsx.js";
import { BridgeError } from "../bridge/types.js";

/** Gaia catalog setup and the human-readable processing log. */
export function registerCatalogTools(server: McpServer, ctx: AppContext): void {
  defineTool(server, {
    name: "configure_gaia",
    description: "Register local Gaia DR3/SP (or DR3) .xpsd database files in PixInsight (persists in its settings) so plate_solve and SPCC work offline. Pass a directory (all *.xpsd inside) or explicit files. Runs a test search afterwards.",
    input: { dir: z.string().optional(), files: z.array(z.string()).optional(), data_release: z.enum(["DR3/SP", "DR3"]).optional() },
    handler: async ({ dir, files, data_release }) => {
      let list = files ?? [];
      if (dir) list = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".xpsd")).map((f) => path.join(dir, f)).sort();
      if (!list.length) throw new BridgeError("BAD_ARGS", "no .xpsd files given/found");
      return ctx.bridge.run("configure_gaia", { files: list.map(piPath), data_release }, { timeoutMs: 300_000 });
    },
  });

  defineTool(server, {
    name: "gaia_info",
    description: "Is a local Gaia database configured in PixInsight (DR3/SP for SPCC + plate solving)?",
    input: { data_release: z.enum(["DR3/SP", "DR3"]).optional() },
    readOnly: true,
    handler: async (a) => ctx.bridge.run("gaia_info", a, { timeoutMs: 60_000 }),
  });

  defineTool(server, {
    name: "write_processing_log",
    description: "Write <working-files>/PROCESSING.md: a human-readable record of the whole session (data, frames dropped by blink, calibration plan, stacking engine + stats, every post-processing step with parameters and checkpoints, exports). save_project calls this automatically.",
    input: { title: z.string().optional(), notes: z.string().optional().describe("Free text appended at the end") },
    handler: async ({ title, notes }) => writeProcessingLog(ctx, title, notes),
  });
}

export async function writeProcessingLog(ctx: AppContext, title?: string, notes?: string): Promise<{ path: string; steps: number }> {
  const s = ctx.sessions.ensure();
  const read = <T,>(f: string) => readJsonSafe<T>(path.join(s.root, f));
  const scan = await read<{ root: string; summary: Record<string, unknown>; groups: Array<Record<string, unknown>>; warnings?: string[] }>("scan.json");
  const blink = await read<{ group_id?: string; files: string[]; metrics: Array<{ index: number; file: string; median?: number; stars?: number; flags?: string[] }> }>("blink.json");
  const excl = await read<{ excluded_indexes: number[]; excluded_files: string[]; reason?: string }>("exclusions.json");
  const history = (await read<Array<{ at: string; tool: string; view?: string; args: Record<string, unknown>; checkpoint?: string }>>("history.json")) ?? [];
  const pipelines = ctx.pipelines.list().sort();
  const pipe = pipelines.length ? await readJsonSafe<Record<string, unknown>>(path.join(s.pipeline, `${pipelines[pipelines.length - 1]}.json`)) : undefined;
  const fmt = (v: unknown) => (typeof v === "number" ? Number(v.toFixed(4)) : v);
  const L: string[] = [];
  L.push(`# ${title ?? `Processing log — ${s.target_dir ? path.basename(s.target_dir) : s.name}`}`, "");
  L.push(`Generated ${new Date().toISOString()} by pixinsight-mcp. Session \`${s.id}\`. Working files: \`${s.work}\``, "");
  if (scan) {
    L.push("## Data", "", `Scanned \`${scan.root}\`.`, "");
    L.push("| Group | Frames | Exposure | Gain | Temp (median) | Directory |", "|---|---|---|---|---|---|");
    for (const g of scan.groups) L.push(`| ${g.id} ${g.label} | ${g.count} | ${g.exptime ?? ""} s | ${g.gain ?? ""} | ${g.ccd_temp_median !== undefined ? Number(g.ccd_temp_median as number).toFixed(1) + " °C" : ""} | \`${g.dir}\` |`);
    if (scan.warnings?.length) L.push("", ...scan.warnings.map((w) => `- ⚠ ${w}`));
    L.push("");
  }
  if (blink) {
    L.push("## Blink review", "");
    L.push(`${blink.metrics.length} frames reviewed. Group median background ${fmt(median(blink.metrics.map((m) => m.median ?? 0)))}, median stars ${median(blink.metrics.map((m) => m.stars ?? 0))}.`, "");
    if (excl?.excluded_indexes?.length) {
      L.push("Dropped:", "");
      for (const i of excl.excluded_indexes) {
        const m = blink.metrics.find((x) => x.index === i);
        L.push(`- #${i} \`${path.basename(blink.files[i])}\` — ${m?.flags?.join("; ") ?? ""}${excl.reason ? ` (${excl.reason})` : ""}`);
      }
    } else L.push("No frames dropped.");
    L.push("");
  }
  if (pipe) {
    const plan = pipe.plan as { policy?: { mode: string; reasoning: string[] }; dark?: { chosen?: { label: string; grade: string; deltas: Record<string, unknown> } }; flat?: { chosen?: { label: string } }; warnings?: string[] } | undefined;
    L.push("## Calibration plan", "");
    if (plan?.dark?.chosen) L.push(`- Dark: ${plan.dark.chosen.label} (grade ${plan.dark.chosen.grade}, Δ ${JSON.stringify(plan.dark.chosen.deltas)})`);
    L.push(`- Flat: ${plan?.flat?.chosen?.label ?? "none"}`);
    L.push(`- Policy: ${plan?.policy?.mode}`, ...(plan?.policy?.reasoning ?? []).map((r) => `  - ${r}`));
    for (const w of (pipe.warnings as string[] | undefined) ?? []) L.push(`- ⚠ ${w}`);
    L.push("", "## Stacking", "", `Engine **${pipe.engine}**, pipeline \`${pipe.id}\`, status ${pipe.status}. Lights used: ${(pipe.files as { lights: string[] }).lights.length}.`, "");
    L.push("| Stage | Status | Time | Note |", "|---|---|---|---|");
    for (const st of pipe.stages as Array<{ name: string; status: string; elapsed_ms?: number; note?: string; error?: { message: string } }>) L.push(`| ${st.name} | ${st.status} | ${st.elapsed_ms ? Math.round(st.elapsed_ms / 1000) + " s" : ""} | ${st.error?.message ?? st.note ?? ""} |`);
    const files = pipe.files as { master_light?: string };
    if (files.master_light) L.push("", `Master light: \`${files.master_light}\``);
    const stats = (pipe.stages as Array<{ name: string; data?: { stats?: Record<string, unknown> } }>).find((x) => x.name === "integrate")?.data?.stats;
    if (stats) L.push(`Integration: ${stats.number_of_images} images, rejected ${stats.rejected_total_pct}% (low ${stats.rejected_low_pct}%, high ${stats.rejected_high_pct}%)`);
    L.push("");
  }
  L.push("## Post-processing steps", "");
  if (!history.length) L.push("(none recorded)");
  history.forEach((h, i) => {
    const { id: _id, checkpoint: _c, ...rest } = h.args;
    void _id;
    void _c;
    const argTxt = Object.entries(rest).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
    L.push(`${i + 1}. \`${h.tool}\` on \`${h.view ?? "?"}\`${argTxt ? ` — ${argTxt}` : ""}  <sub>${h.at.replace("T", " ").slice(0, 19)}</sub>${h.checkpoint ? `  \n   checkpoint: \`${path.basename(h.checkpoint)}\`` : ""}`);
  });
  L.push("");
  const exportDir = path.join(s.work, "export");
  const projDir = path.join(s.work, "project");
  const outs = [exportDir, projDir].filter((d) => fs.existsSync(d)).flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f)));
  if (outs.length) L.push("## Outputs", "", ...outs.map((f) => `- \`${f}\` (${(fs.statSync(f).size / 1e6).toFixed(1)} MB)`), "");
  if (notes) L.push("## Notes", "", notes, "");
  const out = path.join(s.work, "PROCESSING.md");
  fs.mkdirSync(s.work, { recursive: true });
  fs.writeFileSync(out, L.join("\n"), "utf8");
  return { path: out, steps: history.length };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
