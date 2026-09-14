import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { parseCard, parseHeaderBuffer, readFitsHeader, num, str } from "../../src/fits/header.js";
import { writeFits } from "../fixtures/gen.js";

describe("FITS card parser", () => {
  it("parses numeric, string, boolean and commented cards", () => {
    expect(parseCard("EXPTIME =                 180. / Exposure time in seconds".padEnd(80))).toEqual({ key: "EXPTIME", value: 180, comment: "Exposure time in seconds" });
    expect(parseCard("INSTRUME= 'ZWO ASI2600MC Pro'  / Camera model".padEnd(80))).toEqual({ key: "INSTRUME", value: "ZWO ASI2600MC Pro", comment: "Camera model" });
    expect(parseCard("SIMPLE  =                    T / conforms".padEnd(80))?.value).toBe(true);
    expect(parseCard("CCD-TEMP=    -8.80000019073486 / sensor temperature in C".padEnd(80))?.value).toBeCloseTo(-8.8, 5);
    expect(parseCard("DATE-OBS= '2026-09-12T18:49:08.473367' / start".padEnd(80))?.value).toBe("2026-09-12T18:49:08.473367");
    expect(parseCard("OBJECT  = 'M 31    '           / name".padEnd(80))?.value).toBe("M 31");
    expect(parseCard("COMMENT some text".padEnd(80))).toBeNull();
    expect(parseCard("END".padEnd(80))).toEqual({ key: "END", value: null });
  });

  it("handles escaped quotes and slashes inside strings", () => {
    expect(parseCard("TELESCOP= 'it''s a/b'          / c".padEnd(80))?.value).toBe("it's a/b");
  });

  it("parses a Fortran-style exponent", () => {
    expect(parseCard("XPIXSZ  =            3.76D+00".padEnd(80))?.value).toBeCloseTo(3.76, 6);
  });
});

describe("header reader", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pimcp-hdr-"));
  const file = path.join(dir, "light.fit");
  beforeAll(() => writeFits(file, { type: "Light", exptime: 180, gain: 100, offset: 50, temp: -8.8, setTemp: -10, object: "M 31", seed: 1, dateObs: "2026-09-12T18:49:08" }));

  it("reads only the header blocks and finds END", async () => {
    const h = await readFitsHeader(file);
    expect(h.blocks).toBe(1);
    expect(h.dataOffset).toBe(2880);
    expect(num(h, "EXPTIME", "EXPOSURE")).toBe(180);
    expect(str(h, "IMAGETYP")).toBe("Light");
    expect(str(h, "BAYERPAT")).toBe("RGGB");
    expect(num(h, "NAXIS1")).toBe(128);
  });

  it("rejects a non-FITS buffer", () => {
    expect(parseHeaderBuffer(Buffer.alloc(2880, 32))).toBeNull();
  });

  it("returns null when END is missing in the buffer", () => {
    const buf = Buffer.alloc(2880, 32);
    buf.write("SIMPLE  =                    T", 0, "ascii");
    expect(parseHeaderBuffer(buf)).toBeNull();
  });
});
