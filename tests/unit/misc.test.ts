import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { parseProgressFromLog, parseRejectionSummary } from "../../src/bridge/logtail.js";
import { SafetyGuard, assertMinFrames } from "../../src/util/safety.js";
import { fingerprint, fileIdentity } from "../../src/matching/masters.js";
import { isInside, ConfigSchema } from "../../src/config.js";
import { scanFrames } from "../../src/matching/inventory.js";
import { generateFixtures } from "../fixtures/gen.js";

describe("console log progress parsing", () => {
  it("prefers our own PIMCP-PROGRESS lines", () => {
    const p = parseProgressFromLog("[2026-09-14 20:00:00] * Loading image 3 of 10\n[2026-09-14 20:00:01] PIMCP-PROGRESS step=register current=4 total=30 msg=Light_0005.fit\n");
    expect(p).toEqual({ step: "register", current: 4, total: 30, message: "Light_0005.fit", percent: 13 });
  });
  it("parses PixInsight N of M lines", () => {
    const p = parseProgressFromLog("[t] Registering target image 7 of 30\n");
    expect(p?.step).toBe("registering");
    expect(p?.current).toBe(7);
    expect(p?.percent).toBe(23);
  });
  it("parses percent ticks", () => {
    expect(parseProgressFromLog("[t] Integrating pixel rows: 42%")?.percent).toBe(42);
  });
  it("extracts rejection summary", () => {
    const r = parseRejectionSummary("Rejected low : 12345 (0.123%)\nRejected high : 999 (0.010%)\n");
    expect(r.rejected_low_pct).toBeCloseTo(0.123);
    expect(r.total_rejected_pct).toBeCloseTo(0.133);
  });
});

describe("safety guard", () => {
  const root = path.resolve("C:/data/astro");
  const g = new SafetyGuard(root);
  it("refuses outputs under protected roots", () => {
    expect(() => g.assertWritable(path.join(root, "out.xisf"))).toThrow(/UNSAFE|protected/);
    expect(() => g.assertWritable(path.join(root, "sub", "x.xisf"))).toThrow();
    expect(g.assertWritable("C:/work/out.xisf")).toBe(path.resolve("C:/work/out.xisf"));
  });
  it("adds scanned roots", () => {
    g.protect("D:/scan");
    expect(() => g.assertWritable("D:/scan/x")).toThrow();
  });
  it("never clobbers", () => {
    const f = path.join(os.tmpdir(), "pimcp-clobber.txt");
    fs.writeFileSync(f, "x");
    expect(() => g.assertNoClobber(f)).toThrow(/EXISTS|exists/);
    expect(g.assertNoClobber(f, true)).toBe(path.resolve(f));
  });
  it("enforces the 3-frame minimum unless forced", () => {
    expect(() => assertMinFrames(2, 3, false, "integrate")).toThrow(/TOO_FEW|refusing/);
    expect(() => assertMinFrames(2, 3, true, "integrate")).not.toThrow();
  });
});

describe("master fingerprints", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pimcp-fp-"));
  const a = path.join(dir, "a.bin");
  const b = path.join(dir, "b.bin");
  fs.writeFileSync(a, Buffer.alloc(1000, 1));
  fs.writeFileSync(b, Buffer.alloc(1000, 2));
  it("is order-independent and content-sensitive", async () => {
    const f1 = await fingerprint({ kind: "dark", gain: 100, files: [a, b] });
    const f2 = await fingerprint({ kind: "dark", gain: 100, files: [b, a] });
    expect(f1).toBe(f2);
    fs.writeFileSync(b, Buffer.alloc(1000, 3));
    expect(await fingerprint({ kind: "dark", gain: 100, files: [a, b] })).not.toBe(f1);
    expect(await fingerprint({ kind: "dark", gain: 50, files: [a, b] })).not.toBe(f1);
    expect(await fingerprint({ kind: "dark", gain: 100, files: [a, b], params: { master_bias: "x" } })).not.toBe(await fingerprint({ kind: "dark", gain: 100, files: [a, b] }));
  });
  it("file identity depends on size", async () => {
    const id1 = await fileIdentity(a);
    fs.appendFileSync(a, "x");
    expect(await fileIdentity(a)).not.toBe(id1);
  });
});

describe("config", () => {
  it("has CMOS-friendly defaults and validates", () => {
    const c = ConfigSchema.parse({});
    expect(c.requireFlats).toBe(true);
    expect(c.tolerances.tempOkC).toBe(2);
    expect(c.rig.pixelSizeUm).toBeCloseTo(3.76);
  });
  it("isInside handles same/parent/sibling", () => {
    expect(isInside("C:/a/b", "C:/a")).toBe(true);
    expect(isInside("C:/a", "C:/a")).toBe(true);
    expect(isInside("C:/ab", "C:/a")).toBe(false);
    expect(isInside("C:/x", "C:/a")).toBe(false);
  });
});

describe("scan on synthetic fixtures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pimcp-scan-"));
  const set = generateFixtures(root, 4);
  it("classifies, groups and counts", async () => {
    const s = await scanFrames(root);
    expect(s.errors).toEqual([]);
    expect(s.summary.by_type).toEqual({ light: 4, dark: 12, flat: 4, bias: 4 });
    expect(s.summary.targets).toEqual(["M 31"]);
    expect(s.summary.total_light_exposure_s).toBe(40);
    const lights = s.groups.filter((g) => g.type === "light");
    expect(lights.length).toBe(1);
    expect(lights[0].files.sort()).toEqual([...set.lights].sort());
    // three dark groups: matching, wrong exposure, warm
    expect(s.groups.filter((g) => g.type === "dark").length).toBe(3);
  });
});
