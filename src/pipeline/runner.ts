import path from "node:path";
import fs from "node:fs";
import type { AppContext } from "../context.js";
import { SessionManager } from "../session.js";
import { BridgeError, type JobResult } from "../bridge/types.js";
import { makeId, nowIso, piPath, readJsonSafe, writeJsonAtomic } from "../util/fsx.js";
import { buildPlan, pickRejection, type CalibrationPlan } from "../matching/match.js";
import type { ScanResult } from "../matching/inventory.js";
import type { FrameGroup } from "../fits/types.js";
import { buildMaster } from "../tools/calibration.js";
import { computeWeights } from "../tools/stacking.js";
import { WbppRunner } from "../wbpp.js";
import { Estimator } from "../util/estimates.js";

export type StageName = "plan" | "master_bias" | "master_dark" | "master_flat" | "calibrate" | "cosmetic" | "debayer" | "measure" | "select" | "register" | "lnorm" | "integrate" | "drizzle" | "wbpp" | "open_master" | "cleanup";
export const STAGES: StageName[] = ["plan", "master_bias", "master_dark", "master_flat", "calibrate", "cosmetic", "debayer", "measure", "select", "register", "lnorm", "integrate", "drizzle"];
export const WBPP_STAGES: StageName[] = ["plan", "wbpp", "open_master", "cleanup"];

export interface StageState {
  name: StageName;
  status: "pending" | "running" | "ok" | "skipped" | "error";
  job_id?: string;
  started_at?: string;
  finished_at?: string;
  elapsed_ms?: number;
  outputs?: string[];
  data?: unknown;
  note?: string;
  error?: { code: string; message: string; console_tail?: string };
}

export interface PipelineOptions {
  light_group_id: string;
  /** "wbpp" (default from config) drives PixInsight's WBPP in a separate instance; "native" runs our tool chain. */
  engine?: "wbpp" | "native";
  /** Extra WBPP automation parameters (engine wbpp). */
  wbpp_params?: Record<string, string | number | boolean>;
  /** Files excluded by blink review (applied to the light list). */
  exclude_files?: string[];
  allow_dark_scaling?: boolean;
  force?: boolean;
  skip_cosmetic?: boolean;
  skip_local_normalization?: boolean;
  drizzle?: boolean;
  drizzle_scale?: 1 | 2;
  fwhm_factor?: number;
  max_eccentricity?: number;
  min_stars?: number;
  rejection?: string;
  debayer_method?: string;
  /** Override masters instead of building from the scan. */
  master_dark?: string;
  master_flat?: string;
  master_bias?: string;
  rejection_warn_pct?: number;
  /** Use only the first N lights (quick smoke test of the whole chain). */
  max_frames?: number;
  /** Keep intermediates (default from config keepIntermediates). */
  keep_intermediates?: boolean;
}

export interface PipelineState {
  id: string;
  session_id: string;
  created_at: string;
  updated_at: string;
  status: "running" | "ok" | "error" | "aborted";
  options: PipelineOptions;
  plan?: CalibrationPlan;
  stages: StageState[];
  masters: { bias?: string; dark?: string; flat?: string };
  files: { lights: string[]; calibrated?: string[]; cosmetic?: string[]; debayered?: string[]; weighted?: string[]; registered?: string[]; drizzle?: string[]; lnorm?: string[]; master_light?: string; drizzle_master?: string; reference?: string };
  warnings: string[];
  master_view_id?: string;
  error?: string;
  work_dir?: string;
  cleanup?: { deleted_dirs: string[]; freed_bytes: number };
  engine: "wbpp" | "native";
  wbpp?: { id?: string; output_dir?: string; log?: string; master_candidates?: string[]; masters?: string[] };
  excluded_files?: string[];
}

export class PipelineRunner {
  private active = new Map<string, Promise<void>>();
  constructor(private ctx: AppContext) {}

  private statePath(id: string): string {
    return path.join(this.ctx.sessions.ensure().pipeline, `${id}.json`);
  }

  async load(id: string): Promise<PipelineState> {
    const s = await readJsonSafe<PipelineState>(this.statePath(id));
    if (!s) throw new BridgeError("PIPELINE_NOT_FOUND", `no pipeline ${id} in session ${this.ctx.sessions.ensure().id}`);
    return s;
  }

