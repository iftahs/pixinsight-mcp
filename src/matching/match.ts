import type { FrameGroup } from "../fits/types.js";

export interface Tolerances {
  exposurePct: number;
  tempOkC: number;
  tempAcceptableC: number;
  flatAgeWarnDays: number;
  focusWarnSteps: number;
}

export type Grade = "ok" | "acceptable" | "poor";

export interface Candidate {
  group_id: string;
  label: string;
  count: number;
  grade: Grade;
  score: number;
  deltas: Record<string, number | string | undefined>;
  reasons: string[];
  hard_fail?: string[];
}

export interface Match {
  chosen?: Candidate;
  candidates: Candidate[];
  rule: string;
}

export interface CalibrationPlan {
  light_group: string;
  dark: Match;
  flat: Match;
  flat_dark: Match;
  bias: Match;
  policy: {
    mode: "dark+flat" | "dark(scaled)+bias+flat" | "bias+flat" | "dark-only" | "none";
    master_bias_enabled: boolean;
    master_dark_enabled: boolean;
    master_flat_enabled: boolean;
    optimize_darks: boolean;
    calibrate_dark_with_bias: boolean;
    flat_calibration: "flat_dark" | "bias" | "none";
    cosmetic_auto_detect_required: boolean;
    reasoning: string[];
  };
  warnings: string[];
  blocking: string[];
}

function approx(a?: number, b?: number, pct = 0.5): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 0 && b === 0) return true;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) * 100 <= pct;
}

function daysBetween(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return undefined;
  return Math.abs(ta - tb) / 86_400_000;
}

/** Hard requirements shared by every pairing. */
function hardChecks(light: FrameGroup, cand: FrameGroup, requireGainOffset: boolean, requireFilter: boolean): string[] {
  const fails: string[] = [];
  if (light.instrume && cand.instrume && light.instrume !== cand.instrume) fails.push(`INSTRUME differs (${light.instrume} vs ${cand.instrume})`);
  if (light.binning !== cand.binning) fails.push(`binning differs (${light.binning} vs ${cand.binning})`);
  if (light.dims && cand.dims && (light.dims[0] !== cand.dims[0] || light.dims[1] !== cand.dims[1])) fails.push(`dimensions differ (${light.dims.join("x")} vs ${cand.dims.join("x")})`);
  if (requireGainOffset) {
    if (light.gain !== undefined && cand.gain !== undefined && light.gain !== cand.gain) fails.push(`GAIN differs (${light.gain} vs ${cand.gain})`);
    if (light.offset !== undefined && cand.offset !== undefined && light.offset !== cand.offset) fails.push(`OFFSET differs (${light.offset} vs ${cand.offset})`);
  }
  if (requireFilter && (light.filter ?? "") !== (cand.filter ?? "")) fails.push(`FILTER differs (${light.filter ?? "none"} vs ${cand.filter ?? "none"})`);
  return fails;
}

export function gradeTemp(delta: number | undefined, tol: Tolerances): Grade {
  if (delta === undefined) return "acceptable";
  if (delta <= tol.tempOkC) return "ok";
  if (delta <= tol.tempAcceptableC) return "acceptable";
  return "poor";
}

