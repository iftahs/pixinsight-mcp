import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool } from "./registry.js";
import { parseRejectionSummary } from "../bridge/logtail.js";
import { tailFile } from "../util/fsx.js";
import path from "node:path";
import fsp from "node:fs/promises";

export function registerJobTools(server: McpServer, ctx: AppContext): void {
  defineTool(server, {
    name: "job_status",
    description: "Status, progress (current/total, percent, ETA) and result of an async job. Poll every 10–30 s for long jobs, or use job_wait.",
    input: { job_id: z.string() },
    readOnly: true,
    handler: async ({ job_id }) => {
      const r = await ctx.bridge.refresh(job_id);
      const t = ctx.bridge.getJob(job_id);
      const elapsed_s = r.started_at ? Math.round((Date.now() - Date.parse(r.started_at)) / 1000) : undefined;
      let hint: string | undefined;
      if (r.status === "running" && elapsed_s !== undefined) {
        // A job whose console log stopped growing for a long time is usually a modal dialog in PixInsight.
        const logPath = t?.log_path ?? path.join(ctx.cfg.workdir, "bridge", "logs", `${job_id}.log`);
        const mtime = await fsp.stat(logPath).then((s) => s.mtimeMs).catch(() => undefined);
        const idle = mtime ? Math.round((Date.now() - mtime) / 1000) : undefined;
        if (idle !== undefined && idle > 90 && !/integrat|drizzle|wbpp|normaliz|register/i.test(t?.op ?? "")) hint = `console silent for ${idle} s: PixInsight may be showing a modal dialog (look at the screen / ask the user to click it), or the process is genuinely slow`;
      }
      return { ...r, estimated_seconds: t?.estimated_seconds, elapsed_s, hint, data: r.status === "ok" ? r.data : undefined, console_tail: r.status === "error" ? r.error?.console_tail : undefined };
    },
  });

  defineTool(server, {
    name: "job_wait",
    description: "Block up to max_seconds (≤ 300) for a job to finish; returns the final result or the latest progress. Prefer this over tight job_status polling.",
    input: { job_id: z.string(), max_seconds: z.number().int().min(1).max(300).default(60) },
    readOnly: true,
    handler: async ({ job_id, max_seconds }) => {
      try {
        const r = await ctx.bridge.awaitJob(job_id, max_seconds * 1000);
        return r;
      } catch (e) {
        if ((e as { code?: string }).code === "JOB_TIMEOUT") return { ...(await ctx.bridge.refresh(job_id)), note: `still running after ${max_seconds}s; call job_wait again` };
        throw e;
      }
    },
  });

  defineTool(server, {
    name: "job_log",
    description: "Tail of the PixInsight console log for a job (streams live while running). Also extracts ImageIntegration rejection lines when present.",
    input: { job_id: z.string(), tail: z.number().int().min(1).max(1000).default(80) },
    readOnly: true,
    handler: async ({ job_id, tail }) => {
      const t = ctx.bridge.getJob(job_id);
      const log = await ctx.bridge.logTail(job_id, tail);
      const full = t ? await tailFile(t.log_path, 512_000) : "";
      const rej = parseRejectionSummary(full);
      return { job_id, log, rejection: rej.lines.length ? rej : undefined };
    },
  });

  defineTool(server, {
    name: "job_cancel",
    description: "Request cancellation. Per-frame operations (calibrate, register, cosmetic, debayer, normalize) stop at the next frame; a running ImageIntegration cannot be interrupted (use pi_stop mode:'kill').",
    input: { job_id: z.string() },
    destructive: true,
    handler: async ({ job_id }) => ctx.bridge.cancel(job_id),
  });

  defineTool(server, {
    name: "list_jobs",
    description: "List jobs submitted by this server process (id, op, status, progress).",
    input: { active_only: z.boolean().optional() },
    readOnly: true,
    handler: async ({ active_only }) => {
      const out = [];
      for (const j of ctx.bridge.listJobs()) {
        const r = await ctx.bridge.refresh(j.id);
        if (active_only && !(r.status === "running" || r.status === "queued")) continue;
        out.push({ id: j.id, op: j.op, status: r.status, progress: r.progress, created_at: j.created_at, long: j.long, session_id: j.session_id, elapsed_ms: r.elapsed_ms });
      }
      return { jobs: out };
    },
  });
}
