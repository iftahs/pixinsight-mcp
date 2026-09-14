// Synthetic FITS fixture generator (no PixInsight needed).
// Writes tiny 16-bit RGGB frames with ASIAIR-style headers: lights (with fake stars + galaxy),
// darks (bias + hot pixels), flats (vignetting), bias, plus a "wrong" dark set for matching tests.
// Usage: npx tsx tests/fixtures/gen.ts [outDir]   (default tests/fixtures/data)
import fs from "node:fs";
import path from "node:path";

export interface FrameSpec {
  type: "Light" | "Dark" | "Flat" | "Bias";
  exptime: number;
  gain: number;
  offset: number;
  temp: number;
  setTemp: number;
  object?: string;
  seed: number;
  dateObs: string;
  width?: number;
  height?: number;
}

function card(key: string, value: string | number | boolean, comment = ""): string {
  let v: string;
  if (typeof value === "string") v = `'${value.padEnd(8)}'`;
  else if (typeof value === "boolean") v = (value ? "T" : "F").padStart(20);
  else v = String(value).padStart(20);
  let c = `${key.padEnd(8)}= ${v}`;
  if (comment) c += ` / ${comment}`;
  return c.padEnd(80).slice(0, 80);
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Build a synthetic frame as a Uint16 (unsigned via BZERO) array. */
export function synthPixels(spec: FrameSpec): Uint16Array {
  const W = spec.width ?? 192;
  const H = spec.height ?? 128;
  const r = rng(spec.seed);
  const hot = rng(12345); // fixed hot pixel map for the "camera"
  const px = new Float64Array(W * H);
  const bias = spec.offset * 10; // ADU pedestal
  const readNoise = 3.5;
  const darkRate = 0.02 * Math.pow(2, (spec.temp + 10) / 6); // e-/s, doubles per 6 °C
  for (let i = 0; i < W * H; ++i) px[i] = bias + gauss(r) * readNoise + darkRate * spec.exptime + Math.sqrt(darkRate * spec.exptime) * gauss(r);
  // Hot pixels (same positions for every frame of this camera)
  for (let k = 0; k < 40; ++k) {
    const i = Math.floor(hot() * W * H);
    px[i] += 800 + 400 * hot();
  }
  const cx = W / 2;
  const cy = H / 2;
  if (spec.type === "Light" || spec.type === "Flat") {
    for (let y = 0; y < H; ++y)
      for (let x = 0; x < W; ++x) {
        const d2 = ((x - cx) / W) ** 2 + ((y - cy) / H) ** 2;
        const vignette = 1 - 0.35 * d2 * 4;
        const cfa = (y & 1) === 0 ? ((x & 1) === 0 ? 1.0 : 0.85) : (x & 1) === 0 ? 0.85 : 0.7; // RGGB colour response
        if (spec.type === "Flat") px[y * W + x] += 25000 * vignette * cfa + gauss(r) * 40;
        else {
          let sig = 60 * spec.exptime * 0.05 * vignette * cfa; // sky background
          // galaxy
          const g = Math.exp(-(((x - cx) / 18) ** 2 + ((y - cy) / 9) ** 2));
          sig += 900 * g * vignette * cfa;
          px[y * W + x] += sig + Math.sqrt(Math.max(1, sig)) * gauss(r);
        }
      }
    if (spec.type === "Light") {
      const sr = rng(777); // stars: identical field for every frame, only a small dither offset per frame
      const dx = (spec.seed % 5) * 0.7;
      const dy = (spec.seed % 7) * 0.5;
      for (let k = 0; k < 140; ++k) {
        const sx = sr() * W + dx;
        const sy = sr() * H + dy;
        const amp = 400 + 6000 * sr() ** 3;
        const sig = 1.1;
        for (let y = Math.max(0, Math.floor(sy - 4)); y < Math.min(H, sy + 5); ++y)
          for (let x = Math.max(0, Math.floor(sx - 4)); x < Math.min(W, sx + 5); ++x) px[y * W + x] += amp * Math.exp(-(((x - sx) ** 2 + (y - sy) ** 2) / (2 * sig * sig)));
      }
    }
  }
  const out = new Uint16Array(W * H);
  for (let i = 0; i < W * H; ++i) out[i] = Math.max(0, Math.min(65535, Math.round(px[i])));
  return out;
}

export function writeFits(file: string, spec: FrameSpec): void {
  const W = spec.width ?? 192;
  const H = spec.height ?? 128;
  const pixels = synthPixels(spec);
  const cards = [
    card("SIMPLE", true, "file does conform to FITS standard"),
    card("BITPIX", 16, "number of bits per data pixel"),
    card("NAXIS", 2, "number of data axes"),
    card("NAXIS1", W, "length of data axis 1"),
    card("NAXIS2", H, "length of data axis 2"),
    card("BZERO", 32768, "offset data range to that of unsigned short"),
    card("BSCALE", 1, "default scaling factor"),
    card("CREATOR", "ZWO ASIAIR Plus", "Capture software"),
    card("OFFSET", spec.offset, "camera offset"),
    card("FOCALLEN", 490, "Focal length of telescope in mm"),
    card("SET-TEMP", spec.setTemp, "CCD temperature setpoint in degrees C"),
    card("XBINNING", 1, "Camera X Bin"),
    card("YBINNING", 1, "Camera Y Bin"),
    card("XPIXSZ", 3.76, "pixel size in microns (with binning)"),
    card("IMAGETYP", spec.type, "Type of image"),
    card("EXPOSURE", spec.exptime, "Exposure time in seconds"),
    card("EXPTIME", spec.exptime, "Exposure time in seconds"),
    card("CCD-TEMP", spec.temp, "sensor temperature in C"),
    card("DATE-OBS", spec.dateObs, "Image exposure start time"),
    card("INSTRUME", "ZWO ASI2600MC Pro", "Camera model"),
    card("BAYERPAT", "RGGB", "Bayer pattern"),
    card("GAIN", spec.gain, "Gain Value"),
    card("TELESCOP", "ZWO AM5N", "Telescope name"),
  ];
  if (spec.object) cards.push(card("OBJECT", spec.object, "name or catalog number of object being imaged"), card("RA", 10.68, "RA deg"), card("DEC", 41.27, "DEC deg"));
  cards.push("END".padEnd(80));
  let header = cards.join("");
  while (header.length % 2880 !== 0) header += " ";
  const data = Buffer.alloc(W * H * 2);
  for (let i = 0; i < W * H; ++i) data.writeInt16BE(pixels[i] - 32768, i * 2);
  const pad = Buffer.alloc((2880 - (data.length % 2880)) % 2880);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, "ascii"), data, pad]));
}

