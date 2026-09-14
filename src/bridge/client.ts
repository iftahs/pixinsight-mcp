import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { workdirLayout } from "../config.js";
import { Launcher } from "./launcher.js";
import { parseProgressFromLog } from "./logtail.js";
import { BridgeError, type JobProgress, type JobRequest, type JobResult } from "./types.js";
import { ensureDirSync, makeId, nowIso, readJsonSafe, sleep, tailFile, writeJsonAtomic } from "../util/fsx.js";

export interface TrackedJob {
  id: string;
  op: string;
  args: Record<string, unknown>;
  session_id?: string;
  created_at: string;
  timeout_ms: number;
  /** Long-running (async) job: sync tools refuse to queue behind it. */
  long: boolean;
  estimated_seconds?: number;
  log_path: string;
  last?: JobResult;
  cancel_requested?: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  sessionId?: string;
  /** Mark as long-running (async). */
  long?: boolean;
  estimatedSeconds?: number;
}

const DEFAULT_SYNC_TIMEOUT = 120_000;

/**
 * Node side of the filesystem bridge. Single instance per server.
 * Jobs are written atomically to bridge/jobs, results read from bridge/results.
 */
export class BridgeClient {
  readonly launcher: Launcher;
  private layout;
  private jobs = new Map<string, TrackedJob>();

  constructor(private cfg: Config) {
    this.layout = workdirLayout(cfg.workdir);
    this.launcher = new Launcher(cfg);
    ensureDirSync(this.layout.bridgeJobs);
    ensureDirSync(this.layout.bridgeResults);
    ensureDirSync(this.layout.bridgeLogs);
  }

  get config(): Config {
    return this.cfg;
  }

  listJobs(): TrackedJob[] {
    return [...this.jobs.values()];
  }

  getJob(id: string): TrackedJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Busy check that also works across server processes: the daemon heartbeat carries the job it is
   * executing, so a second MCP server (or a restarted one) sees the pipeline another process started.
   */
  async assertIdle(op: string): Promise<void> {
    const active = this.activeLongJob();
    if (active) {
      const r = await this.refresh(active.id);
      if (r.status === "running" || r.status === "queued") throw new BridgeError("PI_BUSY", `PixInsight is busy with ${active.op} (job ${active.id}, ${r.status}). Poll job_status / job_wait, or job_cancel it, before running ${op}.`, { job_id: active.id });
    }
    const st = await this.launcher.status();
    const busy = st.heartbeat?.busy;
    if (busy && st.pid_alive && !this.jobs.has(busy.job_id)) {
      // Started by another process; trust the heartbeat unless its result file says it finished.
      const r = await readJsonSafe<JobResult>(this.resultPath(busy.job_id));
      if (!r || r.status === "running") throw new BridgeError("PI_BUSY", `PixInsight is busy with ${busy.op} (job ${busy.job_id}, started ${busy.since} by another server process). Wait for it (job_status works across processes) before running ${op}.`, { job_id: busy.job_id });
    }
  }

  /** The currently running / queued long job, if any. */
  activeLongJob(): TrackedJob | undefined {
    for (const j of this.jobs.values()) {
      const s = j.last?.status;
      if (j.long && (s === undefined || s === "queued" || s === "running")) return j;
    }
    return undefined;
  }

  private resultPath(id: string): string {
    return path.join(this.layout.bridgeResults, `${id}.json`);
  }

  /** Submit a job. Returns immediately. */
  async startJob(op: string, args: Record<string, unknown>, opts: RunOptions = {}): Promise<TrackedJob> {
    await this.launcher.ensureAlive();
    if (opts.long) await this.assertIdle(op);
    const id = makeId("job");
    const logPath = path.join(this.layout.bridgeLogs, `${id}.log`);
    const req: JobRequest = {
      id,
      op,
      args,
      session_id: opts.sessionId,
      timeout_ms: opts.timeoutMs ?? DEFAULT_SYNC_TIMEOUT,
      created_at: nowIso(),
      log_path: logPath.replace(/\\/g, "/"),
    };
    const tracked: TrackedJob = {
      id,
      op,
      args,
      session_id: opts.sessionId,
      created_at: req.created_at,
      timeout_ms: req.timeout_ms,
      long: !!opts.long,
      estimated_seconds: opts.estimatedSeconds,
      log_path: logPath,
      last: { id, op, status: "queued" },
    };
    this.jobs.set(id, tracked);
    await writeJsonAtomic(path.join(this.layout.bridgeJobs, `${id}.json`), req);
    return tracked;
  }