  list(): string[] {
    const dir = this.ctx.sessions.ensure().pipeline;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  }

  private async save(st: PipelineState): Promise<void> {
    st.updated_at = nowIso();
    await writeJsonAtomic(this.statePath(st.id), st);
  }

  /** Start (or resume) a pipeline; returns immediately. */
  async start(opts: PipelineOptions, resumeId?: string): Promise<PipelineState> {
    const scan = await readJsonSafe<ScanResult>(path.join(this.ctx.sessions.ensure().root, "scan.json"));
    if (!scan) throw new BridgeError("NO_SCAN", "run scan_frames first");
    let st: PipelineState;
    if (resumeId) {
      st = await this.load(resumeId);
      st.status = "running";
      st.error = undefined;
      for (const s of st.stages) {
        if (s.status === "running" || s.status === "error") s.status = "pending";
        if (s.status === "pending") s.error = undefined;
      }
    } else {
      const light = scan.groups.find((g) => g.id === opts.light_group_id);
      if (!light || light.type !== "light") throw new BridgeError("GROUP_NOT_FOUND", `light group ${opts.light_group_id} not in scan`);
      // Working files live next to the object (workLayout "target"): <light dir>/working-files
      if (this.ctx.cfg.workLayout === "target") {
        const work = this.ctx.sessions.useTargetDir(SessionManager.targetDirOf(light.dir), this.ctx.cfg.workingDirName);
        this.ctx.safety.allow(work);
      }
      const engine = opts.engine ?? this.ctx.cfg.stackingEngine;
      // Blink exclusions recorded by exclude_frames for this group
      const excl = await readJsonSafe<{ group_id?: string; excluded_files: string[] }>(path.join(this.ctx.sessions.ensure().root, "exclusions.json"));
      const excluded = new Set([...(opts.exclude_files ?? []), ...(excl && excl.group_id === light.id ? excl.excluded_files : [])].map((f) => path.resolve(f)));
      let lights = light.files.filter((f) => !excluded.has(path.resolve(f)));
      if (opts.max_frames) lights = lights.slice(0, opts.max_frames);
      st = {
        id: makeId("pipe"),
        engine,
        excluded_files: [...excluded],
        session_id: this.ctx.sessions.ensure().id,
        created_at: nowIso(),
        updated_at: nowIso(),
        status: "running",
        options: opts,
        stages: (engine === "wbpp" ? WBPP_STAGES : STAGES).map((name) => ({ name, status: "pending" as const })),
        masters: { dark: opts.master_dark, flat: opts.master_flat, bias: opts.master_bias },
        files: { lights },
        warnings: [],
        work_dir: this.ctx.sessions.ensure().work,
      };
    }
    await this.save(st);
    const p = (st.engine === "wbpp" ? this.executeWbpp(st, scan) : this.execute(st, scan)).catch(async (e) => {
      st.status = "error";
      st.error = (e as Error).message;
      await this.save(st);
    });
    this.active.set(st.id, p);
    return st;
  }

  private stage(st: PipelineState, name: StageName): StageState {
    return st.stages.find((s) => s.name === name) as StageState;
  }

  private async runStage<T>(st: PipelineState, name: StageName, fn: (s: StageState) => Promise<{ data?: T; outputs?: string[]; note?: string; skip?: boolean }>): Promise<T | undefined> {
    const s = this.stage(st, name);
    if (s.status === "ok" || s.status === "skipped") return s.data as T;
    s.status = "running";
    s.started_at = nowIso();
    await this.save(st);
    try {
      const r = await fn(s);
      s.error = undefined;
      s.status = r.skip ? "skipped" : "ok";
      s.data = r.data;
      s.outputs = r.outputs;
      s.note = r.note;
      s.finished_at = nowIso();
      s.elapsed_ms = Date.parse(s.finished_at) - Date.parse(s.started_at!);
      await this.save(st);
      return r.data;
    } catch (e) {
      const err = e as BridgeError;
      s.status = "error";
      s.finished_at = nowIso();
      s.error = { code: err.code ?? "ERROR", message: err.message, console_tail: (err.details as { console_tail?: string } | undefined)?.console_tail };
      st.status = "error";
      st.error = `${name}: ${err.message}`;
      await this.save(st);
      throw e;
    }
  }