/** light ↔ dark: exact INSTRUME/GAIN/OFFSET/binning; EXPTIME ±0.5 %; CCD-TEMP graded. */
export function matchDarks(light: FrameGroup, darks: FrameGroup[], tol: Tolerances, allowExposureMismatch = false): Match {
  const candidates: Candidate[] = [];
  for (const d of darks) {
    const hard = hardChecks(light, d, true, false);
    const expMatch = approx(light.exptime, d.exptime, tol.exposurePct);
    if (!expMatch && !allowExposureMismatch) hard.push(`EXPTIME differs (${light.exptime}s vs ${d.exptime}s)`);
    const dT = light.ccd_temp_median !== undefined && d.ccd_temp_median !== undefined ? Math.abs(light.ccd_temp_median - d.ccd_temp_median) : undefined;
    const grade = gradeTemp(dT, tol);
    const reasons: string[] = [];
    if (expMatch) reasons.push("exposure matches");
    else reasons.push(`exposure mismatch ${d.exptime}s vs ${light.exptime}s (would need dark scaling)`);
    if (dT !== undefined) reasons.push(`temperature Δ ${dT.toFixed(1)} °C → ${grade}`);
    else reasons.push("temperature unknown");
    if (d.count < 10) reasons.push(`only ${d.count} darks (≥ 15 recommended)`);
    const score = (hard.length ? -1000 : 0) + (expMatch ? 100 : 0) - (dT ?? 10) * 5 + Math.min(d.count, 30);
    candidates.push({ group_id: d.id, label: d.label, count: d.count, grade: hard.length ? "poor" : grade, score, deltas: { exptime: d.exptime !== undefined && light.exptime !== undefined ? d.exptime - light.exptime : undefined, temp_c: dT }, reasons, hard_fail: hard.length ? hard : undefined });
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.find((c) => !c.hard_fail);
  return { chosen, candidates, rule: "light↔dark: INSTRUME, GAIN, OFFSET, binning exact; EXPTIME ±" + tol.exposurePct + "%; CCD-TEMP graded ok≤" + tol.tempOkC + " acceptable≤" + tol.tempAcceptableC };
}

/** light ↔ flat: INSTRUME/binning/FILTER exact; warn on age and focus. Gain need not match. */
export function matchFlats(light: FrameGroup, flats: FrameGroup[], tol: Tolerances): Match {
  const candidates: Candidate[] = [];
  for (const f of flats) {
    const hard = hardChecks(light, f, false, true);
    const reasons: string[] = [];
    const age = daysBetween(light.date_first, f.date_first);
    let score = (hard.length ? -1000 : 0) + Math.min(f.count, 30);
    if (age !== undefined) {
      if (age > tol.flatAgeWarnDays) {
        reasons.push(`flats taken ${age.toFixed(0)} days from lights (> ${tol.flatAgeWarnDays}); dust may have moved`);
        score -= age / 7;
      } else reasons.push(`flats within ${age.toFixed(0)} days of lights`);
    }
    if (light.focuspos_median !== undefined && f.focuspos_median !== undefined) {
      const df = Math.abs(light.focuspos_median - f.focuspos_median);
      if (df > tol.focusWarnSteps) {
        reasons.push(`focus position differs by ${df} steps (> ${tol.focusWarnSteps})`);
        score -= 10;
      }
    }
    if (light.gain !== undefined && f.gain !== undefined && light.gain !== f.gain) reasons.push(`gain differs (${f.gain} vs ${light.gain}) — fine for flats if flat-dark/bias match the flats`);
    const grade: Grade = hard.length ? "poor" : reasons.some((r) => /dust may|focus position/.test(r)) ? "acceptable" : "ok";
    candidates.push({ group_id: f.id, label: f.label, count: f.count, grade, score, deltas: { age_days: age }, reasons, hard_fail: hard.length ? hard : undefined });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { chosen: candidates.find((c) => !c.hard_fail), candidates, rule: "light↔flat: INSTRUME, binning, FILTER exact; warn DATE-OBS > " + tol.flatAgeWarnDays + " d or FOCUSPOS > " + tol.focusWarnSteps };
}

/** flat ↔ flat-dark (or dark with same exposure): INSTRUME/GAIN/OFFSET/binning exact; EXPTIME ±0.5 %. */
export function matchFlatDarks(flat: FrameGroup, darks: FrameGroup[], tol: Tolerances): Match {
  const candidates: Candidate[] = [];
  for (const d of darks) {
    const hard = hardChecks(flat, d, true, false);
    if (!approx(flat.exptime, d.exptime, tol.exposurePct)) hard.push(`EXPTIME differs (${flat.exptime}s vs ${d.exptime}s)`);
    const score = (hard.length ? -1000 : 0) + Math.min(d.count, 30) + (d.type === "flatdark" ? 5 : 0);
    candidates.push({ group_id: d.id, label: d.label, count: d.count, grade: hard.length ? "poor" : "ok", score, deltas: {}, reasons: hard.length ? [] : ["exposure and gain/offset match the flats"], hard_fail: hard.length ? hard : undefined });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { chosen: candidates.find((c) => !c.hard_fail), candidates, rule: "flat↔flat-dark: INSTRUME, GAIN, OFFSET, binning exact; EXPTIME ±" + tol.exposurePct + "%" };
}

/** any ↔ bias: INSTRUME/GAIN/OFFSET/binning exact. */
export function matchBias(ref: FrameGroup, biases: FrameGroup[]): Match {
  const candidates: Candidate[] = [];
  for (const b of biases) {
    const hard = hardChecks(ref, b, true, false);
    candidates.push({ group_id: b.id, label: b.label, count: b.count, grade: hard.length ? "poor" : "ok", score: (hard.length ? -1000 : 0) + Math.min(b.count, 50), deltas: {}, reasons: hard.length ? [] : ["gain/offset match"], hard_fail: hard.length ? hard : undefined });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { chosen: candidates.find((c) => !c.hard_fail), candidates, rule: "any↔bias: INSTRUME, GAIN, OFFSET, binning exact" };
}

export interface PlanOptions {
  tolerances: Tolerances;
  requireFlats: boolean;
  allowDarkScaling?: boolean;
  force?: boolean;
}

/** The CMOS calibration decision tree (brief §5). */
export function buildPlan(light: FrameGroup, groups: FrameGroup[], opts: PlanOptions): CalibrationPlan {
  const tol = opts.tolerances;
  const darks = groups.filter((g) => g.type === "dark");
  const flats = groups.filter((g) => g.type === "flat");
  const flatDarks = groups.filter((g) => g.type === "flatdark" || g.type === "dark");
  const biases = groups.filter((g) => g.type === "bias");
  const warnings: string[] = [];
  const blocking: string[] = [];
  const reasoning: string[] = [];

  let dark = matchDarks(light, darks, tol, false);
  let darkScaled = false;
  if (!dark.chosen && opts.allowDarkScaling) {
    const scaled = matchDarks(light, darks, tol, true);
    if (scaled.chosen) {
      dark = scaled;
      darkScaled = true;
      warnings.push("no dark matches the light exposure; using dark optimisation (scaling) with bias — second-best for CMOS");
    }
  }
  const flat = matchFlats(light, flats, tol);
  const bias = matchBias(light, biases);
  const flatDark = flat.chosen ? matchFlatDarks(groups.find((g) => g.id === flat.chosen!.group_id)!, flatDarks, tol) : { candidates: [], rule: "n/a (no flat)" };

  if (dark.chosen) {
    const g = dark.chosen.grade;
    if (g === "acceptable") warnings.push(`dark temperature mismatch ${dark.chosen.deltas.temp_c} °C: acceptable for a low-dark-current sensor (ASI2600), residual dark signal will be slightly off`);
    if (g === "poor") warnings.push(`dark temperature mismatch ${dark.chosen.deltas.temp_c} °C is large; hot pixels will be under/over-corrected — enable cosmetic correction auto-detect, or shoot darks at the light temperature`);
    if (dark.chosen.count < 10) warnings.push(`only ${dark.chosen.count} darks in the chosen set`);
  } else {
    warnings.push("no usable master dark: calibration falls back to bias + flat; cosmetic correction auto-detect becomes mandatory for hot pixels (ASI2600MC has negligible amp glow so this is survivable)");
  }
  if (!flat.chosen) {
    const msg = "no flats found: vignetting and dust motes cannot be corrected afterwards";
    if (opts.requireFlats && !opts.force) blocking.push(msg + " — refusing to proceed (set requireFlats=false in config or pass force:true)");
    else warnings.push(msg);
  } else if (flat.chosen.grade !== "ok") warnings.push(...flat.chosen.reasons.filter((r) => /dust|focus/.test(r)));

  let flatCal: CalibrationPlan["policy"]["flat_calibration"] = "none";
  if (flat.chosen) {
    if (flatDark.chosen) {
      flatCal = "flat_dark";
      reasoning.push(`flats calibrated with matching flat-dark/dark group ${flatDark.chosen.group_id} (same exposure) — preferred`);
    } else if (bias.chosen) {
      flatCal = "bias";
      reasoning.push(`no flat-dark with the flats' exposure; flats calibrated with master bias ${bias.chosen.group_id} — acceptable`);
    } else {
      warnings.push("no flat-dark or bias for the flats: master flat will be integrated uncalibrated (bias pedestal remains) — acceptable for short flats on a low-offset CMOS, but not ideal");
    }
  }

  let mode: CalibrationPlan["policy"]["mode"];
  let biasOn = false;
  let optimize = false;
  let calDark = false;
  if (dark.chosen && !darkScaled) {
    mode = flat.chosen ? "dark+flat" : "dark-only";
    reasoning.push("darks match the lights' exposure, gain, offset (and temperature within tolerance): calibrate with master dark + master flat only; the bias signal is inside the dark, so masterBias=off, optimizeDarks=off, calibrateDark=off (no double subtraction)");
  } else if (dark.chosen && darkScaled) {
    mode = "dark(scaled)+bias+flat";
    biasOn = !!bias.chosen;
    optimize = true;
    calDark = !!bias.chosen;
    if (!bias.chosen) warnings.push("dark scaling requested but no bias found: optimisation will run on an uncalibrated dark (poor)");
    reasoning.push("dark exposure differs: enable bias, optimizeDarks, and calibrate the master dark with the bias");
  } else if (bias.chosen) {
    mode = flat.chosen ? "bias+flat" : "none";
    biasOn = true;
    reasoning.push("no darks: subtract bias only; flat divides; cosmetic auto-detect mandatory");
  } else {
    mode = flat.chosen ? "bias+flat" : "none";
    if (flat.chosen) warnings.push("neither darks nor bias: lights will only be flat-fielded (bias pedestal remains, small on CMOS at low offset)");
    reasoning.push("no darks and no bias available");
  }

  return {
    light_group: light.id,
    dark,
    flat,
    flat_dark: flatDark as Match,
    bias,
    policy: {
      mode,
      master_bias_enabled: biasOn,
      master_dark_enabled: !!dark.chosen,
      master_flat_enabled: !!flat.chosen,
      optimize_darks: optimize,
      calibrate_dark_with_bias: calDark,
      flat_calibration: flatCal,
      cosmetic_auto_detect_required: !dark.chosen || dark.chosen.grade === "poor",
      reasoning,
    },
    warnings,
    blocking,
  };
}

/** Rejection algorithm by frame count (brief §6.4). */
export function pickRejection(n: number): "PercentileClip" | "WinsorizedSigmaClip" | "LinearFit" {
  if (n < 8) return "PercentileClip";
  if (n <= 20) return "WinsorizedSigmaClip";
  return "LinearFit";
}
