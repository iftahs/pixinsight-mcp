import fs from "node:fs";
import path from "node:path";
import { sessionLayout, workdirLayout, type Config } from "./config.js";
import { ensureDirSync, makeId, nowIso, readJsonSafeSync, writeJsonAtomicSync } from "./util/fsx.js";
import { BridgeError } from "./bridge/types.js";

export interface SessionState {
  id: string;
  name: string;
  created_at: string;
  root: string;
  work: string;
  previews: string;
  checkpoints: string;
  pipeline: string;
  /** Free-form notes the agent may store (e.g. chosen masters). */
  notes: Record<string, unknown>;
  /** Roots scanned in this session (protected from writes). */
  scanned_roots: string[];
}

/** Sessions are output namespaces under the workdir. One is "current". */
export class SessionManager {
  private current?: SessionState;
  private statePath: string;

  constructor(private cfg: Config) {
    const l = workdirLayout(cfg.workdir);
    ensureDirSync(l.sessions);
    ensureDirSync(l.masters);
    this.statePath = l.state;
    const st = readJsonSafeSync<{ current?: string }>(this.statePath);
    if (st?.current) {
      const s = this.load(st.current);
      if (s) this.current = s;
    }
  }

  private load(id: string): SessionState | undefined {
    const l = sessionLayout(this.cfg.workdir, id);
    return readJsonSafeSync<SessionState>(l.state);
  }

  private persistCurrent(): void {
    writeJsonAtomicSync(this.statePath, { current: this.current?.id ?? null, updated_at: nowIso() });
  }

  list(): SessionState[] {
    const l = workdirLayout(this.cfg.workdir);
    if (!fs.existsSync(l.sessions)) return [];
    return fs
      .readdirSync(l.sessions)
      .map((d) => this.load(d))
      .filter((s): s is SessionState => !!s)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  start(name?: string): SessionState {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const safe = (name ?? "session").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
    const id = `${stamp}_${safe}_${makeId("s").slice(-6)}`;
    const l = sessionLayout(this.cfg.workdir, id);
    for (const d of [l.root, l.work, l.previews, l.checkpoints, l.pipeline]) ensureDirSync(d);
    const s: SessionState = {
      id,
      name: name ?? id,
      created_at: nowIso(),
      root: l.root,
      work: l.work,
      previews: l.previews,
      checkpoints: l.checkpoints,
      pipeline: l.pipeline,
      notes: {},
      scanned_roots: [],
    };
    writeJsonAtomicSync(l.state, s);
    this.current = s;
    this.persistCurrent();
    return s;
  }

  use(id: string): SessionState {
    const s = this.load(id);
    if (!s) throw new BridgeError("SESSION_NOT_FOUND", `no session ${id}`);
    this.current = s;
    this.persistCurrent();
    return s;
  }

  /** Current session, auto-creating one when needed. */
  ensure(): SessionState {
    if (!this.current) return this.start("auto");
    return this.current;
  }

  get(): SessionState | undefined {
    return this.current;
  }

  update(mut: (s: SessionState) => void): SessionState {
    const s = this.ensure();
    mut(s);
    writeJsonAtomicSync(sessionLayout(this.cfg.workdir, s.id).state, s);
    return s;
  }

  end(): SessionState | undefined {
    const s = this.current;
    this.current = undefined;
    this.persistCurrent();
    return s;
  }

  /** Path helper inside the current session's work dir. */
  workPath(...parts: string[]): string {
    const s = this.ensure();
    const p = path.join(s.work, ...parts);
    ensureDirSync(path.dirname(p));
    return p;
  }

  previewPath(name: string): string {
    const s = this.ensure();
    return path.join(s.previews, name);
  }
}
