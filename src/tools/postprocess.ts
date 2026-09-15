import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool, imageResult } from "./registry.js";
import { piPath } from "../util/fsx.js";

const Params = z.record(z.unknown()).optional().describe("Extra raw PixInsight process parameters (exact PJSR names)");
const Ckpt = z.boolean().optional().describe("Write an .xisf checkpoint before running (default true)");

export function registerPostprocessTools(server: McpServer, ctx: AppContext): void {
  const ck = (checkpoint?: boolean) => ({ checkpoint_dir: piPath(ctx.sessions.ensure().checkpoints), checkpoint: checkpoint ?? true });
  // Post-processing ops can take minutes on a 26 MP frame: wait up to 45 s, then hand back a job_id.
  const run = async (op: string, args: Record<string, unknown>, timeout = 1_800_000) => {
    const r = await ctx.bridge.runOrDefer(op, args, { timeoutMs: timeout, deferAfterMs: 45_000 });
    await ctx.history(op, args, r);
    return r;
  };

  defineTool(server, {
    name: "apply_process",
    description:
      "Generic fallback: apply ANY installed PixInsight process by name to a view (or globally when id omitted) with a flat params object using exact PJSR parameter names (see process_params). Enum values may be given as strings (e.g. 'WinsorizedSigmaClip'). Checkpoints first.",
    input: { process: z.string(), id: z.string().optional(), params: z.record(z.unknown()).optional(), ignore_unknown: z.boolean().optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("apply_process", { ...a, ...ck(a.checkpoint) }, 3_600_000),
  });

  defineTool(server, {
    name: "process_params",
    description: "Default parameter listing (toSource) of a PixInsight process — discover exact parameter names for apply_process.",
    input: { process: z.string() },
    readOnly: true,
    handler: async (a) => run("process_params", a, 30_000),
  });

  defineTool(server, {
    name: "gradient_correction",
    description: "Remove light-pollution gradients on a LINEAR image. method 'DBE' (DynamicBackgroundExtraction with automatically placed background samples, stars/object rejected; the user's preferred method), 'GradientCorrection' (default when DBE not requested), or 'ABE'. Checkpoints first. Look at the preview afterwards; dry_run reports the DBE sample layout.",
    input: { id: z.string(), method: z.enum(["DBE", "GradientCorrection", "ABE"]).optional(), samples_per_row: z.number().int().optional().describe("DBE grid density (default 10)"), radius: z.number().int().optional().describe("DBE sample radius px"), tolerance: z.number().optional().describe("DBE: reject samples brighter than background by this many sigma (default 2)"), smoothing: z.number().optional().describe("DBE model smoothing (default 0.25)"), dry_run: z.boolean().optional(), scale: z.number().optional().describe("GradientCorrection scale (default 5)"), degree: z.number().int().optional().describe("ABE polynomial degree (default 4)"), correction: z.enum(["subtract", "divide"]).optional(), params: Params, checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => (a.method === "DBE" ? run("dbe_auto", { ...a, ...ck(a.checkpoint) }) : run("gradient_correction", { ...a, ...ck(a.checkpoint) })),
  });

  defineTool(server, {
    name: "plate_solve",
    description: "ImageSolver astrometric solution (needed by SPCC/PCC and annotate). Seeds RA/DEC/focal/pixel size from FITS keywords; pass them if headers lack them. Needs internet for the Gaia/VizieR catalog. Non-destructive (adds metadata).",
    input: { id: z.string(), ra: z.number().optional().describe("degrees"), dec: z.number().optional().describe("degrees"), focal_length: z.number().optional().describe("mm; default rig"), pixel_size: z.number().optional().describe("µm; default rig"), magnitude: z.number().optional(), distortion_correction: z.boolean().optional(), force: z.boolean().optional() },
    handler: async (a) => run("plate_solve", { ...a, focal_length: a.focal_length ?? ctx.cfg.rig.focalLengthMm, pixel_size: a.pixel_size ?? ctx.cfg.rig.pixelSizeUm }, 900_000),
  });

  defineTool(server, {
    name: "annotate",
    description: "Render an annotated JPEG (Messier/NGC/named stars/constellations/grid) of a plate-solved view to confirm the target. Non-destructive.",
    input: { id: z.string(), layers: z.array(z.string()).optional(), max_edge: z.number().int().optional() },
    readOnly: true,
    handler: async (a) => {
      const out = ctx.sessions.previewPath(`${a.id}_annotated_${Date.now()}.jpg`);
      const r = await run("annotate", { ...a, out_path: piPath(out) }, 900_000);
      if ((r as { deferred?: boolean }).deferred) return r;
      return imageResult(out, r);
    },
  });

  defineTool(server, {
    name: "color_calibrate",
    description: "SPCC (default; needs plate solution + internet, defaults tuned for a Sony OSC sensor with UV/IR cut) → PCC fallback → ColorCalibration (no astrometry). Optionally neutralizes background. Linear data only. Checkpoints first.",
    input: { id: z.string(), method: z.enum(["SPCC", "PCC", "ColorCalibration"]).optional(), neutralize_background: z.boolean().optional(), background_reference_id: z.string().optional(), narrowband: z.boolean().optional(), white_reference: z.string().optional(), limit_magnitude: z.number().optional(), params: Params, checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("color_calibrate", { ...a, ...ck(a.checkpoint) }, 1_800_000),
  });

  defineTool(server, {
    name: "background_neutralize",
    description: "BackgroundNeutralization (equalize channel backgrounds) — linear stage. Checkpoints first.",
    input: { id: z.string(), reference_id: z.string().optional(), background_high: z.number().optional(), params: Params, checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("background_neutralize", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "scnr",
    description: "SCNR green (or other colour) cast removal, non-linear stage typically. Checkpoints first.",
    input: { id: z.string(), amount: z.number().optional(), color: z.enum(["Red", "Green", "Blue"]).optional(), protection: z.string().optional(), preserve_lightness: z.boolean().optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("scnr", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "deconvolve",
    description: "BlurXTerminator if installed (correct_only mode for the linear stage), else native Richardson-Lucy Deconvolution with a PSF sized from measured FWHM (conservative, deringing on). Check crop_preview for dark rings afterwards. Checkpoints first. Async-ish (can take minutes).",
    input: { id: z.string(), method: z.enum(["auto", "native"]).optional(), correct_only: z.boolean().optional(), sharpen_stars: z.number().optional(), sharpen_nonstellar: z.number().optional(), adjust_halos: z.number().optional(), iterations: z.number().int().optional(), fwhm_px: z.number().optional(), deringing_dark: z.number().optional(), params: Params, checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("deconvolve", { ...a, method: a.method === "auto" ? undefined : a.method, ...ck(a.checkpoint) }, 3_600_000),
  });

  defineTool(server, {
    name: "denoise",
    description: "NoiseXTerminator if installed, else MultiscaleLinearTransform (linear data) / TGVDenoise (non-linear) with a strength 0..1. Checkpoints first.",
    input: { id: z.string(), method: z.enum(["auto", "native", "TGV"]).optional(), strength: z.number().min(0).max(1).optional(), denoise: z.number().optional().describe("NXT denoise 0..1"), detail: z.number().optional().describe("NXT detail 0..1"), params: Params, checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("denoise", { ...a, method: a.method === "auto" ? undefined : a.method, ...ck(a.checkpoint) }, 3_600_000),
  });

  defineTool(server, {
    name: "remove_stars",
    description: "StarXTerminator / StarNet2 → starless view (in place) + stars view. Returns NOT_INSTALLED if neither exists (this rig: none installed). Checkpoints first.",
    input: { id: z.string(), stars_image: z.boolean().optional(), unscreen: z.boolean().optional(), linear: z.boolean().optional(), params: Params, checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("remove_stars", { ...a, ...ck(a.checkpoint) }, 3_600_000),
  });

  defineTool(server, {
    name: "stretch",
    description:
      "Linear → non-linear. method: 'sts' (AutoSTF made permanent; target_background 0.25 default, shadows_clip -2.8), 'arcsinh' (colour-preserving, stretch factor), 'masked' (MaskedStretch, star-friendly), 'mas' (MultiscaleAdaptiveStretch), 'ht' (manual shadows/midtones/highlights), 'ghs' if installed. Checkpoints first. Check clipped-black % afterwards.",
    input: { id: z.string(), method: z.enum(["sts", "arcsinh", "masked", "mas", "ht", "ghs"]).optional(), target_background: z.number().optional(), shadows_clip: z.number().optional(), linked: z.boolean().optional(), hard: z.boolean().optional(), stretch: z.number().optional().describe("arcsinh factor"), black_point: z.number().optional(), iterations: z.number().int().optional(), aggressiveness: z.number().optional(), shadows: z.number().optional(), midtones: z.number().optional(), highlights: z.number().optional(), params: Params, checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("stretch", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "curves",
    description: "CurvesTransformation: explicit curves per channel ({K:[[0,0],[0.3,0.35],[1,1]], S:…}) or convenience contrast (-1..1) / brightness (-1..1). Non-linear stage. Checkpoints first.",
    input: { id: z.string(), curves: z.record(z.array(z.tuple([z.number(), z.number()]))).optional(), contrast: z.number().optional(), brightness: z.number().optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("curves", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "saturation",
    description: "ColorSaturation boost (amount -1..1, default 0.3) or explicit hue curve. Non-linear stage. Checkpoints first.",
    input: { id: z.string(), amount: z.number().optional(), curve: z.array(z.tuple([z.number(), z.number()])).optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("saturation", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "resample",
    description: "Resize by factor (integer downsample uses IntegerResample average) or to width×height. Checkpoints first.",
    input: { id: z.string(), factor: z.number().optional(), width: z.number().int().optional(), height: z.number().int().optional(), interpolation: z.string().optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("resample", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "rotate",
    description: "Rotate the view: 90/180/270 lossless (FastRotation) or any angle (Rotation, resampled). Drops the astrometric solution, so do it after plate_solve/SPCC. Checkpoints first.",
    input: { id: z.string(), angle: z.number(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("rotate", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "crop",
    description: "Crop to rect [x, y, w, h]. Checkpoints first.",
    input: { id: z.string(), rect: z.tuple([z.number(), z.number(), z.number(), z.number()]), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("crop", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "auto_crop",
    description: "Trim registration edges: finds rows/columns with > max_zero_fraction zero pixels and crops them (+pad). dry_run reports the rect only. Checkpoints first.",
    input: { id: z.string(), max_zero_fraction: z.number().optional(), pad: z.number().int().optional(), threshold: z.number().optional(), dry_run: z.boolean().optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("auto_crop", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "pixel_math",
    description: "PixelMath expression on a view ($T = target; other view ids usable). new_id creates a new image instead of replacing. Checkpoints first when in place.",
    input: { id: z.string(), expression: z.string(), expression_g: z.string().optional(), expression_b: z.string().optional(), rescale: z.boolean().optional(), truncate: z.boolean().optional(), new_id: z.string().optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("pixel_math", { ...a, ...ck(a.new_id ? false : a.checkpoint) }),
  });

  defineTool(server, {
    name: "linear_fit",
    description: "LinearFit the view to a reference view (match channel/sessions). Checkpoints first.",
    input: { id: z.string(), reference_id: z.string(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("linear_fit", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "sharpen",
    description: "UnsharpMask (luminance, deringing) for the non-linear stage; gentle defaults sigma 2 amount 0.6. Checkpoints first.",
    input: { id: z.string(), sigma: z.number().optional(), amount: z.number().optional(), deringing_dark: z.number().optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("unsharp_mask", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "hdr_compress",
    description: "HDRMultiscaleTransform to recover bright cores (galaxy cores, nebula centres) on a non-linear image. Checkpoints first.",
    input: { id: z.string(), layers: z.number().int().optional(), iterations: z.number().int().optional(), params: Params, checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("hdr", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "local_contrast",
    description: "LocalHistogramEqualization (non-linear). Checkpoints first.",
    input: { id: z.string(), radius: z.number().int().optional(), slope_limit: z.number().optional(), amount: z.number().optional(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("lhe", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "combine_stars",
    description: "Screen-blend a stars image back onto a starless image (PixelMath), optionally into a new view.",
    input: { starless_id: z.string(), stars_id: z.string(), star_boost: z.number().optional(), new_id: z.string().optional() },
    destructive: true,
    handler: async (a) => run("combine_stars", a),
  });

  defineTool(server, {
    name: "extract_channels",
    description: "ChannelExtraction (RGB / CIE L / …) into new views.",
    input: { id: z.string(), color_space: z.string().optional(), channels: z.array(z.string()).optional(), prefix: z.string().optional() },
    handler: async (a) => run("extract_channels", a),
  });

  defineTool(server, {
    name: "convert_to_gray",
    description: "Convert a view to grayscale in place. Checkpoints first.",
    input: { id: z.string(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("convert_to_gray", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "invert",
    description: "Invert a view (useful on masks). Checkpoints first.",
    input: { id: z.string(), checkpoint: Ckpt },
    destructive: true,
    handler: async (a) => run("invert", { ...a, ...ck(a.checkpoint) }),
  });
}
