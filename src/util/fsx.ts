import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Write JSON atomically: write .tmp then rename. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

export function writeJsonAtomicSync(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** Read JSON; returns undefined if missing or (transiently) unparsable. */
export async function readJsonSafe<T = unknown>(file: string): Promise<T | undefined> {
  try {
    const txt = await fsp.readFile(file, "utf8");
    return JSON.parse(txt) as T;
  } catch {
    return undefined;
  }
}

export function readJsonSafeSync<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function ensureDir(dir: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function ensureDirSync(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function tailFile(file: string, maxBytes = 8192): Promise<string> {
  try {
    const st = await fsp.stat(file);
    const fh = await fsp.open(file, "r");
    try {
      const start = Math.max(0, st.size - maxBytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** PixInsight wants forward slashes on every platform. */
export function piPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

export function nowIso(): string {
  return new Date().toISOString();
}

let idCounter = 0;
/** Sortable unique id: <prefix>_<base36 time><counter><random>. */
export function makeId(prefix: string): string {
  idCounter = (idCounter + 1) % 4096;
  const t = Date.now().toString(36);
  const c = idCounter.toString(36).padStart(3, "0");
  const r = crypto.randomBytes(3).toString("hex");
  return `${prefix}_${t}${c}${r}`;
}
