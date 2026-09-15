import { describe, it, expect } from "vitest";
import { buildPlan, matchDarks, matchFlats, matchFlatDarks, matchBias, pickRejection, gradeTemp, type Tolerances } from "../../src/matching/match.js";
import type { FrameGroup } from "../../src/fits/types.js";

const tol: Tolerances = { exposurePct: 0.5, tempOkC: 2, tempAcceptableC: 5, flatAgeWarnDays: 14, focusWarnSteps: 200 };

let n = 0;
function group(p: Partial<FrameGroup> & { type: FrameGroup["type"] }): FrameGroup {
  n++;
  return {
    id: `${p.type}_${n}`,
    label: `${p.type} ${n}`,
    binning: 1,
    count: 20,
    total_exposure_s: 0,
    files: Array.from({ length: p.count ?? 20 }, (_, i) => `${p.type}${n}_${i}.fit`),
    dir: "x",
    instrume: "ZWO ASI2600MC Pro",
    gain: 100,
    offset: 50,
    exptime: 180,
    ccd_temp_median: -10,
    dims: [6248, 4176],
    ...p,
  };
}

describe("dark matching", () => {
  const light = group({ type: "light", ccd_temp_median: -8.8 });

  it("picks the dark with matching exposure/gain/offset and the closest temperature", () => {
    const d1 = group({ type: "dark", ccd_temp_median: -4.7 });
    const d2 = group({ type: "dark", ccd_temp_median: -9.5 });
    const d3 = group({ type: "dark", ccd_temp_median: -9.5, gain: 50 });
    const m = matchDarks(light, [d1, d2, d3], tol);
    expect(m.chosen?.group_id).toBe(d2.id);
    expect(m.chosen?.grade).toBe("ok");
    expect(m.candidates.find((c) => c.group_id === d3.id)?.hard_fail?.[0]).toMatch(/GAIN/);
  });

  it("grades temperature mismatches and still chooses the nearest", () => {
    const warm = group({ type: "dark", ccd_temp_median: -4.7 });
    const hot = group({ type: "dark", ccd_temp_median: 2 });
    const m = matchDarks(light, [hot, warm], tol);
    expect(m.chosen?.group_id).toBe(warm.id);
    expect(m.chosen?.grade).toBe("acceptable");
    expect(m.chosen?.deltas.temp_c).toBeCloseTo(4.1, 5);
    expect(m.candidates.find((c) => c.group_id === hot.id)?.grade).toBe("poor");
  });

  it("rejects exposure mismatch unless scaling is allowed", () => {
    const d = group({ type: "dark", exptime: 120 });
    expect(matchDarks(light, [d], tol).chosen).toBeUndefined();
    expect(matchDarks(light, [d], tol, true).chosen?.group_id).toBe(d.id);
  });

  it("accepts exposure within 0.5 %", () => {
    const d = group({ type: "dark", exptime: 180.5 });
    expect(matchDarks(light, [d], tol).chosen?.group_id).toBe(d.id);
    expect(matchDarks(light, [group({ type: "dark", exptime: 182 })], tol).chosen).toBeUndefined();
  });

  it("temperature grading thresholds", () => {
    expect(gradeTemp(1.9, tol)).toBe("ok");
    expect(gradeTemp(2.0, tol)).toBe("ok");
    expect(gradeTemp(4.9, tol)).toBe("acceptable");
    expect(gradeTemp(5.1, tol)).toBe("poor");
    expect(gradeTemp(undefined, tol)).toBe("acceptable");
  });
});

describe("flat / flat-dark / bias matching", () => {
  const light = group({ type: "light", date_first: "2026-09-12T18:00:00", focuspos_median: 12000 });

  it("flats need same filter/binning, not same gain; warn on age and focus", () => {
    const f = group({ type: "flat", exptime: 1, gain: 0, date_first: "2026-08-01T18:00:00", focuspos_median: 12500 });
    const m = matchFlats(light, [f], tol);
    expect(m.chosen?.group_id).toBe(f.id);
    expect(m.chosen?.grade).toBe("acceptable");
    expect(m.chosen?.reasons.join(" ")).toMatch(/days/);
    expect(m.chosen?.reasons.join(" ")).toMatch(/focus/);
    const wrongFilter = group({ type: "flat", exptime: 1, filter: "Ha" });
    expect(matchFlats(light, [wrongFilter], tol).chosen).toBeUndefined();
  });

  it("flat-darks must match the flats' exposure", () => {
    const flat = group({ type: "flat", exptime: 1.0 });
    const fd = group({ type: "flatdark", exptime: 1.0 });
    const d = group({ type: "dark", exptime: 180 });
    expect(matchFlatDarks(flat, [d, fd], tol).chosen?.group_id).toBe(fd.id);
    expect(matchFlatDarks(flat, [d], tol).chosen).toBeUndefined();
  });

  it("bias needs gain/offset", () => {
    const b = group({ type: "bias", exptime: 0.001 });
    const b2 = group({ type: "bias", exptime: 0.001, offset: 10 });
    const m = matchBias(light, [b2, b]);
    expect(m.chosen?.group_id).toBe(b.id);
  });
});

