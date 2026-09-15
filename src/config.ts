import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Configuration is resolved from (highest priority first):
 *   1. environment variables PIMCP_*
 *   2. config file: $PIMCP_CONFIG or ./pixinsight-mcp.config.json or ~/.pixinsight-mcp.json
 *   3. defaults below
 */
export const ConfigSchema = z.object({
  /** PixInsight executable. */
  piExe: z.string().default(defaultPiExe()),
  /** Root of the user's raw data. Never written to. Used to derive the default workdir. */
  dataRoot: z.string().optional(),
  /** All outputs go here. Default: sibling of dataRoot named pixinsight-mcp-work. */
  workdir: z.string().optional(),
  /** Refuse to calibrate lights without a master flat unless force: true. */
  requireFlats: z.boolean().default(true),
  /** Allow pi_run_pjsr (arbitrary script execution inside PixInsight). */
  allowRawScripts: z.boolean().default(true),
  /** Auto-launch PixInsight when a tool needs it and no daemon is alive. */
  autoLaunch: z.boolean().default(true),
  /**
   * Where intermediate/working files go:
   *  "target"  → <directory of the light frames>/working-files (next to the object, user rule)
   *  "workdir" → <workdir>/sessions/<id>/work
   */
  workLayout: z.enum(["target", "workdir"]).default("target"),
  /** Default stacking engine for pipeline_run: PixInsight's own WBPP script (user's usual tool) or the native tool chain. */
  stackingEngine: z.enum(["wbpp", "native"]).default("wbpp"),
  /** Extra WBPP automation parameters applied to every wbpp run (WBPP parameter names). */
  wbppParams: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Name of the per-target working directory when workLayout = "target". */
  workingDirName: z.string().default("working-files"),
  /** Keep calibrated/cosmetic/debayered/weighted/registered intermediates after the pipeline finishes (default: delete, keep masters + master light). */
  keepIntermediates: z.boolean().default(false),
  /** Directory names skipped by scan_frames (working files must never be re-scanned as raw data). */
  excludeDirNames: z.array(z.string()).default(["working-files", "pixinsight-mcp-work", "master", "calibrated", "registered", "debayered", "cosmetic", "weighted", "lnorm", "logs", "wbpp"]),
  /** Compile PixInsight's ImageSolver/AnnotateImage script libraries into the daemon (plate_solve, annotate). */
  includeAdpScripts: z.boolean().default(true),
  /** Extra command line flags for PixInsight. */
  piExtraArgs: z.array(z.string()).default([]),
  /** Heartbeat age (ms) after which an idle daemon is considered dead. */
  heartbeatStaleMs: z.number().int().positive().default(15_000),
  /** PixInsight startup timeout (ms). */
  launchTimeoutMs: z.number().int().positive().default(90_000),
  /** Matching tolerances. */
  tolerances: z
    .object({
      exposurePct: z.number().default(0.5),
      tempOkC: z.number().default(2),
      tempAcceptableC: z.number().default(5),
      flatAgeWarnDays: z.number().default(14),
      focusWarnSteps: z.number().default(200),
    })
    .default({}),
  /** Rig defaults used when headers lack the data (ASI2600MC Pro + FF70). */
  rig: z
    .object({
      pixelSizeUm: z.number().default(3.76),
      focalLengthMm: z.number().default(490),
      /** e-/ADU at the user's usual gain; SubframeSelector cameraGain. */
      cameraGainEPerAdu: z.number().default(0.25),
      cameraResolutionBits: z.number().default(16),
      bayerPattern: z.string().default("RGGB"),
    })
    .default({}),
  /** Preview rendering. */
  preview: z
    .object({
      maxEdgePx: z.number().int().default(1024),
      jpegQuality: z.number().int().default(85),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema> & { workdir: string; configSource: string };

function defaultPiExe(): string {
  if (process.platform === "win32") return "C:\\Program Files\\PixInsight\\bin\\PixInsight.exe";
  if (process.platform === "darwin") return "/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight";
  return "/opt/PixInsight/bin/PixInsight";
}

function readJsonIfExists(p: string): unknown | undefined {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse config file ${p}: ${(e as Error).message}`);
  }
  return undefined;
}

function envOverrides(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const e = process.env;
  if (e.PIMCP_PI_EXE) o.piExe = e.PIMCP_PI_EXE;
  if (e.PIMCP_DATA_ROOT) o.dataRoot = e.PIMCP_DATA_ROOT;
  if (e.PIMCP_WORKDIR) o.workdir = e.PIMCP_WORKDIR;
  if (e.PIMCP_REQUIRE_FLATS) o.requireFlats = e.PIMCP_REQUIRE_FLATS !== "false" && e.PIMCP_REQUIRE_FLATS !== "0";
  if (e.PIMCP_ALLOW_RAW_SCRIPTS) o.allowRawScripts = e.PIMCP_ALLOW_RAW_SCRIPTS !== "false" && e.PIMCP_ALLOW_RAW_SCRIPTS !== "0";
  if (e.PIMCP_AUTO_LAUNCH) o.autoLaunch = e.PIMCP_AUTO_LAUNCH !== "false" && e.PIMCP_AUTO_LAUNCH !== "0";
  return o;
}

export function loadConfig(cwd = process.cwd()): Config {
  const candidates = [
    process.env.PIMCP_CONFIG,
    path.join(cwd, "pixinsight-mcp.config.local.json"),
    path.join(cwd, "pixinsight-mcp.config.json"),
    path.join(os.homedir(), ".pixinsight-mcp.json"),
  ].filter(Boolean) as string[];

  let fileCfg: Record<string, unknown> = {};
  let source = "defaults";
  for (const c of candidates) {
    const j = readJsonIfExists(c);
    if (j && typeof j === "object") {
      fileCfg = j as Record<string, unknown>;
      source = c;
      break;
    }
  }
  const merged = { ...fileCfg, ...envOverrides() };
  const parsed = ConfigSchema.parse(merged);

  let workdir = parsed.workdir;
  if (!workdir) {
    workdir = parsed.dataRoot
      ? path.join(path.dirname(path.resolve(parsed.dataRoot)), "pixinsight-mcp-work")
      : path.join(cwd, "workdir");
  }
  workdir = path.resolve(workdir);
  if (parsed.dataRoot && isInside(workdir, path.resolve(parsed.dataRoot))) {
    throw new Error(`workdir (${workdir}) must not be inside dataRoot (${parsed.dataRoot})`);
  }
  return { ...parsed, workdir, configSource: source };
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Layout of the workdir. */
export function workdirLayout(workdir: string) {
  return {
    root: workdir,
    bridge: path.join(workdir, "bridge"),
    bridgeJobs: path.join(workdir, "bridge", "jobs"),
    bridgeResults: path.join(workdir, "bridge", "results"),
    bridgeLogs: path.join(workdir, "bridge", "logs"),
    heartbeat: path.join(workdir, "bridge", "heartbeat.json"),
    daemonInfo: path.join(workdir, "bridge", "daemon.json"),
    sessions: path.join(workdir, "sessions"),
    masters: path.join(workdir, "masters"),
    state: path.join(workdir, "state.json"),
  };
}

export function sessionLayout(workdir: string, sessionId: string) {
  const root = path.join(workdir, "sessions", sessionId);
  return {
    root,
    work: path.join(root, "work"),
    previews: path.join(root, "previews"),
    checkpoints: path.join(root, "checkpoints"),
    pipeline: path.join(root, "pipeline"),
    state: path.join(root, "session.json"),
  };
}
