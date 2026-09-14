import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool } from "./registry.js";
import { fingerprint, type MasterKind } from "../matching/masters.js";
import { readFitsHeader } from "../fits/header.js";
import { frameFromHeader } from "../fits/classify.js";
import { tempBucket } from "../fits/classify.js";
import { piPath } from "../util/fsx.js";
import { assertMinFrames } from "../util/safety.js";
import { BridgeError } from "../bridge/types.js";
import { loadScan, groupById } from "./inventory.js";
import { Estimator } from "../util/estimates.js";

const Files = z.array(z.string()).optional().describe("Explicit file list");
const GroupId = z.string().optional().describe("Group id from scan_frames (alternative to files)");

export async function resolveFiles(ctx: AppContext, files?: string[], group_id?: string): Promise<string[]> {
  if (files?.length) return files.map((f) => path.resolve(f));
  if (group_id) {
    const scan = await loadScan(ctx);
    if (!scan) throw new BridgeError("NO_SCAN", "run scan_frames first or pass files");
    return groupById(scan, group_id).files;
  }
  throw new BridgeError("BAD_ARGS", "files or group_id required");
}

async function describeFrames(files: string[]): Promise<{ camera?: string; gain?: number; offset?: number; binning?: number; exptime?: number; temp_bucket?: string; filter?: string }> {
  const first = files[0];
  if (!/\.(fit|fits|fts)$/i.test(first)) return {};
  const h = await readFitsHeader(first);
  const r = frameFromHeader(first, h, 0);
  return { camera: r.instrume, gain: r.gain, offset: r.offset, binning: r.binning, exptime: r.exptime, temp_bucket: tempBucket(r.ccd_temp, 2), filter: r.filter };
}

/** Shared master-building flow with library caching. Runs async in PixInsight. */
export async function buildMaster(
  ctx: AppContext,
  kind: MasterKind,
  files: string[],
  opts: { force?: boolean; master_bias?: string; master_flat_dark?: string; rejection?: string; params?: Record<string, unknown>; wait?: boolean },
): Promise<Record<string, unknown>> {
  assertMinFrames(files.length, 3, opts.force, `build a master ${kind}`);
  const desc = await describeFrames(files);
  const fp = await fingerprint({ kind, ...desc, files, params: { master_bias: opts.master_bias ? path.basename(opts.master_bias) : "", master_flat_dark: opts.master_flat_dark ? path.basename(opts.master_flat_dark) : "", rejection: opts.rejection ?? "auto", params: opts.params ?? {} } });
  const hit = ctx.masters.lookup(kind, fp);
  if (hit && !opts.force) return { cached: true, path: hit.path, fingerprint: fp, frame_count: hit.frame_count, created_at: hit.created_at, stats: hit.stats };
  const out = ctx.masters.pathFor(kind, fp);
  ctx.safety.assertWritable(out);
  const op = kind === "bias" ? "build_master_bias" : kind === "flat" ? "build_master_flat" : "build_master_dark";
  const est = new Estimator(ctx.cfg.workdir);
  const job = await ctx.bridge.startJob(
    op,
    { files: files.map(piPath), out: piPath(out), master_bias: opts.master_bias ? piPath(opts.master_bias) : undefined, master_flat_dark: opts.master_flat_dark ? piPath(opts.master_flat_dark) : undefined, rejection: opts.rejection, params: opts.params },
    { long: true, timeoutMs: 3_600_000, sessionId: ctx.sessions.ensure().id, estimatedSeconds: est.estimate(op, files.length) },
  );
  const finalize = async () => {
    const r = await ctx.bridge.awaitJob(job.id, 3_600_000);
    if (r.status === "ok") {
      const data = r.data as { stats?: unknown; rejection?: string };
      await ctx.masters.record({ fingerprint: fp, kind, path: out, created_at: "", frame_count: files.length, source_files: files, params: { rejection: data.rejection, master_bias: opts.master_bias, master_flat_dark: opts.master_flat_dark, ...(opts.params ?? {}) }, ...desc, stats: data.stats });
      est.learn(op, files.length, r.elapsed_ms ?? 0);
    }
    return r;
  };
  if (opts.wait) {
    const r = await finalize();
    if (r.status !== "ok") throw new BridgeError(r.error?.code ?? "FAILED", `${op} failed: ${r.error?.message}`, { job_id: job.id, console_tail: r.error?.console_tail });
    return { cached: false, path: out, fingerprint: fp, job_id: job.id, ...(r.data as object) };
  }
  void finalize().catch(() => undefined);
  return { job_id: job.id, estimated_seconds: job.estimated_seconds, path: out, fingerprint: fp, cached: false, note: "async: poll job_status/job_wait; the master is recorded in the library on completion" };
}