  /** Delete an intermediate directory (only ever below the session work dir). */
  private async removeDir(st: PipelineState, dir: string | undefined): Promise<void> {
    if (!dir) return;
    const abs = path.resolve(dir);
    const work = path.resolve(this.ctx.sessions.ensure().work);
    if (!abs.startsWith(work) || abs === work) return; // never outside our own working directory
    if (!fs.existsSync(abs)) return;
    let bytes = 0;
    try {
      for (const f of fs.readdirSync(abs)) bytes += fs.statSync(path.join(abs, f)).size;
      fs.rmSync(abs, { recursive: true, force: true });
      st.cleanup = st.cleanup ?? { deleted_dirs: [], freed_bytes: 0 };
      st.cleanup.deleted_dirs.push(abs);
      st.cleanup.freed_bytes += bytes;
    } catch (e) {
      st.warnings.push(`cleanup of ${abs} failed: ${(e as Error).message}`);
    }
  }

  private keepIntermediates(st: PipelineState): boolean {
    return st.options.keep_intermediates ?? this.ctx.cfg.keepIntermediates;
  }

  /** Submit a PJSR job for a stage and wait for it, recording job_id for progress. */
  private async job(st: PipelineState, s: StageState, op: string, args: Record<string, unknown>, frames: number): Promise<JobResult> {
    const est = new Estimator(this.ctx.cfg.workdir);
    const j = await this.ctx.bridge.startJob(op, args, { long: true, timeoutMs: 12 * 3_600_000, sessionId: st.session_id, estimatedSeconds: est.estimate(op, frames) });
    s.job_id = j.id;
    await this.save(st);
    const r = await this.ctx.bridge.awaitJob(j.id, 12 * 3_600_000);
    if (r.status !== "ok") throw new BridgeError(r.error?.code ?? "FAILED", `${op} failed: ${r.error?.message ?? r.status}`, { console_tail: r.error?.console_tail, job_id: j.id });
    est.learn(op, frames, r.elapsed_ms ?? 0);
    return r;
  }

  /**
   * WBPP engine: plan → run PixInsight's WeightedBatchPreprocessing in a separate instance with exactly the
   * matched calibration groups → open the master light in the daemon → delete WBPP intermediates.
   */
  private async executeWbpp(st: PipelineState, scan: ScanResult): Promise<void> {
    const ctx = this.ctx;
    const o = st.options;
    const light = scan.groups.find((g) => g.id === o.light_group_id) as FrameGroup;
    const g = (id?: string) => (id ? scan.groups.find((x) => x.id === id) : undefined);

    const plan = await this.runStage(st, "plan", async () => {
      const p = buildPlan(light, scan.groups, { tolerances: ctx.cfg.tolerances, requireFlats: ctx.cfg.requireFlats, allowDarkScaling: o.allow_dark_scaling, force: o.force });
      st.plan = p;
      st.warnings.push(...p.warnings);
      if (p.blocking.length && !o.force) throw new BridgeError("PLAN_BLOCKED", p.blocking.join("; "));
      if (st.files.lights.length < 3 && !o.force) throw new BridgeError("TOO_FEW_FRAMES", `${st.files.lights.length} lights after exclusions`);
      return { data: p };
    });
    const P = (plan ?? st.plan)!;

    await this.runStage(st, "wbpp", async (s) => {
      const files = [...st.files.lights];
      const groups: string[] = [];
      for (const m of [P.dark.chosen, P.flat.chosen, P.flat_dark.chosen, P.bias.chosen]) {
        const grp = g(m?.group_id);
        if (grp && !groups.includes(grp.id)) {
          // bias only if the policy needs it (flat calibration or dark scaling)
          if (grp.type === "bias" && !P.policy.master_bias_enabled && P.policy.flat_calibration !== "bias") continue;
          groups.push(grp.id);
          files.push(...grp.files);
        }
      }
      const outDir = path.join(ctx.sessions.ensure().work, "wbpp");
      ctx.safety.assertWritable(outDir);
      const runner = new WbppRunner(ctx.cfg);
      const params = { ...ctx.cfg.wbppParams, ...(o.wbpp_params ?? {}) };
      const run = runner.start({ files, output_dir: outDir, params });
      st.wbpp = { id: run.id, output_dir: outDir };
      s.note = `WBPP pid ${run.pid}: ${st.files.lights.length} lights + groups ${groups.join(", ")}`;
      await this.save(st);
      const fin = await runner.wait(run.id, 12 * 3_600_000, (t) => {
        s.note = `WBPP running ${t.elapsed_s}s: ${WbppRunner.stageFromLog((t as { log_tail?: string }).log_tail) ?? "…"}`;
        void this.save(st);
      });
      st.wbpp.log = fin.log_file;
      st.wbpp.master_candidates = fin.master_light;
      st.wbpp.masters = fin.masters;
      if (fin.status !== "ok" || !fin.master_light?.length) throw new BridgeError("WBPP_FAILED", `WBPP produced no master light; log: ${fin.log_file ?? "none"}\n${(fin.log_tail ?? "").slice(-1500)}`);
      // Prefer the autocropped master (registration edges removed) when WBPP produced one.
      const pick = fin.master_light.find((f) => /_autocrop\.xisf$/i.test(f)) ?? fin.master_light[0];
      const masterDir = path.join(ctx.sessions.ensure().work, "master");
      fs.mkdirSync(masterDir, { recursive: true });
      const dest = path.join(masterDir, `master_light_${light.target?.replace(/[^A-Za-z0-9]+/g, "_") ?? "target"}_${st.files.lights.length}x${light.exptime ?? 0}s_wbpp.xisf`);
      fs.copyFileSync(pick, dest);
      st.files.master_light = dest;
      return { outputs: [dest], data: { wbpp_master: pick, all_master_lights: fin.master_light, masters: fin.masters, log: fin.log_file, elapsed_s: fin.elapsed_s } };
    });

    await this.runStage(st, "open_master", async () => {
      const r = await ctx.bridge.run<{ id: string }>("open_image", { path: piPath(st.files.master_light!), id: "master_light" }, { timeoutMs: 300_000 });
      st.master_view_id = r.id;
      return { data: r };
    });

    await this.runStage(st, "cleanup", async () => {
      if (this.keepIntermediates(st)) return { skip: true, note: "keep_intermediates" };
      const w = st.wbpp?.output_dir;
      if (w) for (const d of ["calibrated", "cosmetized", "debayered", "registered", "weighted", "lnorm", "fastIntegration"]) await this.removeDir(st, path.join(w, d));
      return { data: st.cleanup };
    });

    st.status = "ok";
    await this.save(st);
  }

