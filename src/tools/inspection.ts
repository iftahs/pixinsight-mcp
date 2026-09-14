import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool, imageResult } from "./registry.js";
import { piPath } from "../util/fsx.js";

const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[x, y, width, height] in image pixels");

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function registerInspectionTools(server: McpServer, ctx: AppContext): void {
  defineTool(server, {
    name: "list_windows",
    description: "Open image windows/views: id, size, colour space, bit depth, file path, linear guess, astrometric solution, mask.",
    input: {},
    readOnly: true,
    handler: async () => ctx.bridge.run("list_windows", {}, { timeoutMs: 30_000 }),
  });

  defineTool(server, {
    name: "open_image",
    description: "Open an image file (FITS/XISF/TIFF/…) in PixInsight as a view. Returns the view id, dimensions, FITS keywords. The window stays open for later tools.",
    input: { path: z.string(), id: z.string().optional().describe("Desired view id (letters, digits, underscore)") },
    handler: async ({ path: p, id }) => ctx.bridge.run("open_image", { path: piPath(p), id }, { timeoutMs: 120_000 }),
  });

  defineTool(server, {
    name: "close_window",
    description: "Close an image window (force: discard unsaved changes, default true).",
    input: { id: z.string(), force: z.boolean().optional() },
    destructive: true,
    handler: async ({ id, force }) => ctx.bridge.run("close_window", { id, force }, { timeoutMs: 30_000 }),
  });

  defineTool(server, {
    name: "duplicate_window",
    description: "Deep-copy a view into a new window (no history). Use before experimenting.",
    input: { id: z.string(), new_id: z.string().optional() },
    handler: async ({ id, new_id }) => ctx.bridge.run("duplicate_window", { id, new_id }, { timeoutMs: 60_000 }),
  });

  defineTool(server, {
    name: "image_statistics",
    description:
      "Per-channel median, MAD, mean, σ, min/max, clipped-black and saturated counts/percent, MRS noise estimate, SNR proxy, background neutrality ratios, linear guess. Read-only. Use after every stretch/sharpen step.",
    input: { id: z.string(), rect: Rect.optional(), clip_low: z.number().optional().describe("Value at/below which pixels count as clipped (default 0)"), clip_high: z.number().optional().describe("Value at/above which pixels count as saturated (default 1)") },
    readOnly: true,
    handler: async (a) => ctx.bridge.run("image_statistics", a, { timeoutMs: 120_000 }),
  });

  defineTool(server, {
    name: "histogram",
    description: "Per-channel histogram counts (default 256 bins) for a view. Read-only.",
    input: { id: z.string(), bins: z.number().int().min(16).max(65536).optional() },
    readOnly: true,
    handler: async (a) => ctx.bridge.run("histogram", a, { timeoutMs: 60_000 }),
  });

  defineTool(server, {
    name: "image_keywords",
    description: "FITS keywords, XISF properties and astrometric solution summary of an open view.",
    input: { id: z.string() },
    readOnly: true,
    handler: async (a) => ctx.bridge.run("keywords", a, { timeoutMs: 30_000 }),
  });

  defineTool(server, {
    name: "render_preview",
    description:
      "LOOK AT THE IMAGE. Renders a JPEG preview of a view (auto-stretched by default for linear data) and returns it inline as an image plus its file path. Never modifies the view. stretch: 'stf' (AutoSTF), 'hard' (aggressive), 'none' (as-is, for already stretched images).",
    input: {
      id: z.string(),
      stretch: z.enum(["stf", "hard", "none"]).optional(),
      linked: z.boolean().optional().describe("Linked RGB stretch (default true; false shows colour balance issues)"),
      max_edge: z.number().int().min(128).max(2048).optional(),
      rect: Rect.optional().describe("Optional sub-region"),
    },
    readOnly: true,
    handler: async ({ id, stretch, linked, max_edge, rect }) => {
      const out = ctx.sessions.previewPath(`${id}_${stamp()}.jpg`);
      const r = await ctx.bridge.run<{ path: string }>("render_preview", { id, stretch, linked, max_edge: max_edge ?? ctx.cfg.preview.maxEdgePx, quality: ctx.cfg.preview.jpegQuality, rect, out_path: piPath(out) }, { timeoutMs: 180_000 });
      return imageResult(out, r);
    },
  });

  defineTool(server, {
    name: "crop_preview",
    description: "1:1 (or zoomed) JPEG of a region — for star shapes, halos, ringing, noise texture. Defaults to a 512 px box at the image centre. Pass center [x,y] or rect. zoom >1 magnifies.",
    input: {
      id: z.string(),
      rect: Rect.optional(),
      center: z.tuple([z.number(), z.number()]).optional(),
      size: z.number().int().min(32).max(2048).optional(),
      zoom: z.number().min(1).max(8).optional(),
      stretch: z.enum(["stf", "hard", "none"]).optional(),
      stf_from_crop: z.boolean().optional().describe("Compute the stretch from the crop instead of the full image"),
    },
    readOnly: true,
    handler: async (a) => {
      const out = ctx.sessions.previewPath(`${a.id}_crop_${stamp()}.jpg`);
      const r = await ctx.bridge.run<{ path: string }>("crop_preview", { ...a, quality: ctx.cfg.preview.jpegQuality, out_path: piPath(out) }, { timeoutMs: 120_000 });
      return imageResult(out, r);
    },
  });

  defineTool(server, {
    name: "compare_previews",
    description: "Side-by-side JPEG of two views (or a view and a checkpoint file) with the same stretch — before/after checks.",
    input: { id_a: z.string(), id_b: z.string().optional(), path_b: z.string().optional().describe("Checkpoint/file to compare against instead of id_b"), rect: Rect.optional(), stretch: z.enum(["stf", "hard", "none"]).optional(), linked: z.boolean().optional(), label_a: z.string().optional(), label_b: z.string().optional(), max_edge: z.number().int().optional() },
    readOnly: true,
    handler: async (a) => {
      const out = ctx.sessions.previewPath(`compare_${a.id_a}_${stamp()}.jpg`);
      const r = await ctx.bridge.run<{ path: string }>("compare_previews", { ...a, path_b: a.path_b ? piPath(a.path_b) : undefined, out_path: piPath(out), quality: ctx.cfg.preview.jpegQuality }, { timeoutMs: 180_000 });
      return imageResult(out, r);
    },
  });

  defineTool(server, {
    name: "measure_stars",
    description: "Objective star quality of a view: count, median FWHM (px and arcsec if pixel_scale given), eccentricity, centre vs edge FWHM, brightest stars. Uses StarDetector + DynamicPSF (Moffat). Read-only.",
    input: { id: z.string(), pixel_scale: z.number().optional().describe("arcsec/px; default from rig config"), max_psf_fits: z.number().int().optional(), fit_psf: z.boolean().optional(), sensitivity: z.number().optional() },
    readOnly: true,
    handler: async (a) => {
      const scale = a.pixel_scale ?? (206.265 * ctx.cfg.rig.pixelSizeUm) / ctx.cfg.rig.focalLengthMm;
      return ctx.bridge.runOrDefer("measure_stars", { ...a, pixel_scale: Number(scale.toFixed(4)) }, { timeoutMs: 600_000, deferAfterMs: 50_000 });
    },
  });

  defineTool(server, {
    name: "set_screen_stretch",
    description: "Apply an AutoSTF to the on-screen display of a view (non-destructive; for a human watching the PixInsight window).",
    input: { id: z.string(), mode: z.enum(["stf", "hard", "none"]).optional(), linked: z.boolean().optional() },
    handler: async (a) => ctx.bridge.run("set_screen_stf", a, { timeoutMs: 30_000 }),
  });

  defineTool(server, {
    name: "save_image",
    description: "Save a view to disk. Format by extension: .xisf (lossless, recommended), .fit, .tif, .png, .jpg. bit_depth 8/16 for tif/png. Output must be under the workdir (never in source folders).",
    input: { id: z.string(), path: z.string().optional().describe("Default: <session>/work/<id>.xisf"), format: z.enum(["xisf", "fit", "tif", "png", "jpg"]).optional(), bit_depth: z.number().int().optional(), overwrite: z.boolean().optional() },
    handler: async ({ id, path: p, format, bit_depth, overwrite }) => {
      const out = p ?? ctx.sessions.workPath(`${id}.${format ?? "xisf"}`);
      const abs = ctx.safety.assertNoClobber(out, !!overwrite);
      const r = await ctx.bridge.run("save_image", { id, path: piPath(abs), bit_depth, overwrite }, { timeoutMs: 300_000 });
      const size = await (await import("node:fs/promises")).stat(abs).then((s) => s.size).catch(() => undefined);
      return { ...(r as object), path: abs, size_bytes: size };
    },
  });

  defineTool(server, {
    name: "checkpoint",
    description: "Write an .xisf checkpoint of a view into the session's checkpoints/ dir; returns the path for restore_checkpoint.",
    input: { id: z.string(), label: z.string().optional() },
    handler: async ({ id, label }) => ctx.bridge.run("checkpoint", { id, dir: piPath(ctx.sessions.ensure().checkpoints), label }, { timeoutMs: 300_000 }),
  });

  defineTool(server, {
    name: "restore_checkpoint",
    description: "Roll back: load a checkpoint .xisf into the view in place (same id) or as a new window if the id is not open.",
    input: { path: z.string(), id: z.string().optional() },
    destructive: true,
    handler: async ({ path: p, id }) => ctx.bridge.run("restore_checkpoint", { path: piPath(p), id }, { timeoutMs: 300_000 }),
  });

  defineTool(server, {
    name: "undo",
    description: "Undo the last N history steps of a view (PixInsight undo stack).",
    input: { id: z.string(), steps: z.number().int().min(1).max(50).optional() },
    destructive: true,
    handler: async (a) => ctx.bridge.run("undo", a, { timeoutMs: 120_000 }),
  });

  defineTool(server, {
    name: "list_checkpoints",
    description: "Checkpoint files in the current session.",
    input: {},
    readOnly: true,
    handler: async () => {
      const fs = await import("node:fs/promises");
      const dir = ctx.sessions.ensure().checkpoints;
      const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".xisf")).sort();
      return { dir, checkpoints: files.map((f) => path.join(dir, f)) };
    },
  });
}
