import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool } from "./registry.js";
import { piPath, readJsonSafe, writeJsonAtomic } from "../util/fsx.js";
import { assertMinFrames } from "../util/safety.js";
import { BridgeError } from "../bridge/types.js";
import { Estimator } from "../util/estimates.js";
import { pickRejection } from "../matching/match.js";

export interface Measurement {
  index: number;
  enabled: boolean;
  path: string;
  weight: number;
  fwhm: number;
  eccentricity: number;
  snr_weight: number;
  psf_signal_weight: number;
  median: number;
  noise: number;
  stars: number;
  [k: string]: unknown;
}

interface MeasureStore {
  files: string[];
  measurements: Measurement[];
  pixel_scale: number;
  approval_expression: string;
  weighting_expression: string;
}

async function loadMeasurements(ctx: AppContext): Promise<MeasureStore | undefined> {
  return readJsonSafe<MeasureStore>(path.join(ctx.sessions.ensure().root, "measurements.json"));
}

/**
 * Brief §8 weighting: 10·FWHM term + 10·eccentricity term + 20·SNR term + 50, ranges taken over the approved set.
 * SubframeSelector cannot compute this from a script, so it is done here and stamped as SSWEIGHT.
 */
export function computeWeights(ms: Array<{ fwhm: number; eccentricity: number; snr_weight: number }>): number[] {
  const f = ms.map((m) => m.fwhm);
  const e = ms.map((m) => m.eccentricity);
  const s = ms.map((m) => m.snr_weight);
  const rng = (xs: number[]) => [Math.min(...xs), Math.max(...xs)] as const;
  const [fMin, fMax] = rng(f);
  const [eMin, eMax] = rng(e);
  const [sMin, sMax] = rng(s);
  const norm = (x: number, lo: number, hi: number) => (hi - lo > 1e-9 ? (x - lo) / (hi - lo) : 0.5);
  return ms.map((m) => Number((10 * (1 - norm(m.fwhm, fMin, fMax)) + 10 * (1 - norm(m.eccentricity, eMin, eMax)) + 20 * norm(m.snr_weight, sMin, sMax) + 50).toFixed(4)));
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : NaN;
}

