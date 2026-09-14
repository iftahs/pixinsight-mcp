import type { JobProgress } from "./types.js";

/**
 * Parse PixInsight console output (as captured by Console.beginLog) into progress.
 * Lines are prefixed with "[YYYY-MM-DD HH:MM:SS] ".
 *
 * Known patterns (PixInsight 1.9):
 *   ImageIntegration:  "* Loading image N of M" / "Integrating pixel rows: ..."  and  "Reading image N of M"
 *   StarAlignment:     "* Registering target image N of M" (batch mode)
 *   ImageCalibration:  "* Calibrating target image N of M"  ... "Writing output file"
 *   Debayer/Cosmetic:  "* Processing image N of M"
 *   Generic percent:   "...: 42%" or "42%" progress ticks
 * Our own per-frame loops print "PIMCP-PROGRESS step=<name> current=<n> total=<m> msg=<text>".
 */
const OWN = /PIMCP-PROGRESS\s+step=(\S+)\s+current=(\d+)\s+total=(\d+)(?:\s+msg=(.*))?$/;
const N_OF_M: Array<{ re: RegExp; step: string }> = [
  { re: /Registering target image (\d+) of (\d+)/i, step: "registering" },
  { re: /Calibrating target image (\d+) of (\d+)/i, step: "calibrating" },
  { re: /Loading image (\d+) of (\d+)/i, step: "loading" },
  { re: /Reading image (\d+) of (\d+)/i, step: "reading" },
  { re: /Processing image (\d+) of (\d+)/i, step: "processing" },
  { re: /Measuring subframe (\d+) of (\d+)/i, step: "measuring" },
  { re: /Normalizing target image (\d+) of (\d+)/i, step: "normalizing" },
  { re: /Integrating image (\d+) of (\d+)/i, step: "integrating" },
  { re: /Drizzling image (\d+) of (\d+)/i, step: "drizzling" },
  { re: /image (\d+) of (\d+)/i, step: "processing" },
];
const PERCENT = /(\d{1,3})%\s*$/;

export function parseProgressFromLog(text: string, prev?: JobProgress): JobProgress | undefined {
  const lines = text.split(/\r?\n/);
  let out: JobProgress | undefined = prev ? { ...prev } : undefined;
  for (let i = lines.length - 1; i >= 0; --i) {
    const raw = lines[i].replace(/^\[[^\]]*\]\s*/, "").trim();
    if (!raw) continue;
    const own = OWN.exec(raw);
    if (own) {
      return {
        step: own[1],
        current: Number(own[2]),
        total: Number(own[3]),
        message: own[4]?.trim(),
        percent: Number(own[3]) > 0 ? Math.round((100 * Number(own[2])) / Number(own[3])) : undefined,
      };
    }
    for (const { re, step } of N_OF_M) {
      const m = re.exec(raw);
      if (m) {
        const cur = Number(m[1]);
        const tot = Number(m[2]);
        return { step, current: cur, total: tot, message: raw.slice(0, 160), percent: tot > 0 ? Math.round((100 * cur) / tot) : undefined };
      }
    }
    const p = PERCENT.exec(raw);
    if (p && !out?.step) {
      out = { ...(out ?? {}), step: out?.step ?? "working", percent: Number(p[1]), message: raw.slice(0, 160) };
      return out;
    }
  }
  return out;
}

/** Extract ImageIntegration rejection summary from console text. */
export function parseRejectionSummary(text: string): { rejected_low_pct?: number; rejected_high_pct?: number; total_rejected_pct?: number; lines: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\]\s*/, ""));
  const keep = lines.filter((l) => /Total rejected|Rejected (low|high)|Pixel rejection|rejected pixels|Weighting|SNR increment|Noise estimate|Reference noise/i.test(l));
  let low: number | undefined;
  let high: number | undefined;
  for (const l of keep) {
    const m = /Rejected\s+low\s*:\s*[\d,]+\s*\(\s*([\d.]+)%/i.exec(l) ?? /Total rejected low[^(]*\(\s*([\d.]+)%/i.exec(l);
    if (m) low = Number(m[1]);
    const h = /Rejected\s+high\s*:\s*[\d,]+\s*\(\s*([\d.]+)%/i.exec(l) ?? /Total rejected high[^(]*\(\s*([\d.]+)%/i.exec(l);
    if (h) high = Number(h[1]);
  }
  const total = low !== undefined || high !== undefined ? (low ?? 0) + (high ?? 0) : undefined;
  return { rejected_low_pct: low, rejected_high_pct: high, total_rejected_pct: total, lines: keep.slice(-30) };
}

/** Strip log timestamps and keep the last N lines. */
export function tailLines(text: string, n = 60): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-n).join("\n");
}
