import path from "node:path";
import type { FitsHeader, FrameRecord, FrameType } from "./types.js";
import { num, str } from "./header.js";

/** Map IMAGETYP strings (many capture programs, many spellings) to a frame type. */
export function typeFromImagetyp(v: string | undefined): FrameType | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  if (/flat ?dark|dark ?flat|flatdark/.test(s)) return "flatdark";
  if (/^(light|light frame|object|science)/.test(s)) return "light";
  if (/^(dark|dark frame)/.test(s)) return "dark";
  if (/^(flat|flat frame|flat field)/.test(s)) return "flat";
  if (/^(bias|bias frame|zero|offset)/.test(s)) return "bias";
  return undefined;
}

/** ASIAIR layout: .../Autorun/Light/<target>/..., .../Plan/Dark/..., or user folders named Darks/Flats/... */
export function typeFromPath(p: string): FrameType | undefined {
  const parts = p.replace(/\\/g, "/").split("/").map((x) => x.toLowerCase());
  for (let i = parts.length - 2; i >= 0; --i) {
    const d = parts[i];
    if (/^(flat ?darks?|dark ?flats?|flatdarks?)$/.test(d)) return "flatdark";
    if (/^lights?$/.test(d)) return "light";
    if (/^darks?$/.test(d)) return "dark";
    if (/^flats?$/.test(d)) return "flat";
    if (/^bias(es)?$/.test(d)) return "bias";
  }
  return undefined;
}

/** ASIAIR filenames: Light_M 31_180.0s_Bin1_..., Dark_120.0s_Bin1_gain100_..., Flat_..., Bias_... */
export function typeFromFilename(p: string): FrameType | undefined {
  const f = path.basename(p).toLowerCase();
  if (/^(flat ?dark|darkflat|flatdark)/.test(f)) return "flatdark";
  if (/^light[_\-\s]/.test(f)) return "light";
  if (/^dark[_\-\s]/.test(f)) return "dark";
  if (/^flat[_\-\s]/.test(f)) return "flat";
  if (/^bias[_\-\s]/.test(f)) return "bias";
  return undefined;
}

export function classify(p: string, h: FitsHeader): { type: FrameType; source: FrameRecord["type_source"] } {
  const t1 = typeFromImagetyp(str(h, "IMAGETYP", "FRAME", "FRAMETYP"));
  if (t1) return { type: t1, source: "IMAGETYP" };
  const t2 = typeFromPath(p);
  if (t2) return { type: t2, source: "path" };
  const t3 = typeFromFilename(p);
  if (t3) return { type: t3, source: "filename" };
  return { type: "unknown", source: "unknown" };
}

/** Round a temperature into a 1 °C bucket label. */
export function tempBucket(t: number | undefined, width = 1): string {
  if (t === undefined) return "na";
  return String(Math.round(t / width) * width);
}

export function groupKey(r: Omit<FrameRecord, "group_key">): string {
  const parts = [
    r.type,
    r.instrume ?? "?",
    `bin${r.binning}`,
    `g${r.gain ?? "?"}`,
    `o${r.offset ?? "?"}`,
    r.exptime !== undefined ? `e${Number(r.exptime.toFixed(2))}` : "e?",
    r.filter ? `f${r.filter}` : "f-",
    // Lights: temperature drift within a session is normal and must not split the group (reported as a range instead).
    // Calibration frames: bucket by setpoint (or 2 °C of measured temperature) so dark libraries at different temps stay apart.
    r.type === "light" ? `obj:${(r.object ?? "?").trim()}` : `t${tempBucket(r.set_temp ?? r.ccd_temp, r.set_temp !== undefined ? 1 : 2)}`,
  ];
  return parts.filter(Boolean).join("|");
}

/** Build a frame record from a header. `size_bytes` is passed by the scanner. */
export function frameFromHeader(p: string, h: FitsHeader, sizeBytes: number): FrameRecord {
  const cls = classify(p, h);
  const rec: Omit<FrameRecord, "group_key"> = {
    path: p,
    file: path.basename(p),
    size_bytes: sizeBytes,
    type: cls.type,
    type_source: cls.source,
    imagetyp: str(h, "IMAGETYP"),
    exptime: num(h, "EXPTIME", "EXPOSURE"),
    gain: num(h, "GAIN"),
    offset: num(h, "OFFSET", "BLKLEVEL"),
    ccd_temp: num(h, "CCD-TEMP", "CCDTEMP", "TEMPERAT"),
    set_temp: num(h, "SET-TEMP", "SETTEMP"),
    binning: num(h, "XBINNING", "BINNING") ?? 1,
    instrume: str(h, "INSTRUME", "CAMERA"),
    filter: str(h, "FILTER"),
    bayerpat: str(h, "BAYERPAT", "COLORTYP"),
    date_obs: str(h, "DATE-OBS", "DATE-LOC"),
    object: str(h, "OBJECT"),
    focallen: num(h, "FOCALLEN"),
    xpixsz: num(h, "XPIXSZ", "PIXSIZE1"),
    width: num(h, "NAXIS1"),
    height: num(h, "NAXIS2"),
    focuspos: num(h, "FOCUSPOS", "FOCPOS"),
    ra: num(h, "RA", "OBJCTRA"),
    dec: num(h, "DEC", "OBJCTDEC"),
    telescop: str(h, "TELESCOP"),
    creator: str(h, "CREATOR", "SWCREATE", "PROGRAM"),
  };
  return { ...rec, group_key: groupKey(rec) };
}
