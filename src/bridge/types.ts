export type JobStatus = "queued" | "running" | "ok" | "error" | "cancelled";

export interface JobProgress {
  step?: string;
  current?: number;
  total?: number;
  message?: string;
  /** Percent 0..100 when derivable. */
  percent?: number;
  eta_seconds?: number;
}

export interface JobRequest {
  id: string;
  op: string;
  args: Record<string, unknown>;
  session_id?: string;
  timeout_ms: number;
  created_at: string;
  /** Where the daemon writes the console log for this job. */
  log_path: string;
}

export interface JobError {
  code: string;
  message: string;
  console_tail?: string;
  stack?: string;
}

export interface JobResult<T = unknown> {
  id: string;
  op?: string;
  status: JobStatus;
  progress?: JobProgress;
  data?: T;
  error?: JobError;
  console_tail?: string;
  started_at?: string;
  finished_at?: string;
  elapsed_ms?: number;
}

export interface Heartbeat {
  ts: string;
  pid: number;
  pi_version: string;
  busy?: { job_id: string; op: string; since: string } | null;
  uptime_s?: number;
  jobs_done?: number;
}

export interface DaemonInfo {
  pid: number;
  started_at: string;
  exe: string;
  args: string[];
  bridge_dir: string;
  launched_by: "pixinsight-mcp" | "external";
}

export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
