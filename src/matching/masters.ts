import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { workdirLayout } from "../config.js";
import { ensureDirSync, nowIso, readJsonSafeSync, writeJsonAtomic } from "../util/fsx.js";

export type MasterKind = "bias" | "dark" | "flat" | "flatdark";

export interface MasterMeta {
  fingerprint: string;
  kind: MasterKind;
  path: string;
  created_at: string;
  frame_count: number;
  source_files: string[];
  params: Record<string, unknown>;
  /** Descriptive key parts for listing/searching. */
  camera?: string;
  gain?: number;
  offset?: number;
  binning?: number;
  exptime?: number;
  temp_bucket?: string;
  filter?: string;
  stats?: unknown;
}

/** Hash of the first 64 KiB + size of a file: cheap, stable identity for a raw frame. */
export async function fileIdentity(file: string): Promise<string> {
  const st = await fsp.stat(file);
  const fh = await fsp.open(file, "r");
  try {
    const len = Math.min(65_536, st.size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return crypto.createHash("sha256").update(buf).update(String(st.size)).digest("hex").slice(0, 32);
  } finally {
    await fh.close();
  }
}

export interface FingerprintInput {
  kind: MasterKind;
  camera?: string;
  gain?: number;
  offset?: number;
  binning?: number;
  exptime?: number;
  temp_bucket?: string;
  filter?: string;
  files: string[];
  /** Any parameter that changes the output (e.g. master_bias fingerprint, rejection). */
  params?: Record<string, unknown>;
}

export async function fingerprint(input: FingerprintInput): Promise<string> {
  const ids = await Promise.all([...input.files].sort().map(fileIdentity));
  const h = crypto.createHash("sha256");
  h.update(
    JSON.stringify({
      k: input.kind,
      c: input.camera ?? "",
      g: input.gain ?? "",
      o: input.offset ?? "",
      b: input.binning ?? 1,
      e: input.exptime ?? "",
      t: input.temp_bucket ?? "",
      f: input.filter ?? "",
      n: ids.length,
      p: input.params ?? {},
    }),
  );
  for (const id of ids) h.update(id);
  return h.digest("hex").slice(0, 24);
}

/** Content-addressed master library: <workdir>/masters/<kind>_<fingerprint>.xisf + .json */
export class MasterLibrary {
  readonly dir: string;
  constructor(workdir: string) {
    this.dir = workdirLayout(workdir).masters;
    ensureDirSync(this.dir);
  }

  pathFor(kind: MasterKind, fp: string): string {
    return path.join(this.dir, `master_${kind}_${fp}.xisf`);
  }

  metaPathFor(kind: MasterKind, fp: string): string {
    return path.join(this.dir, `master_${kind}_${fp}.json`);
  }

  lookup(kind: MasterKind, fp: string): MasterMeta | undefined {
    const p = this.pathFor(kind, fp);
    if (!fs.existsSync(p)) return undefined;
    const meta = readJsonSafeSync<MasterMeta>(this.metaPathFor(kind, fp));
    return meta ?? { fingerprint: fp, kind, path: p, created_at: "", frame_count: 0, source_files: [], params: {} };
  }

  async record(meta: MasterMeta): Promise<void> {
    await writeJsonAtomic(this.metaPathFor(meta.kind, meta.fingerprint), { ...meta, created_at: meta.created_at || nowIso() });
  }

  list(filter?: { kind?: MasterKind; camera?: string; gain?: number; exptime?: number }): MasterMeta[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: MasterMeta[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const m = readJsonSafeSync<MasterMeta>(path.join(this.dir, f));
      if (!m) continue;
      if (!fs.existsSync(m.path)) continue;
      if (filter?.kind && m.kind !== filter.kind) continue;
      if (filter?.camera && m.camera !== filter.camera) continue;
      if (filter?.gain !== undefined && m.gain !== filter.gain) continue;
      if (filter?.exptime !== undefined && m.exptime !== filter.exptime) continue;
      out.push(m);
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}
