import { loadConfig, type Config } from "./config.js";
import { BridgeClient } from "./bridge/client.js";
import { SessionManager } from "./session.js";
import { SafetyGuard } from "./util/safety.js";
import { MasterLibrary } from "./matching/masters.js";
import { PipelineRunner } from "./pipeline/runner.js";

/** Everything tools need. One per server process. */
export class AppContext {
  readonly cfg: Config;
  readonly bridge: BridgeClient;
  readonly sessions: SessionManager;
  readonly safety: SafetyGuard;
  readonly masters: MasterLibrary;
  readonly pipelines: PipelineRunner;

  constructor(cfg?: Config) {
    this.cfg = cfg ?? loadConfig();
    this.bridge = new BridgeClient(this.cfg);
    this.sessions = new SessionManager(this.cfg);
    this.safety = new SafetyGuard(this.cfg.dataRoot);
    this.masters = new MasterLibrary(this.cfg.workdir);
    this.pipelines = new PipelineRunner(this);
    // Re-protect roots scanned in the current session (survives server restarts).
    for (const r of this.sessions.get()?.scanned_roots ?? []) this.safety.protect(r);
    const w = this.sessions.get()?.work;
    if (w) this.safety.allow(w);
  }

  /** Append a processing step to the session history (used by save_project's manifest). */
  async history(tool: string, args: Record<string, unknown>, result: unknown): Promise<void> {
    try {
      const { readJsonSafe, writeJsonAtomic } = await import("./util/fsx.js");
      const path = await import("node:path");
      const s = this.sessions.get();
      if (!s) return;
      const f = path.join(s.root, "history.json");
      const h = (await readJsonSafe<unknown[]>(f)) ?? [];
      const r = result as { checkpoint?: string; deferred?: boolean; id?: string } | undefined;
      const { checkpoint_dir: _cd, params, ...rest } = args as Record<string, unknown>;
      void _cd;
      h.push({ at: new Date().toISOString(), tool, view: r?.id ?? args.id, args: { ...rest, params }, checkpoint: r?.checkpoint, deferred: r?.deferred });
      await writeJsonAtomic(f, h);
    } catch {
      /* history is best-effort */
    }
  }
}