describe("CMOS calibration policy", () => {
  const light = group({ type: "light", ccd_temp_median: -9.8, date_first: "2026-09-12T18:00:00" });

  it("darks match → dark + flat, no bias, no optimisation", () => {
    const groups = [light, group({ type: "dark" }), group({ type: "flat", exptime: 1 }), group({ type: "flatdark", exptime: 1 }), group({ type: "bias", exptime: 0.001 })];
    const p = buildPlan(light, groups, { tolerances: tol, requireFlats: true });
    expect(p.policy.mode).toBe("dark+flat");
    expect(p.policy.master_bias_enabled).toBe(false);
    expect(p.policy.optimize_darks).toBe(false);
    expect(p.policy.calibrate_dark_with_bias).toBe(false);
    expect(p.policy.flat_calibration).toBe("flat_dark");
    expect(p.blocking).toEqual([]);
  });

  it("flats fall back to bias when no flat-dark exists", () => {
    const groups = [light, group({ type: "dark" }), group({ type: "flat", exptime: 1 }), group({ type: "bias", exptime: 0.001 })];
    expect(buildPlan(light, groups, { tolerances: tol, requireFlats: true }).policy.flat_calibration).toBe("bias");
  });

  it("exposure mismatch with scaling allowed → bias + optimizeDarks + calibrated dark, with a warning", () => {
    const groups = [light, group({ type: "dark", exptime: 300 }), group({ type: "flat", exptime: 1 }), group({ type: "bias", exptime: 0.001 })];
    const p = buildPlan(light, groups, { tolerances: tol, requireFlats: true, allowDarkScaling: true });
    expect(p.policy.mode).toBe("dark(scaled)+bias+flat");
    expect(p.policy.optimize_darks).toBe(true);
    expect(p.policy.master_bias_enabled).toBe(true);
    expect(p.policy.calibrate_dark_with_bias).toBe(true);
    expect(p.warnings.join(" ")).toMatch(/second-best/);
  });

  it("no darks → bias + flat and mandatory cosmetic auto-detect", () => {
    const groups = [light, group({ type: "flat", exptime: 1 }), group({ type: "bias", exptime: 0.001 })];
    const p = buildPlan(light, groups, { tolerances: tol, requireFlats: true });
    expect(p.policy.mode).toBe("bias+flat");
    expect(p.policy.cosmetic_auto_detect_required).toBe(true);
    expect(p.warnings.join(" ")).toMatch(/hot pixels/);
  });

  it("missing flats block unless requireFlats=false or force", () => {
    const groups = [light, group({ type: "dark" })];
    expect(buildPlan(light, groups, { tolerances: tol, requireFlats: true }).blocking.length).toBe(1);
    expect(buildPlan(light, groups, { tolerances: tol, requireFlats: true, force: true }).blocking.length).toBe(0);
    const p = buildPlan(light, groups, { tolerances: tol, requireFlats: false });
    expect(p.blocking.length).toBe(0);
    expect(p.policy.mode).toBe("dark-only");
    expect(p.warnings.join(" ")).toMatch(/no flats/);
  });

  it("flags mismatches for user confirmation", () => {
    const l = group({ type: "light", ccd_temp_median: -9.8 });
    const bad = buildPlan(l, [l, group({ type: "dark", ccd_temp_median: 0 })], { tolerances: tol, requireFlats: false });
    expect(bad.needs_confirmation.some((n) => /temperature mismatch/.test(n))).toBe(true);
    expect(bad.needs_confirmation).toContain("no flats");
    const good = buildPlan(l, [l, group({ type: "dark", ccd_temp_median: -10 }), group({ type: "flat", exptime: 1 }), group({ type: "flatdark", exptime: 1 })], { tolerances: tol, requireFlats: true });
    expect(good.needs_confirmation).toEqual([]);
  });

  it("the user's real situation: warm darks, no flats, no bias", () => {
    const l = group({ type: "light", ccd_temp_median: 0.0 });
    const groups = [l, group({ type: "dark", ccd_temp_median: -4.7 }), group({ type: "dark", ccd_temp_median: 0, gain: 50 })];
    const p = buildPlan(l, groups, { tolerances: tol, requireFlats: false });
    expect(p.dark.chosen?.grade).toBe("acceptable");
    expect(p.policy.mode).toBe("dark-only");
    expect(p.policy.master_bias_enabled).toBe(false);
    expect(p.warnings.some((w) => /temperature mismatch/.test(w))).toBe(true);
  });
});

describe("rejection algorithm by frame count", () => {
  it("follows the brief", () => {
    expect(pickRejection(3)).toBe("PercentileClip");
    expect(pickRejection(7)).toBe("PercentileClip");
    expect(pickRejection(8)).toBe("WinsorizedSigmaClip");
    expect(pickRejection(20)).toBe("WinsorizedSigmaClip");
    expect(pickRejection(21)).toBe("LinearFit");
  });
});