  /** Refresh a job's status from the results dir and log tail. */
  async refresh(id: string): Promise<JobResult> {
    const t = this.jobs.get(id);
    if (!t) {
      const r = await readJsonSafe<JobResult>(this.resultPath(id));
      if (r) {
        if (r.status === "running") {
          const tail = await tailFile(path.join(this.layout.bridgeLogs, `${id}.log`), 16_384);
          const p = parseProgressFromLog(tail, r.progress);
          if (p) r.progress = { ...r.progress, ...p };
        }
        return r;
      }
      throw new BridgeError("JOB_NOT_FOUND", `Unknown job ${id}`);
    }
    const r = await readJsonSafe<JobResult>(this.resultPath(id));
    if (r) {
      // Merge log-derived progress while running.
      if (r.status === "running") {
        const tail = await tailFile(t.log_path, 16_384);
        const p = parseProgressFromLog(tail, r.progress);
        if (p) r.progress = { ...r.progress, ...p };
        if (r.started_at) {
          r.elapsed_ms = Date.now() - Date.parse(r.started_at);
          if (r.progress?.percent && r.progress.percent > 0 && r.progress.percent < 100) {
            r.progress.eta_seconds = Math.round((r.elapsed_ms / r.progress.percent) * (100 - r.progress.percent) / 1000);
          }
        }
      }
      t.last = r;
      return r;
    }
    // No result yet: still queued. Detect dead daemon.
    const st = await this.launcher.status();
    if (!st.alive) {
      const dead: JobResult = { id, op: t.op, status: "error", error: { code: "DAEMON_DEAD", message: `PixInsight daemon died before/while running job (${st.reason})` } };
      t.last = dead;
      return dead;
    }
    return t.last ?? { id, op: t.op, status: "queued" };
  }

  /** Wait for a job to finish (or timeout). */
  async awaitJob(id: string, timeoutMs: number): Promise<JobResult> {
    const t = this.jobs.get(id);
    const deadline = Date.now() + timeoutMs;
    let interval = 150;
    while (true) {
      const r = await this.refresh(id);
      if (r.status === "ok" || r.status === "error" || r.status === "cancelled") return r;
      if (Date.now() > deadline) {
        throw new BridgeError("JOB_TIMEOUT", `Job ${id} (${t?.op ?? "?"}) did not finish within ${timeoutMs} ms; it is still ${r.status}. Poll job_status.`, { job_id: id });
      }
      await sleep(interval);
      interval = Math.min(1000, interval + 50);
    }
  }

  /**
   * Run a synchronous op and return its data. Refuses if a long job is active
   * (the daemon is single-threaded; queuing behind a 40-minute integration is not useful).
   */
  async run<T = unknown>(op: string, args: Record<string, unknown>, opts: RunOptions = {}): Promise<T> {
    await this.assertIdle(op);
    const timeout = opts.timeoutMs ?? DEFAULT_SYNC_TIMEOUT;
    const job = await this.startJob(op, args, { ...opts, timeoutMs: timeout });
    const r = await this.awaitJob(job.id, timeout + 5_000);
    if (r.status !== "ok") {
      throw new BridgeError(r.error?.code ?? "PI_OP_FAILED", `${op} failed: ${r.error?.message ?? r.status}`, {
        job_id: job.id,
        console_tail: r.error?.console_tail ?? r.console_tail,
      });
    }
    return r.data as T;
  }

