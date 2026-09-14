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
  }
}
