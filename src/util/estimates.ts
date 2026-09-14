import path from "node:path";
import { readJsonSafeSync, writeJsonAtomicSync } from "./fsx.js";

/** Seconds per frame, learned from completed jobs; seeded with rough defaults for a 26 MP OSC frame. */
const DEFAULTS: Record<string, number> = {
  build_master_bias: 1.5,
  build_master_dark: 2.5,
  build_master_flat: 2.5,
  calibrate_lights: 3,
  cosmetic_correction: 3,
  debayer: 4,
  measure_subframes: 5,
  output_subframes: 2,
  register: 8,
  local_normalization: 6,
  integrate: 6,
  drizzle_integrate: 12,
  fast_integrate: 4,
  wbpp: 25,
};

export class Estimator {
  private file: string;
  private learned: Record<string, { s_per_frame: number; samples: number }>;

  constructor(workdir: string) {
    this.file = path.join(workdir, "benchmarks.json");
    this.learned = readJsonSafeSync(this.file) ?? {};
  }

  estimate(op: string, frames: number): number {
    const l = this.learned[op];
    const per = l?.s_per_frame ?? DEFAULTS[op] ?? 5;
    return Math.max(5, Math.round(per * Math.max(1, frames) + 5));
  }

  learn(op: string, frames: number, elapsedMs: number): void {
    if (!frames || elapsedMs <= 0) return;
    const per = elapsedMs / 1000 / frames;
    const l = this.learned[op];
    if (!l) this.learned[op] = { s_per_frame: per, samples: 1 };
    else this.learned[op] = { s_per_frame: (l.s_per_frame * l.samples + per) / (l.samples + 1), samples: Math.min(l.samples + 1, 20) };
    try {
      writeJsonAtomicSync(this.file, this.learned);
    } catch {
      /* ignore */
    }
  }
}
