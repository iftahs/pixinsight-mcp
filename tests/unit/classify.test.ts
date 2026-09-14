import { describe, it, expect } from "vitest";
import { typeFromImagetyp, typeFromPath, typeFromFilename, classify, groupKey, tempBucket } from "../../src/fits/classify.js";
import type { FitsHeader } from "../../src/fits/types.js";

const hdr = (cards: Record<string, string | number | boolean>): FitsHeader => ({ cards, comments: {}, blocks: 1, dataOffset: 2880 });

describe("frame classification", () => {
  it("trusts IMAGETYP in its many spellings", () => {
    expect(typeFromImagetyp("Light")).toBe("light");
    expect(typeFromImagetyp("Light Frame")).toBe("light");
    expect(typeFromImagetyp("LIGHT")).toBe("light");
    expect(typeFromImagetyp("Dark")).toBe("dark");
    expect(typeFromImagetyp("Flat Field")).toBe("flat");
    expect(typeFromImagetyp("Bias Frame")).toBe("bias");
    expect(typeFromImagetyp("Zero")).toBe("bias");
    expect(typeFromImagetyp("Flat Dark")).toBe("flatdark");
    expect(typeFromImagetyp("DarkFlat")).toBe("flatdark");
    expect(typeFromImagetyp("weird")).toBeUndefined();
  });

  it("falls back to the ASIAIR path convention and to the user's folder layout", () => {
    expect(typeFromPath("D:/ASIAIR/Autorun/Light/M 31/x.fit")).toBe("light");
    expect(typeFromPath("D:/ASIAIR/Autorun/Dark/x.fit")).toBe("dark");
    expect(typeFromPath("C:/Astronomy/Darks/Gain 100/-5/180/x.fit")).toBe("dark");
    expect(typeFromPath("C:/Astronomy/Flats/x.fit")).toBe("flat");
    expect(typeFromPath("C:/Astronomy/2026/M 31/x.fit")).toBeUndefined();
  });

  it("falls back to the ASIAIR filename prefix", () => {
    expect(typeFromFilename("Light_M 31_180.0s_Bin1_20260912-215209_35deg_0001.fit")).toBe("light");
    expect(typeFromFilename("Dark_120.0s_Bin1_gain100_20260914-184725_-4.6C_0001.fit")).toBe("dark");
    expect(typeFromFilename("Flat_1.0s_x.fit")).toBe("flat");
    expect(typeFromFilename("Bias_x.fit")).toBe("bias");
    expect(typeFromFilename("random.fit")).toBeUndefined();
  });

  it("reports which method decided", () => {
    expect(classify("C:/x/Autorun/Light/y.fit", hdr({ IMAGETYP: "Dark" }))).toEqual({ type: "dark", source: "IMAGETYP" });
    expect(classify("C:/x/Autorun/Light/y.fit", hdr({}))).toEqual({ type: "light", source: "path" });
    expect(classify("C:/x/y/Flat_1s.fit", hdr({}))).toEqual({ type: "flat", source: "filename" });
    expect(classify("C:/x/y/z.fit", hdr({}))).toEqual({ type: "unknown", source: "unknown" });
  });
});

describe("grouping keys", () => {
  const base = { path: "a", file: "a", size_bytes: 0, type: "light" as const, type_source: "IMAGETYP" as const, exptime: 180, gain: 100, offset: 50, binning: 1, instrume: "cam", object: "M 31" };

  it("does not split lights by temperature but does split darks", () => {
    expect(groupKey({ ...base, ccd_temp: -8.8, set_temp: -10 })).toBe(groupKey({ ...base, ccd_temp: 0.6, set_temp: 0 }));
    const d = { ...base, type: "dark" as const, object: undefined };
    expect(groupKey({ ...d, set_temp: -5, ccd_temp: -4.7 })).not.toBe(groupKey({ ...d, set_temp: 0, ccd_temp: 0 }));
  });

  it("splits by gain/exposure/target", () => {
    expect(groupKey(base)).not.toBe(groupKey({ ...base, gain: 50 }));
    expect(groupKey(base)).not.toBe(groupKey({ ...base, exptime: 120 }));
    expect(groupKey(base)).not.toBe(groupKey({ ...base, object: "NGC 6618" }));
  });

  it("buckets temperatures", () => {
    expect(tempBucket(-4.7, 2)).toBe("-4");
    expect(tempBucket(-5.2, 2)).toBe("-6");
    expect(tempBucket(undefined)).toBe("na");
  });
});