  private async execute(st: PipelineState, scan: ScanResult): Promise<void> {
    const ctx = this.ctx;
    const o = st.options;
    const w = (p: string) => piPath(ctx.sessions.workPath(p));
    const light = scan.groups.find((g) => g.id === o.light_group_id) as FrameGroup;
    const g = (id?: string) => (id ? scan.groups.find((x) => x.id === id) : undefined);

    // 1. plan
    const plan = await this.runStage(st, "plan", async () => {
      const p = buildPlan(light, scan.groups, { tolerances: ctx.cfg.tolerances, requireFlats: ctx.cfg.requireFlats, allowDarkScaling: o.allow_dark_scaling, force: o.force });
      st.plan = p;
      st.warnings.push(...p.warnings);
      if (p.blocking.length && !o.force) throw new BridgeError("PLAN_BLOCKED", p.blocking.join("; "));
      return { data: p };
    });
    const P = (plan ?? st.plan)!;

    // 2. masters (skip when user supplied paths)
    await this.runStage(st, "master_bias", async () => {
      if (st.masters.bias) return { skip: true, note: "user-supplied", outputs: [st.masters.bias] };
      const need = P.policy.master_bias_enabled || P.policy.flat_calibration === "bias";
      const bg = g(P.bias.chosen?.group_id);
      if (!need || !bg) return { skip: true, note: need ? "no bias group" : "bias not needed (CMOS dark+flat policy)" };
      const r = (await buildMaster(ctx, "bias", bg.files, { wait: true })) as { path: string };
      st.masters.bias = r.path;
      return { data: r, outputs: [r.path] };
    });
    await this.runStage(st, "master_dark", async () => {
      if (st.masters.dark) return { skip: true, note: "user-supplied", outputs: [st.masters.dark] };
      const dg = g(P.dark.chosen?.group_id);
      if (!dg) return { skip: true, note: "no usable dark group" };
      const r = (await buildMaster(ctx, "dark", dg.files, { wait: true, master_bias: P.policy.calibrate_dark_with_bias ? st.masters.bias : undefined })) as { path: string };
      st.masters.dark = r.path;
      return { data: r, outputs: [r.path] };
    });
    await this.runStage(st, "master_flat", async () => {
      if (st.masters.flat) return { skip: true, note: "user-supplied", outputs: [st.masters.flat] };
      const fg = g(P.flat.chosen?.group_id);
      if (!fg) return { skip: true, note: "no flats" };
      let flatDark: string | undefined;
      if (P.policy.flat_calibration === "flat_dark") {
        const fdg = g(P.flat_dark.chosen?.group_id)!;
        flatDark = ((await buildMaster(ctx, "flatdark", fdg.files, { wait: true })) as { path: string }).path;
      }
      const r = (await buildMaster(ctx, "flat", fg.files, { wait: true, master_flat_dark: flatDark, master_bias: P.policy.flat_calibration === "bias" ? st.masters.bias : undefined })) as { path: string };
      st.masters.flat = r.path;
      return { data: r, outputs: [r.path] };
    });

    // 3. calibrate
    await this.runStage(st, "calibrate", async (s) => {
      if (!st.masters.dark && !st.masters.flat && !st.masters.bias) {
        st.files.calibrated = st.files.lights;
        st.warnings.push("no masters at all: lights used uncalibrated");
        return { skip: true, note: "nothing to calibrate with", outputs: st.files.lights };
      }
      const r = await this.job(st, s, "calibrate_lights", { files: st.files.lights.map(piPath), out_dir: w("calibrated"), master_dark: st.masters.dark ? piPath(st.masters.dark) : undefined, master_flat: st.masters.flat ? piPath(st.masters.flat) : undefined, master_bias: P.policy.master_bias_enabled && st.masters.bias ? piPath(st.masters.bias) : undefined, optimize_darks: P.policy.optimize_darks, calibrate_dark: false, cfa: true }, st.files.lights.length);
      const d = r.data as { outputs: string[] };
      st.files.calibrated = d.outputs;
      return { outputs: d.outputs, data: { masters: st.masters, policy: P.policy.mode } };
    });

    // 4. cosmetic (CFA)
    await this.runStage(st, "cosmetic", async (s) => {
      if (o.skip_cosmetic) {
        st.files.cosmetic = st.files.calibrated;
        return { skip: true, note: "skipped by option" };
      }
      const r = await this.job(st, s, "cosmetic_correction", { files: st.files.calibrated!.map(piPath), out_dir: w("cosmetic"), master_dark: st.masters.dark ? piPath(st.masters.dark) : undefined, auto_detect: true, hot_sigma: 3.0, cfa: true }, st.files.calibrated!.length);
      st.files.cosmetic = (r.data as { outputs: string[] }).outputs;
      if (!this.keepIntermediates(st) && st.files.calibrated !== st.files.lights) await this.removeDir(st, path.dirname(st.files.calibrated![0]));
      return { outputs: st.files.cosmetic };
    });

    // 5. debayer
    await this.runStage(st, "debayer", async (s) => {
      const r = await this.job(st, s, "debayer", { files: st.files.cosmetic!.map(piPath), out_dir: w("debayered"), pattern: "Auto", method: o.debayer_method ?? "VNG" }, st.files.cosmetic!.length);
      st.files.debayered = (r.data as { outputs: string[] }).outputs;
      if (!this.keepIntermediates(st) && !o.skip_cosmetic) await this.removeDir(st, path.dirname(st.files.cosmetic![0]));
      return { outputs: st.files.debayered };
    });

    // 6. measure + 7. select
    const scale = Number(((206.265 * ctx.cfg.rig.pixelSizeUm) / ctx.cfg.rig.focalLengthMm).toFixed(4));
    const meas = await this.runStage<{ measurements: Array<Record<string, number | string | boolean>>; approval_expression: string; weighting_expression: string }>(st, "measure", async (s) => {
      const r = await this.job(st, s, "measure_subframes", { files: st.files.debayered!.map(piPath), camera_gain: ctx.cfg.rig.cameraGainEPerAdu }, st.files.debayered!.length);
      const d = r.data as { measurements: Array<Record<string, number | string | boolean>>; approval_expression: string; weighting_expression: string };
      await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "measurements.json"), { files: st.files.debayered, ...d, pixel_scale: scale });
      return { data: d };
    });
    await this.runStage(st, "select", async () => {
      const ms = (meas ?? (this.stage(st, "measure").data as typeof meas))!.measurements as Array<{ index: number; path: string; weight: number; fwhm: number; eccentricity: number; stars: number; psf_signal_weight: number; snr_weight: number; median: number; noise: number }>;
      const fw = ms.map((m) => m.fwhm).sort((a, b) => a - b);
      const med = fw.length % 2 ? fw[(fw.length - 1) / 2] : (fw[fw.length / 2 - 1] + fw[fw.length / 2]) / 2;
      const maxF = med * (o.fwhm_factor ?? 1.25);
      const maxE = o.max_eccentricity ?? 0.6;
      let keep = ms.filter((m) => !(m.fwhm > maxF || m.eccentricity > maxE || (o.min_stars !== undefined && m.stars < o.min_stars)));
      if (keep.length < 3) {
        st.warnings.push(`selection would keep only ${keep.length} frames; keeping all instead`);
        keep = ms;
      }
      const weights = computeWeights(keep);
      const items = keep.map((m, i) => ({ input: piPath(m.path), output: piPath(path.join(ctx.sessions.workPath("weighted"), path.basename(m.path).replace(/\.xisf$/i, "") + "_a.xisf")), weight: weights[i] }));
      const r = await ctx.bridge.run<{ outputs: Array<{ input: string; output: string; weight: number }> }>("write_weights", { items }, { timeoutMs: 3_600_000 });
      st.files.weighted = r.outputs.map((x) => x.output);
      const best = [...r.outputs].sort((a, b) => b.weight - a.weight)[0];
      st.files.reference = best?.output;
      const approved = r.outputs.length;
      const rejected = ms.filter((m) => !keep.includes(m)).map((m) => ({ file: path.basename(m.path), fwhm: m.fwhm, ecc: m.eccentricity, stars: m.stars }));
      await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "selection.json"), { approved: r.outputs, rejected, best_reference: st.files.reference });
      if (!this.keepIntermediates(st)) await this.removeDir(st, path.dirname(st.files.debayered![0]));
      return { outputs: st.files.weighted, data: { approved, rejected, fwhm_median: med, max_fwhm: maxF, reference: st.files.reference } };
    });

    // 8. register
    await this.runStage(st, "register", async (s) => {
      const r = await this.job(st, s, "register", { files: st.files.weighted!.map(piPath), reference: piPath(st.files.reference!), out_dir: w("registered"), generate_drizzle: true }, st.files.weighted!.length);
      const d = r.data as { outputs: string[]; failed: unknown[]; drizzle_files: string[]; per_frame: Array<{ input: string; output: string }> };
      st.files.registered = d.outputs;
      st.files.drizzle = d.drizzle_files;
      const refOut = d.per_frame.find((p) => p.input === st.files.reference)?.output;
      if (refOut) st.files.reference = refOut;
      if (d.failed.length) st.warnings.push(`${d.failed.length} frame(s) failed registration`);
      await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "registration.json"), { reference: st.files.reference, ...d });
      if (!this.keepIntermediates(st)) await this.removeDir(st, path.dirname(st.files.weighted![0]));
      return { outputs: d.outputs, data: { failed: d.failed } };
    });

    // 9. local normalization
    await this.runStage(st, "lnorm", async (s) => {
      if (o.skip_local_normalization) return { skip: true, note: "skipped by option" };
      const r = await this.job(st, s, "local_normalization", { files: st.files.registered!.map(piPath), reference: piPath(st.files.reference!), scale: 256, out_dir: w("lnorm") }, st.files.registered!.length);
      const d = r.data as { outputs: Array<{ input: string; xnml: string }> };
      st.files.lnorm = st.files.registered!.map((f) => d.outputs.find((x) => x.input === f)?.xnml ?? "");
      await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "lnorm.json"), d);
      return { outputs: st.files.lnorm };
    });

    // 10. integrate
    await this.runStage(st, "integrate", async (s) => {
      const n = st.files.registered!.length;
      const out = ctx.sessions.workPath("master", `master_light_${light.target?.replace(/[^A-Za-z0-9]+/g, "_") ?? "target"}_${n}x${light.exptime ?? 0}s.xisf`);
      const rejection = o.rejection ?? pickRejection(n);
      const r = await this.job(st, s, "integrate", { files: st.files.registered!.map(piPath), out: piPath(out), rejection, weights: "SSWEIGHT", lnorm_files: st.files.lnorm?.map((f) => (f ? piPath(f) : "")), drizzle_files: st.files.drizzle?.map(piPath), keep_open: true, keep_rejection_maps: true, force: o.force }, n);
      const d = r.data as { path: string; view_id: string | null; stats: { rejected_total_pct?: number } };
      st.files.master_light = d.path;
      st.master_view_id = d.view_id ?? undefined;
      const pct = d.stats?.rejected_total_pct ?? 0;
      if (pct > (o.rejection_warn_pct ?? 5)) st.warnings.push(`high rejected-pixel percentage ${pct}% — check for satellite trails, clouds or a bad frame`);
      if (!this.keepIntermediates(st) && !o.drizzle) {
        await this.removeDir(st, path.dirname(st.files.registered![0]));
        if (st.files.lnorm?.[0]) await this.removeDir(st, path.dirname(st.files.lnorm[0]));
      }
      return { outputs: [d.path], data: d };
    });

    // 11. drizzle (optional)
    await this.runStage(st, "drizzle", async (s) => {
      if (!o.drizzle) return { skip: true, note: "not requested" };
      const out = ctx.sessions.workPath("master", `master_light_drizzle${o.drizzle_scale ?? 2}x.xisf`);
      const r = await this.job(st, s, "drizzle_integrate", { xdrz_files: st.files.drizzle!.map(piPath), out: piPath(out), scale: o.drizzle_scale ?? 2, lnorm_files: st.files.lnorm?.map((f) => (f ? piPath(f) : "")), keep_open: false }, st.files.drizzle!.length);
      st.files.drizzle_master = (r.data as { path: string }).path;
      if (!this.keepIntermediates(st)) {
        await this.removeDir(st, path.dirname(st.files.registered![0]));
        if (st.files.lnorm?.[0]) await this.removeDir(st, path.dirname(st.files.lnorm[0]));
      }
      return { outputs: [st.files.drizzle_master] };
    });

    st.status = "ok";
    await this.save(st);
  }

  /** Status with live job progress for the running stage. */
  async status(id: string): Promise<Record<string, unknown>> {
    const st = await this.load(id);
    const running = st.stages.find((s) => s.status === "running");
    let progress: unknown;
    if (running?.job_id) {
      const r = await this.ctx.bridge.refresh(running.job_id).catch(() => undefined);
      progress = r ? { job_status: r.status, ...r.progress, elapsed_s: r.started_at ? Math.round((Date.now() - Date.parse(r.started_at)) / 1000) : undefined } : undefined;
    }
    const done = st.stages.filter((s) => s.status === "ok" || s.status === "skipped").length;
    return {
      id: st.id,
      engine: st.engine,
      excluded_frames: st.excluded_files?.length ?? 0,
      status: st.status,
      error: st.error,
      stage: running?.name ?? (st.status === "ok" ? "done" : st.stages.find((s) => s.status === "error")?.name),
      stages_done: `${done}/${st.stages.length}`,
      progress,
      stages: st.stages.map((s) => ({ name: s.name, status: s.status, elapsed_s: s.elapsed_ms ? Math.round(s.elapsed_ms / 1000) : (s.status === "running" && s.started_at ? Math.round((Date.now() - Date.parse(s.started_at)) / 1000) : undefined), note: s.note, outputs: s.outputs?.length, error: s.error?.message })),
      wbpp: st.wbpp ? { output_dir: st.wbpp.output_dir, log: st.wbpp.log, masters: st.wbpp.masters } : undefined,
      masters: st.masters,
      master_light: st.files.master_light,
      master_view_id: st.master_view_id,
      drizzle_master: st.files.drizzle_master,
      reference: st.files.reference,
      warnings: st.warnings,
      work_dir: st.work_dir,
      cleanup: st.cleanup ? { deleted_dirs: st.cleanup.deleted_dirs.length, freed_gb: Number((st.cleanup.freed_bytes / 1e9).toFixed(2)) } : undefined,
      plan_policy: st.plan?.policy,
      integration_stats: (this.stage(st, "integrate")?.data as { stats?: unknown } | undefined)?.stats,
    };
  }
}