export function registerCalibrationTools(server: McpServer, ctx: AppContext): void {
  defineTool(server, {
    name: "build_master_bias",
    description: "Integrate bias frames into a master bias (average, Winsorized/percentile rejection by count, no normalization). Cached by fingerprint; returns instantly on a hit. Async unless wait:true.",
    input: { files: Files, group_id: GroupId, force: z.boolean().optional(), rejection: z.string().optional(), wait: z.boolean().optional().describe("Block until done (bias is fast)") },
    handler: async ({ files, group_id, force, rejection, wait }) => buildMaster(ctx, "bias", await resolveFiles(ctx, files, group_id), { force, rejection, wait: wait ?? true }),
  });

  defineTool(server, {
    name: "build_master_dark",
    description: "Integrate darks into a master dark. Do NOT pass master_bias unless you will use dark optimisation (CMOS rule: bias lives inside the dark). Cached by fingerprint. Async: returns job_id.",
    input: { files: Files, group_id: GroupId, master_bias: z.string().optional(), force: z.boolean().optional(), rejection: z.string().optional(), wait: z.boolean().optional() },
    handler: async ({ files, group_id, master_bias, force, rejection, wait }) => buildMaster(ctx, "dark", await resolveFiles(ctx, files, group_id), { force, master_bias, rejection, wait }),
  });

  defineTool(server, {
    name: "build_master_flat",
    description: "Calibrate flats with a master flat-dark (preferred) or master bias, then integrate multiplicatively (EqualizeFluxes rejection normalization). Never calibrate flats with the light master dark. Cached. Async.",
    input: { files: Files, group_id: GroupId, master_flat_dark: z.string().optional(), master_bias: z.string().optional(), force: z.boolean().optional(), rejection: z.string().optional(), wait: z.boolean().optional() },
    handler: async ({ files, group_id, master_flat_dark, master_bias, force, rejection, wait }) => buildMaster(ctx, "flat", await resolveFiles(ctx, files, group_id), { force, master_flat_dark, master_bias, rejection, wait }),
  });

  defineTool(server, {
    name: "calibrate_lights",
    description:
      "ImageCalibration of light frames (CFA-aware) with master dark/flat (+bias only for dark scaling). Refuses without a master flat unless config requireFlats=false or force:true. Outputs <session>/work/calibrated/*_c.xisf. Async with per-frame progress.",
    input: {
      files: Files,
      group_id: GroupId,
      master_dark: z.string().optional(),
      master_flat: z.string().optional(),
      master_bias: z.string().optional(),
      optimize_darks: z.boolean().optional().describe("Dark scaling (requires master_bias); default false"),
      calibrate_dark: z.boolean().optional().describe("Subtract bias from the master dark before use (only with optimize_darks)"),
      output_pedestal: z.number().optional().describe("DN pedestal added to outputs (0 default)"),
      force: z.boolean().optional(),
      out_dir: z.string().optional(),
    },
    handler: async (a) => {
      const files = await resolveFiles(ctx, a.files, a.group_id);
      if (!a.master_flat && ctx.cfg.requireFlats && !a.force) throw new BridgeError("NO_MASTER_FLAT", "no master flat given; vignetting/dust will not be corrected. Pass force:true (or set requireFlats=false) to proceed anyway.");
      if (!a.master_dark && !a.master_bias && !a.master_flat) throw new BridgeError("BAD_ARGS", "nothing to calibrate with: give at least one master");
      if (a.optimize_darks && !a.master_bias) throw new BridgeError("BAD_ARGS", "optimize_darks needs master_bias");
      const outDir = a.out_dir ?? ctx.sessions.workPath("calibrated");
      ctx.safety.assertWritable(outDir);
      const est = new Estimator(ctx.cfg.workdir);
      const job = await ctx.bridge.startJob(
        "calibrate_lights",
        { files: files.map(piPath), out_dir: piPath(outDir), master_dark: a.master_dark ? piPath(a.master_dark) : undefined, master_flat: a.master_flat ? piPath(a.master_flat) : undefined, master_bias: a.master_bias ? piPath(a.master_bias) : undefined, optimize_darks: !!a.optimize_darks, calibrate_dark: !!a.calibrate_dark, output_pedestal: a.output_pedestal, cfa: true },
        { long: true, timeoutMs: 3_600_000, sessionId: ctx.sessions.ensure().id, estimatedSeconds: est.estimate("calibrate_lights", files.length) },
      );
      const warnings: string[] = [];
      if (!a.master_flat) warnings.push("no master flat: vignetting and dust motes remain");
      if (!a.master_dark) warnings.push("no master dark: run cosmetic_correction with auto_detect");
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, out_dir: outDir, frames: files.length, warnings, note: "async: poll job_status / job_wait" };
    },
  });

  defineTool(server, {
    name: "cosmetic_correction",
    description: "CosmeticCorrection on calibrated (still mosaiced, cfa:true) frames: hot pixels from the master dark and/or auto-detect (sigma). Run BEFORE debayer. Async with per-frame progress; ~120 s for 30 frames.",
    input: { files: z.array(z.string()), master_dark: z.string().optional(), auto_detect: z.boolean().optional().describe("Auto sigma detection (default true)"), hot_sigma: z.number().optional().describe("default 3.0"), cold_auto: z.boolean().optional(), hot_dark_level: z.number().optional(), cfa: z.boolean().optional().describe("default true (OSC)"), out_dir: z.string().optional(), wait: z.boolean().optional() },
    handler: async (a) => {
      const outDir = a.out_dir ?? ctx.sessions.workPath("cosmetic");
      ctx.safety.assertWritable(outDir);
      const est = new Estimator(ctx.cfg.workdir);
      const job = await ctx.bridge.startJob("cosmetic_correction", { ...a, files: a.files.map(piPath), master_dark: a.master_dark ? piPath(a.master_dark) : undefined, out_dir: piPath(outDir), cfa: a.cfa ?? true }, { long: true, timeoutMs: 3_600_000, sessionId: ctx.sessions.ensure().id, estimatedSeconds: est.estimate("cosmetic_correction", a.files.length) });
      if (a.wait) return ctx.bridge.awaitJob(job.id, 3_600_000);
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, out_dir: outDir, note: "async" };
    },
  });

  defineTool(server, {
    name: "debayer",
    description: "Debayer CFA frames (pattern Auto reads BAYERPAT; ASI2600MC = RGGB) with VNG (default) / SuperPixel / Bilinear. Run AFTER cosmetic correction. Async with per-frame progress.",
    input: { files: z.array(z.string()), pattern: z.enum(["Auto", "RGGB", "BGGR", "GBRG", "GRBG"]).optional(), method: z.enum(["VNG", "SuperPixel", "Bilinear"]).optional(), out_dir: z.string().optional(), wait: z.boolean().optional() },
    handler: async (a) => {
      const outDir = a.out_dir ?? ctx.sessions.workPath("debayered");
      ctx.safety.assertWritable(outDir);
      const est = new Estimator(ctx.cfg.workdir);
      const job = await ctx.bridge.startJob("debayer", { files: a.files.map(piPath), pattern: a.pattern ?? "Auto", method: a.method ?? "VNG", out_dir: piPath(outDir) }, { long: true, timeoutMs: 3_600_000, sessionId: ctx.sessions.ensure().id, estimatedSeconds: est.estimate("debayer", a.files.length) });
      if (a.wait) return ctx.bridge.awaitJob(job.id, 3_600_000);
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, out_dir: outDir, note: "async" };
    },
  });
}