  /**
   * Run an op but give up waiting after `deferAfterMs`: the job keeps running in PixInsight and the
   * caller gets { deferred: true, job_id } to poll with job_wait. Avoids MCP client timeouts on
   * plate solving, SPCC, deconvolution, etc.
   */
  async runOrDefer<T = unknown>(op: string, args: Record<string, unknown>, opts: RunOptions & { deferAfterMs?: number } = {}): Promise<T | { deferred: true; job_id: string; op: string; note: string; progress?: JobProgress }> {
    await this.assertIdle(op);
    const timeout = opts.timeoutMs ?? 3_600_000;
    const job = await this.startJob(op, args, { ...opts, timeoutMs: timeout, long: true });
    try {
      const r = await this.awaitJob(job.id, opts.deferAfterMs ?? 45_000);
      if (r.status !== "ok") throw new BridgeError(r.error?.code ?? "PI_OP_FAILED", `${op} failed: ${r.error?.message ?? r.status}`, { job_id: job.id, console_tail: r.error?.console_tail ?? r.console_tail });
      return r.data as T;
    } catch (e) {
      if ((e as BridgeError).code === "JOB_TIMEOUT") {
        const r = await this.refresh(job.id);
        return { deferred: true, job_id: job.id, op, progress: r.progress, note: `${op} is still running in PixInsight; call job_wait { job_id } until status is ok, then read data` };
      }
      throw e;
    }
  }

  /** Request cancellation: daemon honours it at the next frame boundary of per-frame ops. */
  async cancel(id: string): Promise<{ requested: boolean; note: string }> {
    const t = this.jobs.get(id);
    if (!t) throw new BridgeError("JOB_NOT_FOUND", `Unknown job ${id}`);
    const r = await this.refresh(id);
    if (r.status !== "running" && r.status !== "queued") return { requested: false, note: `job already ${r.status}` };
    // Queued: remove request file if the daemon has not claimed it yet.
    const reqFile = path.join(this.layout.bridgeJobs, `${id}.json`);
    if (fs.existsSync(reqFile)) {
      try {
        await fsp.unlink(reqFile);
        t.last = { id, op: t.op, status: "cancelled", finished_at: nowIso() };
        await writeJsonAtomic(this.resultPath(id), t.last);
        return { requested: true, note: "removed from queue before execution" };
      } catch {
        /* claimed meanwhile */
      }
    }
    await fsp.writeFile(path.join(this.layout.bridgeJobs, `${id}.cancel`), nowIso(), "utf8");
    t.cancel_requested = true;
    return { requested: true, note: "cancel flag written; per-frame operations stop at the next frame. A single blocking process (e.g. ImageIntegration) cannot be interrupted except by pi_stop(mode: 'kill')." };
  }

  async logTail(id: string, lines = 80): Promise<string> {
    const t = this.jobs.get(id);
    const p = t?.log_path ?? path.join(this.layout.bridgeLogs, `${id}.log`);
    const txt = await tailFile(p, 64_000);
    const arr = txt.split(/\r?\n/).filter((l) => l.length > 0);
    return arr.slice(-lines).join("\n");
  }

  progressOf(r: JobResult): JobProgress | undefined {
    return r.progress;
  }

  /** Ask the daemon to stop polling (PixInsight stays open) or kill the app. */
  async stop(mode: "daemon" | "kill"): Promise<Record<string, unknown>> {
    if (mode === "kill") return this.launcher.kill();
    const st = await this.launcher.status();
    if (!st.alive) return { stopped: false, reason: st.reason };
    const id = makeId("job");
    await writeJsonAtomic(path.join(this.layout.bridgeJobs, `${id}.json`), {
      id,
      op: "stop",
      args: {},
      timeout_ms: 5000,
      created_at: nowIso(),
      log_path: path.join(this.layout.bridgeLogs, `${id}.log`).replace(/\\/g, "/"),
    } satisfies JobRequest);
    await sleep(1500);
    return { stopped: true, note: "daemon loop exited; PixInsight window left open. Use pi_stop(mode:'kill') to close the application." };
  }
}