export interface FixtureSet {
  root: string;
  lights: string[];
  darks: string[];
  darksWrongExp: string[];
  darksWarm: string[];
  flats: string[];
  bias: string[];
}

export function generateFixtures(root: string, n = 5): FixtureSet {
  const set: FixtureSet = { root, lights: [], darks: [], darksWrongExp: [], darksWarm: [], flats: [], bias: [] };
  const t = (i: number, h = 20) => `2026-09-12T${String(h).padStart(2, "0")}:${String(i * 3).padStart(2, "0")}:00.000000`;
  for (let i = 0; i < n; ++i) {
    const f = path.join(root, "Autorun", "Light", "M 31", `Light_M 31_10.0s_Bin1_20260912-2000${i}_0001.fit`);
    writeFits(f, { type: "Light", exptime: 10, gain: 100, offset: 50, temp: -9.8 + 0.1 * i, setTemp: -10, object: "M 31", seed: 100 + i, dateObs: t(i) });
    set.lights.push(f);
    const d = path.join(root, "Autorun", "Dark", `Dark_10.0s_Bin1_gain100_20260912-2100${i}_-10.0C_0001.fit`);
    writeFits(d, { type: "Dark", exptime: 10, gain: 100, offset: 50, temp: -10 + 0.1 * i, setTemp: -10, seed: 200 + i, dateObs: t(i, 21) });
    set.darks.push(d);
    const dw = path.join(root, "Darks", "Gain 100", "-10", "30s", `Dark_30.0s_Bin1_gain100_20260912-2200${i}_-10.0C_0001.fit`);
    writeFits(dw, { type: "Dark", exptime: 30, gain: 100, offset: 50, temp: -10, setTemp: -10, seed: 300 + i, dateObs: t(i, 22) });
    set.darksWrongExp.push(dw);
    const dh = path.join(root, "Darks", "Gain 100", "0", "10s", `Dark_10.0s_Bin1_gain100_20260913-2200${i}_0.0C_0001.fit`);
    writeFits(dh, { type: "Dark", exptime: 10, gain: 100, offset: 50, temp: 0.2, setTemp: 0, seed: 400 + i, dateObs: t(i, 23) });
    set.darksWarm.push(dh);
    const fl = path.join(root, "Autorun", "Flat", `Flat_1.0s_Bin1_gain100_20260912-1900${i}_0001.fit`);
    writeFits(fl, { type: "Flat", exptime: 1, gain: 100, offset: 50, temp: -9.9, setTemp: -10, seed: 500 + i, dateObs: t(i, 19) });
    set.flats.push(fl);
    const b = path.join(root, "Autorun", "Bias", `Bias_0.0s_Bin1_gain100_20260912-1800${i}_0001.fit`);
    writeFits(b, { type: "Bias", exptime: 0.001, gain: 100, offset: 50, temp: -9.9, setTemp: -10, seed: 600 + i, dateObs: t(i, 18) });
    set.bias.push(b);
  }
  return set;
}

if (process.argv[1] && /gen\.(ts|js)$/.test(process.argv[1])) {
  const out = process.argv[2] ?? path.join(process.cwd(), "tests", "fixtures", "data");
  const s = generateFixtures(out, 5);
  console.log(`wrote ${s.lights.length + s.darks.length + s.darksWrongExp.length + s.darksWarm.length + s.flats.length + s.bias.length} frames under ${out}`);
}