export function registerStackingTools(server: McpServer, ctx: AppContext): void {
  defineTool(server, {
    name: "measure_subframes",
    description:
      "SubframeSelector measurement of (debayered) frames: FWHM, eccentricity, SNR weight, PSF signal weight, star count, median, noise per frame, plus spread statistics. Stored in the session for select_subframes. Async.",
    input: { files: z.array(z.string()), pixel_scale: z.number().optional().describe("arcsec/px; default from rig"), camera_gain: z.number().optional().describe("e-/ADU; default from rig"), wait: z.boolean().optional() },
    handler: async (a) => {
      const scale = a.pixel_scale ?? Number(((206.265 * ctx.cfg.rig.pixelSizeUm) / ctx.cfg.rig.focalLengthMm).toFixed(4));
      const est = new Estimator(ctx.cfg.workdir);
      const job = await ctx.bridge.startJob("measure_subframes", { files: a.files.map(piPath), camera_gain: a.camera_gain ?? ctx.cfg.rig.cameraGainEPerAdu }, { long: true, timeoutMs: 3_600_000, sessionId: ctx.sessions.ensure().id, estimatedSeconds: est.estimate("measure_subframes", a.files.length) });
      const finish = async () => {
        const r = await ctx.bridge.awaitJob(job.id, 3_600_000);
        if (r.status === "ok") {
          const d = r.data as { measurements: Measurement[]; approval_expression: string; weighting_expression: string; pixel_scale: number };
          await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "measurements.json"), { files: a.files, measurements: d.measurements, pixel_scale: d.pixel_scale, approval_expression: d.approval_expression, weighting_expression: d.weighting_expression } satisfies MeasureStore);
          est.learn("measure_subframes", a.files.length, r.elapsed_ms ?? 0);
        }
        return r;
      };
      if (a.wait) {
        const r = await finish();
        if (r.status !== "ok") throw new BridgeError(r.error?.code ?? "FAILED", r.error?.message ?? "measure failed", { console_tail: r.error?.console_tail });
        return summarize(r.data as { measurements: Measurement[] }, scale);
      }
      void finish().catch(() => undefined);
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, note: "async; when done call select_subframes (measurements are stored in the session)" };
    },
  });

  defineTool(server, {
    name: "select_subframes",
    description:
      "Approve/reject measured frames with explicit limits (max_fwhm, max_eccentricity, min_stars, min_snr_weight) or relative rules (fwhm_factor × median). Returns approved/rejected with reasons and the spread, then writes SSWEIGHT into approved frames (output to <session>/work/weighted). Be reluctant to reject with < 20 frames.",
    input: {
      max_fwhm: z.number().optional(),
      fwhm_factor: z.number().optional().describe("Reject FWHM > factor × median (default 1.25 if no max_fwhm)"),
      max_eccentricity: z.number().optional().describe("default 0.6"),
      min_stars: z.number().optional(),
      min_snr_weight: z.number().optional(),
      reject_indexes: z.array(z.number().int()).optional().describe("Force-reject by index"),
      dry_run: z.boolean().optional().describe("Only report, do not write weighted files"),
      out_dir: z.string().optional(),
    },
    handler: async (a) => {
      const st = await loadMeasurements(ctx);
      if (!st) throw new BridgeError("NO_MEASUREMENTS", "run measure_subframes first");
      const ms = st.measurements;
      const fwhmMed = median(ms.map((m) => m.fwhm));
      const eccMed = median(ms.map((m) => m.eccentricity));
      const maxF = a.max_fwhm ?? fwhmMed * (a.fwhm_factor ?? 1.25);
      const maxE = a.max_eccentricity ?? 0.6;
      const approved: Array<{ index: number; path: string; weight: number; fwhm: number; eccentricity: number; stars: number; snr_weight: number }> = [];
      const rejected: Array<{ index: number; path: string; reasons: string[]; fwhm: number; eccentricity: number; stars: number }> = [];
      for (const m of ms) {
        const reasons: string[] = [];
        if (m.fwhm > maxF) reasons.push(`FWHM ${m.fwhm.toFixed(2)} > ${maxF.toFixed(2)}`);
        if (m.eccentricity > maxE) reasons.push(`eccentricity ${m.eccentricity.toFixed(2)} > ${maxE}`);
        if (a.min_stars !== undefined && m.stars < a.min_stars) reasons.push(`stars ${m.stars} < ${a.min_stars}`);
        if (a.min_snr_weight !== undefined && m.snr_weight < a.min_snr_weight) reasons.push(`SNR weight ${m.snr_weight.toFixed(2)} < ${a.min_snr_weight}`);
        if (a.reject_indexes?.includes(m.index)) reasons.push("rejected by request");
        if (reasons.length) rejected.push({ index: m.index, path: m.path, reasons, fwhm: m.fwhm, eccentricity: m.eccentricity, stars: m.stars });
        else approved.push({ index: m.index, path: m.path, weight: m.weight, fwhm: m.fwhm, eccentricity: m.eccentricity, stars: m.stars, snr_weight: m.snr_weight });
      }
      const report = {
        total: ms.length,
        approved_count: approved.length,
        rejected_count: rejected.length,
        limits: { max_fwhm: Number(maxF.toFixed(3)), max_eccentricity: maxE, min_stars: a.min_stars, min_snr_weight: a.min_snr_weight },
        spread: { fwhm_median: Number(fwhmMed.toFixed(3)), fwhm_min: Math.min(...ms.map((m) => m.fwhm)), fwhm_max: Math.max(...ms.map((m) => m.fwhm)), ecc_median: Number(eccMed.toFixed(3)) },
        rejected,
        approved: approved.map((x) => ({ index: x.index, file: path.basename(x.path), weight: x.weight, fwhm: x.fwhm })),
      };
      if (a.dry_run) return { ...report, dry_run: true };
      assertMinFrames(approved.length, 3, false, "continue with");
      const outDir = a.out_dir ?? ctx.sessions.workPath("weighted");
      ctx.safety.assertWritable(outDir);
      const weights = computeWeights(approved);
      const items = approved.map((x, i) => ({ input: x.path, output: path.join(outDir, path.basename(x.path).replace(/\.xisf$/i, "") + "_a.xisf"), weight: weights[i] }));
      const r = await ctx.bridge.run<{ outputs: Array<{ input: string; output: string; weight: number }> }>("write_weights", { items: items.map((it) => ({ ...it, input: piPath(it.input), output: piPath(it.output) })) }, { timeoutMs: 3_600_000, long: true });
      const best = [...r.outputs].sort((x, y) => y.weight - x.weight)[0];
      const bestOut = best?.output;
      await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "selection.json"), { approved: r.outputs, rejected, best_reference: bestOut });
      return { ...report, approved: approved.map((x, i) => ({ index: x.index, file: path.basename(x.path), weight: weights[i], fwhm: x.fwhm })), weighted_files: r.outputs.map((o) => o.output), best_reference: bestOut, out_dir: outDir };
    },
  });

  defineTool(server, {
    name: "register",
    description: "StarAlignment of frames to a reference (default: highest-weight approved frame from select_subframes). Writes *_r.xisf and .xdrz drizzle data. Async, per-frame progress, cancellable.",
    input: { files: z.array(z.string()).optional().describe("Default: weighted files from select_subframes"), reference: z.string().optional(), generate_drizzle: z.boolean().optional().describe("default true"), distortion_correction: z.boolean().optional(), interpolation: z.string().optional(), out_dir: z.string().optional() },
    handler: async (a) => {
      let files = a.files;
      let ref = a.reference;
      const sel = await readJsonSafe<{ approved: Array<{ output: string; weight: number }>; best_reference?: string }>(path.join(ctx.sessions.ensure().root, "selection.json"));
      if (!files?.length) {
        if (!sel) throw new BridgeError("BAD_ARGS", "files required (no select_subframes result in session)");
        files = sel.approved.map((o) => o.output);
      }
      if (!ref) ref = sel?.best_reference ?? files[0];
      assertMinFrames(files.length, 2, true, "register");
      const outDir = a.out_dir ?? ctx.sessions.workPath("registered");
      ctx.safety.assertWritable(outDir);
      const est = new Estimator(ctx.cfg.workdir);
      const job = await ctx.bridge.startJob("register", { files: files.map(piPath), reference: piPath(ref), out_dir: piPath(outDir), generate_drizzle: a.generate_drizzle ?? true, distortion_correction: a.distortion_correction, interpolation: a.interpolation }, { long: true, timeoutMs: 6 * 3_600_000, sessionId: ctx.sessions.ensure().id, estimatedSeconds: est.estimate("register", files.length) });
      void ctx.bridge.awaitJob(job.id, 6 * 3_600_000).then(async (r) => {
        if (r.status === "ok") {
          est.learn("register", files!.length, r.elapsed_ms ?? 0);
          await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "registration.json"), { reference: ref, ...(r.data as object) });
        }
      }).catch(() => undefined);
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, reference: ref, frames: files.length, out_dir: outDir, note: "async" };
    },
  });

  defineTool(server, {
    name: "local_normalization",
    description: "LocalNormalization (.xnml) of registered frames against the reference; feeds integrate/drizzle for gradient-aware normalization. Async, per-frame.",
    input: { files: z.array(z.string()).optional().describe("Default: registered outputs"), reference: z.string().optional().describe("Default: registered reference frame"), scale: z.number().int().optional().describe("default 256"), out_dir: z.string().optional() },
    handler: async (a) => {
      const reg = await readJsonSafe<{ reference: string; outputs: string[]; per_frame: Array<{ input: string; output: string }> }>(path.join(ctx.sessions.ensure().root, "registration.json"));
      const files = a.files?.length ? a.files : reg?.outputs;
      if (!files?.length) throw new BridgeError("BAD_ARGS", "files required (no registration result in session)");
      let ref = a.reference;
      if (!ref) {
        const refOut = reg?.per_frame.find((p) => p.input === reg.reference)?.output;
        ref = refOut ?? files[0];
      }
      const outDir = a.out_dir ?? ctx.sessions.workPath("lnorm");
      ctx.safety.assertWritable(outDir);
      const est = new Estimator(ctx.cfg.workdir);
      const job = await ctx.bridge.startJob("local_normalization", { files: files.map(piPath), reference: piPath(ref), scale: a.scale ?? 256, out_dir: piPath(outDir) }, { long: true, timeoutMs: 6 * 3_600_000, sessionId: ctx.sessions.ensure().id, estimatedSeconds: est.estimate("local_normalization", files.length) });
      void ctx.bridge.awaitJob(job.id, 6 * 3_600_000).then(async (r) => {
        if (r.status === "ok") {
          est.learn("local_normalization", files.length, r.elapsed_ms ?? 0);
          await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "lnorm.json"), r.data);
        }
      }).catch(() => undefined);
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, reference: ref, frames: files.length, out_dir: outDir, note: "async" };
    },
  });

  defineTool(server, {
    name: "integrate",
    description:
      "ImageIntegration of registered frames → master light .xisf. Rejection auto by count (<8 Percentile, 8–20 Winsorized, >20 LinearFit), normalization additive+scaling (or LocalNormalization when .xnml given/available), weights from SSWEIGHT keyword or PSF signal weight. Reports rejected-pixel % (high = clouds/satellites/bad frame). Refuses < 3 frames without force. ALWAYS async.",
    input: {
      files: z.array(z.string()).optional().describe("Default: registered outputs"),
      rejection: z.enum(["auto", "NoRejection", "MinMax", "PercentileClip", "SigmaClip", "WinsorizedSigmaClip", "AveragedSigmaClip", "LinearFit", "CCDClip"]).optional(),
      normalization: z.string().optional(),
      rejection_normalization: z.string().optional(),
      weights: z.enum(["SSWEIGHT", "PSFSignalWeight", "PSFScaleSNR", "SNREstimate", "NoiseEvaluation", "DontCare"]).optional().describe("default SSWEIGHT if weighted frames were used, else PSFSignalWeight"),
      use_local_normalization: z.boolean().optional().describe("default: true if local_normalization ran"),
      lnorm_files: z.array(z.string()).optional(),
      drizzle_files: z.array(z.string()).optional().describe("Default: .xdrz next to registered frames when present"),
      sigma_low: z.number().optional(),
      sigma_high: z.number().optional(),
      large_scale_clip_high: z.boolean().optional(),
      keep_open: z.boolean().optional().describe("Keep the integration window open as a view (default true)"),
      out: z.string().optional(),
      force: z.boolean().optional(),
    },
    handler: async (a) => {
      const s = ctx.sessions.ensure();
      const reg = await readJsonSafe<{ outputs: string[]; drizzle_files?: string[] }>(path.join(s.root, "registration.json"));
      const files = a.files?.length ? a.files : reg?.outputs;
      if (!files?.length) throw new BridgeError("BAD_ARGS", "files required (no registration result in session)");
      assertMinFrames(files.length, 3, a.force, "integrate");
      const ln = await readJsonSafe<{ outputs: Array<{ input: string; xnml: string }> }>(path.join(s.root, "lnorm.json"));
      let lnormFiles = a.lnorm_files;
      if (!lnormFiles && (a.use_local_normalization ?? !!ln) && ln) lnormFiles = files.map((f) => ln.outputs.find((o) => o.input === f)?.xnml ?? "");
      let drz = a.drizzle_files;
      if (!drz) {
        const fs = await import("node:fs");
        const cand = files.map((f) => f.replace(/\.xisf$/i, ".xdrz"));
        if (cand.every((c) => fs.existsSync(c))) drz = cand;
      }
      const weights = a.weights ?? (files.some((f) => /_a_r\.xisf$|_a\.xisf$/i.test(f)) ? "SSWEIGHT" : "PSFSignalWeight");
      const out = a.out ?? ctx.sessions.workPath("master", `master_light_${new Date().toISOString().slice(0, 10)}.xisf`);
      ctx.safety.assertNoClobber(out, false);
      const est = new Estimator(ctx.cfg.workdir);
      const rejection = !a.rejection || a.rejection === "auto" ? pickRejection(files.length) : a.rejection;
      const job = await ctx.bridge.startJob(
        "integrate",
        { files: files.map(piPath), out: piPath(out), rejection, normalization: a.normalization, rejection_normalization: a.rejection_normalization, weights, lnorm_files: lnormFiles?.map((f) => (f ? piPath(f) : "")), drizzle_files: drz?.map(piPath), sigma_low: a.sigma_low, sigma_high: a.sigma_high, large_scale_clip_high: a.large_scale_clip_high, keep_open: a.keep_open ?? true, keep_rejection_maps: true, force: a.force },
        { long: true, timeoutMs: 12 * 3_600_000, sessionId: s.id, estimatedSeconds: est.estimate("integrate", files.length) },
      );
      void ctx.bridge.awaitJob(job.id, 12 * 3_600_000).then(async (r) => {
        if (r.status === "ok") {
          est.learn("integrate", files.length, r.elapsed_ms ?? 0);
          await writeJsonAtomic(path.join(s.root, "integration.json"), r.data);
        }
      }).catch(() => undefined);
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, frames: files.length, rejection, weights, local_normalization: !!lnormFiles, drizzle_data: !!drz, out, note: "async: poll job_status; result includes stats.rejected_total_pct and view_id of the master" };
    },
  });

  defineTool(server, {
    name: "drizzle_integrate",
    description: "DrizzleIntegration from .xdrz files (written by register and updated by integrate). Needs dithered subs; scale 1 (CFA-free super-sampling of rejection) or 2. Async.",
    input: { xdrz_files: z.array(z.string()).optional().describe("Default: registration drizzle files"), scale: z.union([z.literal(1), z.literal(2)]).optional(), drop_shrink: z.number().optional().describe("default 0.9"), kernel: z.string().optional(), use_local_normalization: z.boolean().optional(), keep_open: z.boolean().optional(), out: z.string().optional() },
    handler: async (a) => {
      const s = ctx.sessions.ensure();
      const reg = await readJsonSafe<{ outputs: string[]; drizzle_files?: string[] }>(path.join(s.root, "registration.json"));
      const xdrz = a.xdrz_files?.length ? a.xdrz_files : reg?.drizzle_files;
      if (!xdrz?.length) throw new BridgeError("BAD_ARGS", "xdrz_files required (register with generate_drizzle first)");
      const ln = await readJsonSafe<{ outputs: Array<{ input: string; xnml: string }> }>(path.join(s.root, "lnorm.json"));
      const lnorm = (a.use_local_normalization ?? !!ln) && ln ? xdrz.map((x) => ln.outputs.find((o) => o.input.replace(/\.xisf$/i, "") === x.replace(/\.xdrz$/i, ""))?.xnml ?? "") : undefined;
      const out = a.out ?? ctx.sessions.workPath("master", `master_light_drizzle${a.scale ?? 2}x_${new Date().toISOString().slice(0, 10)}.xisf`);
      ctx.safety.assertNoClobber(out, false);
      const est = new Estimator(ctx.cfg.workdir);
      const job = await ctx.bridge.startJob("drizzle_integrate", { xdrz_files: xdrz.map(piPath), out: piPath(out), scale: a.scale ?? 2, drop_shrink: a.drop_shrink, kernel: a.kernel, lnorm_files: lnorm?.map((f) => (f ? piPath(f) : "")), keep_open: a.keep_open ?? true }, { long: true, timeoutMs: 12 * 3_600_000, sessionId: s.id, estimatedSeconds: est.estimate("drizzle_integrate", xdrz.length) });
      void ctx.bridge.awaitJob(job.id, 12 * 3_600_000).then((r) => r.status === "ok" && est.learn("drizzle_integrate", xdrz.length, r.elapsed_ms ?? 0)).catch(() => undefined);
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, frames: xdrz.length, out, note: "async" };
    },
  });

  defineTool(server, {
    name: "fast_integrate",
    description: "Quick-look stack with FastIntegration (registration + integration in one pass, no drizzle, no LN). Good for a 2-minute sanity check of a night's data. Async.",
    input: { files: z.array(z.string()), reference: z.string().optional(), out: z.string().optional(), keep_open: z.boolean().optional() },
    handler: async (a) => {
      const out = a.out ?? ctx.sessions.workPath("quicklook", `quicklook_${Date.now()}.xisf`);
      ctx.safety.assertNoClobber(out, false);
      const est = new Estimator(ctx.cfg.workdir);
      const job = await ctx.bridge.startJob("fast_integrate", { files: a.files.map(piPath), reference: a.reference ? piPath(a.reference) : undefined, out: piPath(out), keep_open: a.keep_open ?? true }, { long: true, timeoutMs: 3_600_000, sessionId: ctx.sessions.ensure().id, estimatedSeconds: est.estimate("fast_integrate", a.files.length) });
      return { job_id: job.id, estimated_seconds: job.estimated_seconds, out, note: "async" };
    },
  });
}

function summarize(d: { measurements: Measurement[] }, scale: number) {
  const ms = d.measurements;
  const f = ms.map((m) => m.fwhm);
  const e = ms.map((m) => m.eccentricity);
  return {
    count: ms.length,
    pixel_scale: scale,
    fwhm_px: { median: median(f), min: Math.min(...f), max: Math.max(...f) },
    fwhm_arcsec_median: Number((median(f) * scale).toFixed(3)),
    eccentricity: { median: median(e), min: Math.min(...e), max: Math.max(...e) },
    stars: { median: median(ms.map((m) => m.stars)) },
    frames: ms.map((m) => ({ index: m.index, file: path.basename(m.path), fwhm: m.fwhm, ecc: m.eccentricity, stars: m.stars, snr_w: m.snr_weight, weight: m.weight })),
  };
}
