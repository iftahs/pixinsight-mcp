import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { workdirLayout } from "../config.js";
import { BridgeError, type DaemonInfo, type Heartbeat } from "./types.js";
import { ensureDirSync, nowIso, piPath, readJsonSafe, sleep, writeJsonAtomic } from "../util/fsx.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Locate pjsr/daemon.js relative to this module (works from src/ via tsx and from dist/). */
export function daemonScriptPath(): string {
  const candidates = [
    path.resolve(here, "../../pjsr/daemon.js"),
    path.resolve(here, "../pjsr/daemon.js"),
    path.resolve(process.cwd(), "pjsr/daemon.js"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new BridgeError("DAEMON_SCRIPT_MISSING", `pjsr/daemon.js not found; looked in ${candidates.join(", ")}`);
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we cannot signal it.
    return code === "EPERM";
  }
}

export class Launcher {
  private layout;
  constructor(private cfg: Config) {
    this.layout = workdirLayout(cfg.workdir);
  }

  async readHeartbeat(): Promise<Heartbeat | undefined> {
    return readJsonSafe<Heartbeat>(this.layout.heartbeat);
  }

  async readDaemonInfo(): Promise<DaemonInfo | undefined> {
    return readJsonSafe<DaemonInfo>(this.layout.daemonInfo);
  }

  /**
   * Daemon liveness. A heartbeat goes stale while the daemon is inside a blocking
   * process call, so staleness alone is not death: we also require that the PID is gone
   * or that the daemon is not reported busy.
   */
  async status(): Promise<{
    alive: boolean;
    reason: string;
    heartbeat?: Heartbeat;
    heartbeat_age_ms?: number;
    pid?: number;
    pid_alive?: boolean;
  }> {
    const hb = await this.readHeartbeat();
    const info = await this.readDaemonInfo();
    const pid = hb?.pid ?? info?.pid;
    const pidAlive = pid ? isPidAlive(pid) : false;
    if (!hb) return { alive: false, reason: "no heartbeat file", pid, pid_alive: pidAlive };
    const age = Date.now() - Date.parse(hb.ts);
    if (!pidAlive) return { alive: false, reason: `PixInsight pid ${pid} not running`, heartbeat: hb, heartbeat_age_ms: age, pid, pid_alive: false };
    if (age > this.cfg.heartbeatStaleMs && !hb.busy) {
      return { alive: false, reason: `heartbeat stale (${Math.round(age / 1000)} s) and daemon idle`, heartbeat: hb, heartbeat_age_ms: age, pid, pid_alive: true };
    }
    return { alive: true, reason: hb.busy ? `busy with ${hb.busy.op} (${hb.busy.job_id})` : "idle", heartbeat: hb, heartbeat_age_ms: age, pid, pid_alive: true };
  }

  buildArgs(): string[] {
    const script = piPath(daemonScriptPath());
    const bridge = piPath(this.layout.bridge);
    return ["-n", "--automation-mode", `-r=${script},${bridge}`, ...this.cfg.piExtraArgs];
  }

  /** Spawn PixInsight with the daemon script, detached. Resolves when the heartbeat appears. */
  async launch(): Promise<DaemonInfo> {
    if (!fs.existsSync(this.cfg.piExe)) {
      throw new BridgeError("PI_EXE_MISSING", `PixInsight executable not found at ${this.cfg.piExe}; set piExe in config or PIMCP_PI_EXE`);
    }
    ensureDirSync(this.layout.bridgeJobs);
    ensureDirSync(this.layout.bridgeResults);
    ensureDirSync(this.layout.bridgeLogs);
    // Remove a stale heartbeat so we do not mistake the old one for the new daemon.
    try {
      fs.unlinkSync(this.layout.heartbeat);
    } catch {
      /* ignore */
    }
    const { writeGeneratedIncludes } = await import("./generated.js");
    writeGeneratedIncludes(this.cfg);
    const args = this.buildArgs();
    const child = spawn(this.cfg.piExe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    const info: DaemonInfo = {
      pid: child.pid ?? -1,
      started_at: nowIso(),
      exe: this.cfg.piExe,
      args,
      bridge_dir: this.layout.bridge,
      launched_by: "pixinsight-mcp",
    };
    await writeJsonAtomic(this.layout.daemonInfo, info);

    const deadline = Date.now() + this.cfg.launchTimeoutMs;
    while (Date.now() < deadline) {
      const hb = await this.readHeartbeat();
      if (hb && Date.now() - Date.parse(hb.ts) < 10_000) return info;
      if (child.pid && !isPidAlive(child.pid)) {
        throw new BridgeError("PI_EXITED", "PixInsight exited before the daemon started; check the PixInsight console / script path", { args });
      }
      await sleep(500);
    }
    throw new BridgeError("PI_LAUNCH_TIMEOUT", `No daemon heartbeat within ${this.cfg.launchTimeoutMs} ms`, { args });
  }

  /** Ensure a live daemon; auto-launch if configured. */
  async ensureAlive(): Promise<void> {
    const st = await this.status();
    if (st.alive) return;
    if (!this.cfg.autoLaunch) {
      throw new BridgeError("DAEMON_DEAD", `PixInsight daemon not running (${st.reason}) and autoLaunch is off. Start PixInsight with: "${this.cfg.piExe}" ${this.buildArgs().join(" ")}`);
    }
    await this.launch();
  }

  /** Kill the PixInsight process (last resort; loses open windows). */
  async kill(): Promise<{ killed: boolean; pid?: number }> {
    const st = await this.status();
    const pid = st.pid;
    if (!pid || !st.pid_alive) return { killed: false, pid };
    const attempts: Array<() => void> = process.platform === "win32"
      ? [
          () => execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }),
          () => execFileSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { stdio: "ignore" }),
        ]
      : [() => process.kill(pid, "SIGKILL")];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch {
        /* try the next method */
      }
      for (let i = 0; i < 20 && isPidAlive(pid); i++) await sleep(250);
      if (!isPidAlive(pid)) break;
    }
    if (isPidAlive(pid)) throw new BridgeError("KILL_FAILED", `PixInsight pid ${pid} is still running after taskkill/Stop-Process; close it manually`);
    try {
      fs.unlinkSync(this.layout.heartbeat);
    } catch {
      /* ignore */
    }
    return { killed: true, pid };
  }
}
