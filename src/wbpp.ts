import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { isPidAlive } from "./bridge/launcher.js";
import { BridgeError } from "./bridge/types.js";
import { ensureDirSync, makeId, nowIso, piPath, tailFile } from "./util/fsx.js";

export interface WbppRun {
  id: string;
  pid: number;
  started_at: string;
  finished_at?: string;
  status: "running" | "ok" | "error";
  output_dir: string;
  args: string[];
  log_file?: string;
  master_light?: string[];
  masters?: string[];
  exit_note?: string;
}

/**
 * Drives PixInsight's own WeightedBatchPreprocessing script in a SEPARATE PixInsight instance
 * (WBPP's documented automation mode: WBPP.js,automationMode=true,dir=...,outputDir=...,--force-exit).
 * The daemon instance is untouched. Used as an independent cross-check of our pipeline.
 */
export class WbppRunner {
  private runs = new Map<string, WbppRun>();
  constructor(private cfg: Config) {}

  wbppScript(): string {
    const src = path.join(path.dirname(path.dirname(this.cfg.piExe)), "src", "scripts", "BatchPreprocessing", "WBPP.js");
    if (!fs.existsSync(src)) throw new BridgeError("WBPP_MISSING", `WBPP.js not found at ${src}`);
    return src;
  }

  start(opts: { dirs?: string[]; files?: string[]; output_dir: string; params?: Record<string, string | number | boolean>; keywords?: string }): WbppRun {
    const script = this.wbppScript();
    ensureDirSync(opts.output_dir);
    const parts: string[] = [piPath(script), "automationMode=true", `outputDir=${piPath(opts.output_dir)}`];
    for (const d of opts.dirs ?? []) parts.push(`dir=${piPath(d)}`);
    for (const f of opts.files ?? []) parts.push(`file=${piPath(f)}`);
    if (opts.keywords) parts.push(`keywords=${opts.keywords}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) parts.push(`${k}=${String(v)}`);
    const args = ["-n", "--automation-mode", `-r=${parts.join(",")}`, "--force-exit"];
    const child = spawn(this.cfg.piExe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    const run: WbppRun = { id: makeId("wbpp"), pid: child.pid ?? -1, started_at: nowIso(), status: "running", output_dir: opts.output_dir, args };
    this.runs.set(run.id, run);
    return run;
  }

  private latestLog(dir: string): string | undefined {
    const logs = path.join(dir, "logs");
    if (!fs.existsSync(logs)) return undefined;
    const files = fs.readdirSync(logs).filter((f) => f.endsWith(".log")).map((f) => path.join(logs, f));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0];
  }

  private findOutputs(dir: string, sub: string): string[] {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) return [];
    const out: string[] = [];
    const walk = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) walk(q);
        else if (/\.xisf$/i.test(e.name)) out.push(q);
      }
    };
    walk(d);
    return out;
  }

  async status(id: string): Promise<WbppRun & { log_tail?: string; elapsed_s: number }> {
    const r = this.runs.get(id);
    if (!r) throw new BridgeError("JOB_NOT_FOUND", `no wbpp run ${id}`);
    r.log_file = this.latestLog(r.output_dir) ?? r.log_file;
    if (r.status === "running" && !isPidAlive(r.pid)) {
      r.finished_at = nowIso();
      r.master_light = this.findOutputs(r.output_dir, "master").filter((f) => /masterLight/i.test(f));
      r.masters = this.findOutputs(r.output_dir, "master").filter((f) => !/masterLight/i.test(f));
      r.status = r.master_light.length ? "ok" : "error";
      r.exit_note = r.master_light.length ? "master light produced" : "PixInsight exited without a master light; read log_tail";
    }
    const log_tail = r.log_file ? await tailFile(r.log_file, 6000) : undefined;
    return { ...r, log_tail, elapsed_s: Math.round((Date.now() - Date.parse(r.started_at)) / 1000) };
  }

  list(): WbppRun[] {
    return [...this.runs.values()];
  }
}
