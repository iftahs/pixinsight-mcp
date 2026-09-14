import fsp from "node:fs/promises";
import type { FitsHeader } from "./types.js";

const BLOCK = 2880;
const CARD = 80;
const MAX_BLOCKS = 64; // 180 KB of header is plenty for camera FITS

/** Parse one 80-char card. Returns null for blank/COMMENT/HISTORY cards. */
export function parseCard(card: string): { key: string; value: number | string | boolean | null; comment?: string } | null {
  const key = card.slice(0, 8).trim();
  if (!key || key === "COMMENT" || key === "HISTORY" || key === "CONTINUE") return null;
  if (key === "END") return { key: "END", value: null };
  if (card.slice(8, 10) !== "= ") {
    // Commentary or non-standard keyword without value.
    return { key, value: null, comment: card.slice(8).trim() };
  }
  let rest = card.slice(10);
  let value: number | string | boolean | null = null;
  let comment: string | undefined;
  if (rest.trimStart().startsWith("'")) {
    // String: find the closing single quote ('' is an escaped quote).
    const start = rest.indexOf("'");
    let i = start + 1;
    let s = "";
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === "'") {
        if (rest[i + 1] === "'") {
          s += "'";
          i += 2;
          continue;
        }
        break;
      }
      s += ch;
      i++;
    }
    value = s.replace(/\s+$/, "");
    const after = rest.slice(i + 1);
    const slash = after.indexOf("/");
    if (slash >= 0) comment = after.slice(slash + 1).trim();
  } else {
    const slash = rest.indexOf("/");
    let v = rest;
    if (slash >= 0) {
      v = rest.slice(0, slash);
      comment = rest.slice(slash + 1).trim();
    }
    v = v.trim();
    if (v === "T") value = true;
    else if (v === "F") value = false;
    else if (v === "") value = null;
    else if (/^[+-]?(\d+\.?\d*|\.\d+)([eEdD][+-]?\d+)?$/.test(v)) value = Number(v.replace(/[dD]/, "e"));
    else value = v;
  }
  return { key, value, comment };
}

/** Parse a primary FITS header from a buffer of whole 2880-byte blocks. */
export function parseHeaderBuffer(buf: Buffer): FitsHeader | null {
  if (buf.length < BLOCK || buf.toString("ascii", 0, 6) !== "SIMPLE") return null;
  const cards: FitsHeader["cards"] = {};
  const comments: Record<string, string> = {};
  let blocks = 0;
  for (let off = 0; off + BLOCK <= buf.length; off += BLOCK) {
    blocks++;
    for (let c = 0; c < BLOCK; c += CARD) {
      const card = buf.toString("latin1", off + c, off + c + CARD);
      const p = parseCard(card);
      if (!p) continue;
      if (p.key === "END") return { cards, comments, blocks, dataOffset: off + BLOCK };
      if (p.value !== null && !(p.key in cards)) cards[p.key] = p.value;
      if (p.comment) comments[p.key] = p.comment;
    }
  }
  return null; // END not found within the buffer
}

/** Read only the header blocks of a FITS file. */
export async function readFitsHeader(file: string): Promise<FitsHeader> {
  const fh = await fsp.open(file, "r");
  try {
    let nBlocks = 2;
    while (nBlocks <= MAX_BLOCKS) {
      const buf = Buffer.alloc(nBlocks * BLOCK);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const h = parseHeaderBuffer(buf.subarray(0, bytesRead - (bytesRead % BLOCK)));
      if (h) return h;
      if (bytesRead < buf.length) break; // file shorter than requested; no END → corrupt
      nBlocks *= 2;
    }
  } finally {
    await fh.close();
  }
  throw new Error(`Not a FITS file or header END not found: ${file}`);
}

export function num(h: FitsHeader, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = h.cards[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

export function str(h: FitsHeader, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = h.cards[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}
