import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool } from "./registry.js";
import { piPath } from "../util/fsx.js";

export function registerMaskTools(server: McpServer, ctx: AppContext): void {
  const run = (op: string, args: Record<string, unknown>) => ctx.bridge.runOrDefer(op, args, { timeoutMs: 1_800_000, deferAfterMs: 45_000 });
  const ck = (checkpoint?: boolean) => ({ checkpoint_dir: piPath(ctx.sessions.ensure().checkpoints), checkpoint: checkpoint ?? true });

  defineTool(server, {
    name: "star_mask",
    description: "StarMask process → new mask view (mask_id). Use with apply_mask to protect stars during stretches/sharpening.",
    input: { id: z.string(), mask_id: z.string().optional(), layers: z.number().int().optional(), noise_threshold: z.number().optional(), large_growth: z.number().int().optional(), small_growth: z.number().int().optional(), smoothness: z.number().int().optional(), midtones: z.number().optional(), shadows: z.number().optional(), params: z.record(z.unknown()).optional() },
    handler: async (a) => run("star_mask", a),
  });

  defineTool(server, {
    name: "range_mask",
    description: "Luminance range mask (RangeSelection on a stretched gray copy): low/high 0..1, fuzziness, smoothness, invert. Returns mask_id (new view).",
    input: { id: z.string(), mask_id: z.string().optional(), low: z.number().optional(), high: z.number().optional(), fuzziness: z.number().optional(), smoothness: z.number().optional(), invert: z.boolean().optional(), stretch: z.boolean().optional() },
    handler: async (a) => run("range_mask", a),
  });

  defineTool(server, {
    name: "pixelmath_mask",
    description: "Mask from a PixelMath expression evaluated on the view ($T), e.g. 'iif($T>0.2,1,0)'. Returns mask_id.",
    input: { id: z.string(), expression: z.string(), mask_id: z.string().optional(), rescale: z.boolean().optional() },
    handler: async (a) => run("pixelmath_mask", a),
  });

  defineTool(server, {
    name: "apply_mask",
    description: "Attach (or remove with remove:true) a mask view to an image window; subsequent processes on that view are masked. inverted:true protects where the mask is bright.",
    input: { id: z.string(), mask_id: z.string().optional(), inverted: z.boolean().optional(), visible: z.boolean().optional(), remove: z.boolean().optional() },
    handler: async (a) => run("apply_mask", a),
  });

  defineTool(server, {
    name: "mask_info",
    description: "Which mask (if any) is attached to a window and whether it is enabled/inverted.",
    input: { id: z.string() },
    readOnly: true,
    handler: async (a) => run("mask_info", a),
  });

  defineTool(server, {
    name: "binarize",
    description: "Binarize a (mask) view at a threshold. Checkpoints first.",
    input: { id: z.string(), threshold: z.number().optional(), checkpoint: z.boolean().optional() },
    destructive: true,
    handler: async (a) => run("binarize", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "morphology",
    description: "MorphologicalTransformation (Dilation/Erosion/Opening/Closing/Median) — grow/shrink masks. Checkpoints first.",
    input: { id: z.string(), operator: z.enum(["Dilation", "Erosion", "Opening", "Closing", "Median", "Selection", "Midpoint"]).optional(), size: z.number().int().optional(), iterations: z.number().int().optional(), amount: z.number().optional(), checkpoint: z.boolean().optional() },
    destructive: true,
    handler: async (a) => run("morphology", { ...a, ...ck(a.checkpoint) }),
  });

  defineTool(server, {
    name: "blur",
    description: "Gaussian convolution (soften masks). Checkpoints first.",
    input: { id: z.string(), sigma: z.number().optional(), checkpoint: z.boolean().optional() },
    destructive: true,
    handler: async (a) => run("convolve", { ...a, ...ck(a.checkpoint) }),
  });
}
