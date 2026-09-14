import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool } from "./registry.js";
import { scanFrames, type ScanResult } from "../matching/inventory.js";
import { buildPlan } from "../matching/match.js";
import { readFitsHeader } from "../fits/header.js";
import { frameFromHeader } from "../fits/classify.js";
import { readJsonSafe, writeJsonAtomic } from "../util/fsx.js";
import { BridgeError } from "../bridge/types.js";
import type { FrameGroup } from "../fits/types.js";

export async function loadScan(ctx: AppContext): Promise<ScanResult | undefined> {
  const s = ctx.sessions.ensure();
  return readJsonSafe<ScanResult>(path.join(s.root, "scan.json"));
}

export async function saveScan(ctx: AppContext, scan: ScanResult): Promise<void> {
  const s = ctx.sessions.ensure();
  await writeJsonAtomic(path.join(s.root, "scan.json"), scan);
}

export function groupById(scan: ScanResult, id: string): FrameGroup {
  const g = scan.groups.find((x) => x.id === id);
  if (!g) throw new BridgeError("GROUP_NOT_FOUND", `no group ${id} in the last scan; ids: ${scan.groups.map((x) => x.id).join(", ")}`);
  return g;
}

export function registerInventoryTools(server: McpServer, ctx: AppContext): void {
  defineTool(server, {
    name: "scan_frames",
    description:
      "Inventory a folder tree of FITS files WITHOUT PixInsight: parses headers, classifies light/dark/flat/bias (IMAGETYP → ASIAIR path → filename), groups by camera/gain/offset/exposure/temperature/target, reports counts and total integration. Result is cached in the session for match_calibration. The scanned root becomes write-protected.",
    input: { root: z.string().optional().describe("Folder to scan; default: config dataRoot"), recursive: z.boolean().optional(), include_frames: z.boolean().optional().describe("Include per-file records (large); default false") },
    readOnly: true,
    handler: async ({ root, recursive, include_frames }) => {
      const r = root ?? ctx.cfg.dataRoot;
      if (!r) throw new BridgeError("BAD_ARGS", "root required (no dataRoot configured)");
      const abs = path.resolve(r);
      ctx.safety.protect(abs);
      ctx.sessions.update((s) => {
        if (!s.scanned_roots.includes(abs)) s.scanned_roots.push(abs);
      });
      const scan = await scanFrames(abs, { recursive });
      await saveScan(ctx, scan);
      const groups = scan.groups.map((g) => ({
        id: g.id,
        type: g.type,
        label: g.label,
        target: g.target,
        count: g.count,
        exptime: g.exptime,
        gain: g.gain,
        offset: g.offset,
        binning: g.binning,
        filter: g.filter,
        bayerpat: g.bayerpat,
        ccd_temp_median: g.ccd_temp_median,
        ccd_temp_range: g.ccd_temp_min !== undefined ? [g.ccd_temp_min, g.ccd_temp_max] : undefined,
        set_temp: g.set_temp,
        date_first: g.date_first,
        date_last: g.date_last,
        total_exposure_s: g.total_exposure_s,
        total_exposure_h: Number((g.total_exposure_s / 3600).toFixed(2)),
        dims: g.dims,
        dir: g.dir,
        instrume: g.instrume,
      }));
      return {
        root: abs,
        scanned_files: scan.scanned_files,
        fits_files: scan.fits_files,
        summary: scan.summary,
        warnings: scan.warnings,
        groups,
        errors: scan.errors.slice(0, 20),
        frames: include_frames ? scan.frames : undefined,
        note: "Use group ids (light_01, dark_02 …) with match_calibration / pipeline_run. Frame lists via group_files.",
      };
    },
  });

  defineTool(server, {
    name: "group_files",
    description: "File paths of a frame group from the last scan.",
    input: { group_id: z.string() },
    readOnly: true,
    handler: async ({ group_id }) => {
      const scan = await loadScan(ctx);
      if (!scan) throw new BridgeError("NO_SCAN", "run scan_frames first");
      const g = groupById(scan, group_id);
      return { group_id, count: g.count, files: g.files };
    },
  });

  defineTool(server, {
    name: "fits_header",
    description: "Raw FITS header cards of one file plus the parsed frame record (no PixInsight needed).",
    input: { path: z.string() },
    readOnly: true,
    handler: async ({ path: p }) => {
      const h = await readFitsHeader(p);
      const st = await (await import("node:fs/promises")).stat(p);
      return { path: p, record: frameFromHeader(p, h, st.size), cards: h.cards, comments: h.comments };
    },
  });

  defineTool(server, {
    name: "match_calibration",
    description:
      "For a light group from the last scan: choose darks/flats/flat-darks/bias with the matching rules (exact INSTRUME/GAIN/OFFSET/binning, EXPTIME ±0.5 %, temperature graded ok/acceptable/poor), and output the CMOS calibration policy (dark+flat without bias when darks match; bias+optimizeDarks only for dark scaling; flats with flat-dark or bias). Returns reasoning, warnings and blocking issues. Show the plan to the user before stacking.",
    input: { light_group_id: z.string(), allow_dark_scaling: z.boolean().optional(), force: z.boolean().optional().describe("Proceed even without flats when requireFlats is on") },
    readOnly: true,
    handler: async ({ light_group_id, allow_dark_scaling, force }) => {
      const scan = await loadScan(ctx);
      if (!scan) throw new BridgeError("NO_SCAN", "run scan_frames first");
      const light = groupById(scan, light_group_id);
      if (light.type !== "light") throw new BridgeError("BAD_ARGS", `${light_group_id} is a ${light.type} group`);
      const plan = buildPlan(light, scan.groups, { tolerances: ctx.cfg.tolerances, requireFlats: ctx.cfg.requireFlats, allowDarkScaling: allow_dark_scaling, force });
      // Cached masters that would apply
      const cached = ctx.masters.list().filter((m) => m.camera === light.instrume && m.gain === light.gain);
      return { light: { id: light.id, label: light.label, count: light.count, total_exposure_h: Number((light.total_exposure_s / 3600).toFixed(2)) }, ...plan, cached_masters: cached.map((m) => ({ kind: m.kind, path: m.path, exptime: m.exptime, temp_bucket: m.temp_bucket, frame_count: m.frame_count })) };
    },
  });

  defineTool(server, {
    name: "list_masters",
    description: "Master library contents (content-addressed by camera/gain/offset/binning/exposure/temperature/source frames).",
    input: { kind: z.enum(["bias", "dark", "flat", "flatdark"]).optional(), camera: z.string().optional(), gain: z.number().optional(), exptime: z.number().optional() },
    readOnly: true,
    handler: async (f) => ({ dir: ctx.masters.dir, masters: ctx.masters.list(f) }),
  });
}
