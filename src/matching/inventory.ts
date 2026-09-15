import fsp from "node:fs/promises";
import path from "node:path";
import { readFitsHeader } from "../fits/header.js";
import { frameFromHeader } from "../fits/classify.js";
import type { FrameGroup, FrameRecord, FrameType } from "../fits/types.js";

const FITS_EXT = new Set([".fit", ".fits", ".fts", ".xisf"]);

export interface ScanResult {
  warnings: string[];
  root: string;
  scanned_files: number;
  fits_files: number;
  errors: Array<{ path: string; error: string }>;
  frames: FrameRecord[];
  groups: FrameGroup[];
  summary: {
    by_type: Record<string, number>;
    targets: string[];
    total_light_exposure_s: number;
    unknown_type: number;
    type_sources: Record<string, number>;
  };
}

export async function listFiles(root: string, recursive = true, excludeDirNames: string[] = []): Promise<string[]> {
  const out: string[] = [];
  const excluded = new Set(excludeDirNames.map((d) => d.toLowerCase()));
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && !e.name.startsWith(".") && !excluded.has(e.name.toLowerCase())) await walk(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  await walk(root);
  return out;
}

/** Parse all FITS headers below root (XISF files are listed but not parsed). */
export async function scanFrames(root: string, opts: { recursive?: boolean; concurrency?: number; excludeDirNames?: string[] } = {}): Promise<ScanResult> {
  const files = await listFiles(root, opts.recursive ?? true, opts.excludeDirNames ?? []);
  const fits = files.filter((f) => FITS_EXT.has(path.extname(f).toLowerCase()));
  const frames: FrameRecord[] = [];
  const errors: ScanResult["errors"] = [];
  const conc = opts.concurrency ?? 16;
  let i = 0;
  async function worker(): Promise<void> {
    while (i < fits.length) {
      const f = fits[i++];
      if (path.extname(f).toLowerCase() === ".xisf") continue; // XISF: needs PixInsight to read; skipped in scan
      try {
        const st = await fsp.stat(f);
        const h = await readFitsHeader(f);
        frames.push(frameFromHeader(f, h, st.size));
      } catch (e) {
        errors.push({ path: f, error: (e as Error).message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, fits.length) }, worker));
  frames.sort((a, b) => a.path.localeCompare(b.path));
  const groups = groupFrames(frames);
  const warnings: string[] = [];
  for (const g of groups) {
    if (g.type === "light" && g.ccd_temp_min !== undefined && g.ccd_temp_max !== undefined && g.ccd_temp_max - g.ccd_temp_min > 3) {
      warnings.push(`${g.id} (${g.label}): sensor temperature drifted ${g.ccd_temp_min.toFixed(1)} → ${g.ccd_temp_max.toFixed(1)} °C during the session (cooler setpoint changed?); dark matching uses the median ${g.ccd_temp_median?.toFixed(1)} °C`);
    }
  }
  const byType: Record<string, number> = {};
  const typeSources: Record<string, number> = {};
  let lightExp = 0;
  for (const fr of frames) {
    byType[fr.type] = (byType[fr.type] ?? 0) + 1;
    typeSources[fr.type_source] = (typeSources[fr.type_source] ?? 0) + 1;
    if (fr.type === "light") lightExp += fr.exptime ?? 0;
  }
  const targets = [...new Set(frames.filter((f) => f.type === "light").map((f) => f.object ?? "?"))];
  return {
    root,
    warnings,
    scanned_files: files.length,
    fits_files: fits.length,
    errors,
    frames,
    groups,
    summary: { by_type: byType, targets, total_light_exposure_s: lightExp, unknown_type: byType.unknown ?? 0, type_sources: typeSources },
  };
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mostCommon(xs: string[]): string {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

export function groupFrames(frames: FrameRecord[]): FrameGroup[] {
  const map = new Map<string, FrameRecord[]>();
  for (const f of frames) {
    const arr = map.get(f.group_key) ?? [];
    arr.push(f);
    map.set(f.group_key, arr);
  }
  const groups: FrameGroup[] = [];
  let n = 0;
  for (const [key, arr] of map) {
    const first = arr[0];
    const temps = arr.map((f) => f.ccd_temp).filter((t): t is number => t !== undefined);
    const dates = arr.map((f) => f.date_obs).filter((d): d is string => !!d).sort();
    const foc = arr.map((f) => f.focuspos).filter((t): t is number => t !== undefined);
    const tMed = median(temps);
    const label = [
      first.type[0].toUpperCase() + first.type.slice(1),
      first.type === "light" && first.object ? first.object : undefined,
      first.exptime !== undefined ? `${Number(first.exptime.toFixed(1))}s` : undefined,
      first.gain !== undefined ? `g${first.gain}` : undefined,
      first.offset !== undefined ? `o${first.offset}` : undefined,
      first.binning !== 1 ? `bin${first.binning}` : undefined,
      first.filter ? `[${first.filter}]` : undefined,
      tMed !== undefined ? `${tMed.toFixed(1)}°C` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    groups.push({
      id: `${first.type}_${String(++n).padStart(2, "0")}`,
      type: first.type as FrameType,
      label,
      target: first.type === "light" ? first.object : undefined,
      instrume: first.instrume,
      exptime: first.exptime,
      gain: first.gain,
      offset: first.offset,
      binning: first.binning,
      filter: first.filter,
      bayerpat: first.bayerpat,
      ccd_temp_median: tMed,
      ccd_temp_min: temps.length ? Math.min(...temps) : undefined,
      ccd_temp_max: temps.length ? Math.max(...temps) : undefined,
      set_temp: first.set_temp,
      date_first: dates[0],
      date_last: dates[dates.length - 1],
      focuspos_median: median(foc),
      count: arr.length,
      total_exposure_s: arr.reduce((s, f) => s + (f.exptime ?? 0), 0),
      dims: first.width && first.height ? [first.width, first.height] : undefined,
      files: arr.map((f) => f.path),
      dir: mostCommon(arr.map((f) => path.dirname(f.path))),
    });
    void key;
  }
  const order: Record<string, number> = { light: 0, dark: 1, flat: 2, flatdark: 3, bias: 4, unknown: 5 };
  groups.sort((a, b) => order[a.type] - order[b.type] || (a.target ?? "").localeCompare(b.target ?? "") || (a.exptime ?? 0) - (b.exptime ?? 0));
  // Re-id after sorting so ids are stable and readable.
  const counters: Record<string, number> = {};
  for (const g of groups) {
    counters[g.type] = (counters[g.type] ?? 0) + 1;
    g.id = `${g.type}_${String(counters[g.type]).padStart(2, "0")}`;
  }
  return groups;
}
