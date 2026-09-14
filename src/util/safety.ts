import path from "node:path";
import fs from "node:fs";
import { isInside } from "../config.js";
import { BridgeError } from "../bridge/types.js";

/**
 * Safety rules (brief §9) enforced in code:
 *  1. Never write into source directories (dataRoot or any scanned root).
 *  2. Never overwrite user files.
 */
export class SafetyGuard {
  private protectedRoots = new Set<string>();

  constructor(dataRoot?: string) {
    if (dataRoot) this.protect(dataRoot);
  }

  protect(root: string): void {
    this.protectedRoots.add(path.resolve(root));
  }

  roots(): string[] {
    return [...this.protectedRoots];
  }

  /** Throws if `target` is inside a protected (input) root. */
  assertWritable(target: string, what = "output path"): string {
    const abs = path.resolve(target);
    for (const r of this.protectedRoots) {
      if (isInside(abs, r)) {
        throw new BridgeError("UNSAFE_OUTPUT", `${what} ${abs} is inside protected input root ${r}; outputs must go under the workdir`);
      }
    }
    return abs;
  }

  /** Throws if the file exists and overwrite is not allowed. */
  assertNoClobber(target: string, allowOverwrite = false): string {
    const abs = this.assertWritable(target);
    if (!allowOverwrite && fs.existsSync(abs)) {
      throw new BridgeError("EXISTS", `${abs} already exists; choose another path or pass overwrite:true`);
    }
    return abs;
  }
}

export function assertMinFrames(n: number, min: number, force: boolean | undefined, what: string): void {
  if (n < min && !force) {
    throw new BridgeError("TOO_FEW_FRAMES", `refusing to ${what} with ${n} frames (< ${min}); pass force:true to override`);
  }
}
