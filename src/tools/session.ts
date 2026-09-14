import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool } from "./registry.js";
import { BridgeError } from "../bridge/types.js";

export function registerSessionTools(server: McpServer, ctx: AppContext): void {
  defineTool(server, {
    name: "pi_status",
    description:
      "Daemon/PixInsight liveness, version, installed optional modules (BXT/NXT/SXT…), open windows, current session, active job. Call first. Does not launch PixInsight unless launch:true.",
    input: { launch: z.boolean().optional().describe("Launch PixInsight if not running (default false)") },
    readOnly: true,
    handler: async ({ launch }) => {
      const st = await ctx.bridge.launcher.status();
      const session = ctx.sessions.get();
      const base = {
        daemon_alive: st.alive,
        daemon_reason: st.reason,
        pid: st.pid,
        heartbeat_age_ms: st.heartbeat_age_ms,
        pi_version: st.heartbeat?.pi_version,
        busy: st.heartbeat?.busy ?? null,
        jobs_done: st.heartbeat?.jobs_done,
        config: { pi_exe: ctx.cfg.piExe, workdir: ctx.cfg.workdir, data_root: ctx.cfg.dataRoot ?? null, require_flats: ctx.cfg.requireFlats, allow_raw_scripts: ctx.cfg.allowRawScripts, auto_launch: ctx.cfg.autoLaunch, config_source: ctx.cfg.configSource },
        session: session ? { id: session.id, name: session.name, work: session.work } : null,
        active_job: ctx.bridge.activeLongJob() ? { id: ctx.bridge.activeLongJob()!.id, op: ctx.bridge.activeLongJob()!.op } : null,
      };
      if (!st.alive && !launch) return { ...base, hint: "PixInsight will auto-launch on the first tool that needs it (or call pi_status with launch:true)." };
      if (!st.alive && launch) {
        await ctx.bridge.launcher.ensureAlive();
        const st2 = await ctx.bridge.launcher.status();
        Object.assign(base, { daemon_alive: st2.alive, daemon_reason: st2.reason, pid: st2.pid, heartbeat_age_ms: st2.heartbeat_age_ms, pi_version: st2.heartbeat?.pi_version });
      }
      if (ctx.bridge.activeLongJob()) return base;
      try {
        const caps = await ctx.bridge.run<Record<string, unknown>>("capabilities", {}, { timeoutMs: 30_000 });
        const wins = await ctx.bridge.run<{ windows: unknown[] }>("list_windows", {}, { timeoutMs: 30_000 });
        return { ...base, daemon_alive: true, capabilities: caps, open_windows: wins.windows };
      } catch (e) {
        return { ...base, capabilities_error: (e as Error).message };
      }
    },
  });

  defineTool(server, {
    name: "pi_capabilities",
    description: "Which optional processes/scripts exist in this PixInsight (BlurXTerminator, NoiseXTerminator, StarXTerminator, StarNet, GraXpert, WBPP, ImageSolver, SPCC…). Tools fall back automatically when something is missing.",
    input: {},
    readOnly: true,
    handler: async () => ctx.bridge.run("capabilities", {}, { timeoutMs: 30_000 }),
  });

  defineTool(server, {
    name: "pi_start_session",
    description: "Create a new processing session (an output namespace under the workdir: work/, previews/, checkpoints/). Sessions persist across server restarts; the latest is current.",
    input: { name: z.string().optional().describe("Human label, e.g. target name") },
    handler: async ({ name }) => {
      const s = ctx.sessions.start(name);
      return { session: s };
    },
  });

  defineTool(server, {
    name: "pi_list_sessions",
    description: "List sessions in the workdir and which is current.",
    input: {},
    readOnly: true,
    handler: async () => ({ current: ctx.sessions.get()?.id ?? null, sessions: ctx.sessions.list().map((s) => ({ id: s.id, name: s.name, created_at: s.created_at, root: s.root })) }),
  });

  defineTool(server, {
    name: "pi_use_session",
    description: "Switch the current session to an existing one (resume work).",
    input: { id: z.string() },
    handler: async ({ id }) => {
      const s = ctx.sessions.use(id);
      for (const r of s.scanned_roots) ctx.safety.protect(r);
      return { session: s };
    },
  });

  defineTool(server, {
    name: "pi_end_session",
    description: "End the current session; optionally close all image windows in PixInsight.",
    input: { close_windows: z.boolean().optional() },
    handler: async ({ close_windows }) => {
      let closed: unknown = null;
      if (close_windows) closed = await ctx.bridge.run("close_all", {}, { timeoutMs: 60_000 }).catch((e) => ({ error: (e as Error).message }));
      const s = ctx.sessions.end();
      return { ended: s?.id ?? null, closed };
    },
  });

  defineTool(server, {
    name: "pi_console_log",
    description: "Tail of the PixInsight console output captured for the most recent (or given) job.",
    input: { job_id: z.string().optional(), lines: z.number().int().min(1).max(2000).optional() },
    readOnly: true,
    handler: async ({ job_id, lines }) => {
      const jobs = ctx.bridge.listJobs();
      const id = job_id ?? jobs[jobs.length - 1]?.id;
      if (!id) return { log: "", note: "no jobs yet" };
      return { job_id: id, log: await ctx.bridge.logTail(id, lines ?? 80) };
    },
  });

  defineTool(server, {
    name: "pi_run_pjsr",
    description:
      "Escape hatch: run arbitrary PJSR (PixInsight JavaScript) inside the warm PixInsight instance. Assign `result = ...` to return JSON. Helpers: PIMCP.win.view(id), PIMCP.stf, PIMCP.preview.render(view,{out_path}). Gated by config allowRawScripts.",
    input: { script: z.string(), timeout_ms: z.number().int().optional(), script_args: z.record(z.unknown()).optional() },
    handler: async ({ script, timeout_ms, script_args }) => {
      if (!ctx.cfg.allowRawScripts) throw new BridgeError("RAW_SCRIPTS_DISABLED", "pi_run_pjsr is disabled (allowRawScripts=false)");
      return ctx.bridge.run("run_pjsr", { script, script_args }, { timeoutMs: timeout_ms ?? 120_000 });
    },
  });

  defineTool(server, {
    name: "pi_restart",
    description: "Kill PixInsight and relaunch the daemon (picks up daemon code changes; open windows are lost).",
    input: {},
    destructive: true,
    handler: async () => {
      const k = await ctx.bridge.launcher.kill();
      await new Promise((r) => setTimeout(r, 1500));
      const info = await ctx.bridge.launcher.launch();
      return { killed: k, launched: { pid: info.pid, args: info.args } };
    },
  });

  defineTool(server, {
    name: "pi_stop",
    description: "Stop the daemon loop (PixInsight stays open) or kill the PixInsight process (mode:'kill' — loses unsaved windows; the only way to abort a running ImageIntegration).",
    input: { mode: z.enum(["daemon", "kill"]).default("daemon") },
    destructive: true,
    handler: async ({ mode }) => ctx.bridge.stop(mode),
  });
}
