import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { defineTool } from "./registry.js";
import { WbppRunner } from "../wbpp.js";
import { loadScan, groupById } from "./inventory.js";
import { BridgeError } from "../bridge/types.js";

export function registerPipelineTools(server: McpServer, ctx: AppContext): void {
  const wbpp = new WbppRunner(ctx.cfg);

  defineTool(server, {
    name: "pipeline_run",
    description:
      "One call from raw lights to a master light. engine 'wbpp' (default): PixInsight's WeightedBatchPreprocessing in a separate instance with exactly the matched calibration groups, then the master is opened in the daemon and WBPP intermediates are deleted. engine 'native': plan → masters (cached) → calibrate → cosmetic (CFA) → debayer → measure → select (SSWEIGHT) → register (+drizzle data) → local normalization → integrate [→ drizzle]. Frames dropped with exclude_frames (after blink_frames) are honoured. Working files go to <target dir>/working-files. REFUSES with NEEDS_CONFIRMATION when match_calibration reports mismatched/missing calibration (dark temperature, dark scaling, flats) until the user has been told and acknowledge_warnings:true is passed. Runs in the background; poll pipeline_status. Resumable with resume_id.",
    input: {
      light_group_id: z.string().optional().describe("From scan_frames (required unless resume_id)"),
      resume_id: z.string().optional(),
      engine: z.enum(["wbpp", "native"]).optional().describe("Default: config stackingEngine (wbpp)"),
      wbpp_params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("WBPP automation parameters, e.g. {autocrop:true, localNormalization:false}"),
      exclude_files: z.array(z.string()).optional(),
      allow_dark_scaling: z.boolean().optional(),
      force: z.boolean().optional().describe("Proceed despite blocking plan issues (e.g. no flats when requireFlats)"),
      skip_cosmetic: z.boolean().optional(),
      skip_local_normalization: z.boolean().optional(),
      drizzle: z.boolean().optional(),
      drizzle_scale: z.union([z.literal(1), z.literal(2)]).optional(),
      fwhm_factor: z.number().optional().describe("Reject FWHM > factor×median (default 1.25)"),
      max_eccentricity: z.number().optional(),
      min_stars: z.number().optional(),
      rejection: z.string().optional(),
      debayer_method: z.enum(["VNG", "SuperPixel", "Bilinear"]).optional(),
      master_dark: z.string().optional(),
      master_flat: z.string().optional(),
      master_bias: z.string().optional(),
      rejection_warn_pct: z.number().optional(),
      max_frames: z.number().int().min(3).optional().describe("Only the first N lights (quick end-to-end smoke test)"),
      keep_intermediates: z.boolean().optional().describe("Keep calibrated/cosmetic/debayered/weighted/registered files (default: config keepIntermediates=false: deleted as soon as the next stage succeeds)"),
      acknowledge_warnings: z.boolean().optional().describe("Set only after the user has seen match_calibration.needs_confirmation and said to proceed"),
    },
    handler: async (a) => {
      if (!a.resume_id && !a.light_group_id) throw new BridgeError("BAD_ARGS", "light_group_id or resume_id required");
      if (ctx.bridge.activeLongJob()) throw new BridgeError("PI_BUSY", `job ${ctx.bridge.activeLongJob()!.id} is running; wait or cancel it first`);
      const st = await ctx.pipelines.start({ ...a, light_group_id: a.light_group_id ?? "" } as never, a.resume_id);
      return { pipeline_id: st.id, status: st.status, work_dir: st.work_dir, stages: st.stages.map((s) => s.name), plan_warnings: st.plan?.warnings, note: "running in background; poll pipeline_status every 30–60 s and relay progress to the user" };
    },
  });

  defineTool(server, {
    name: "pipeline_status",
    description: "Progress of a pipeline_run: current stage, per-stage status, live job progress, warnings, master light path/view id, integration rejection stats.",
    input: { pipeline_id: z.string().optional().describe("Default: most recent pipeline in the session") },
    readOnly: true,
    handler: async ({ pipeline_id }) => {
      const id = pipeline_id ?? ctx.pipelines.list().sort().pop();
      if (!id) throw new BridgeError("PIPELINE_NOT_FOUND", "no pipeline in this session");
      return ctx.pipelines.status(id);
    },
  });

  defineTool(server, {
    name: "wbpp_run",
    description:
      "Cross-check: run PixInsight's own WeightedBatchPreprocessing (WBPP) in a separate PixInsight instance on a light group + calibration groups, fully automated. Slow (whole pipeline) but independent — compare its master light to ours with image_statistics/measure_stars. Extra WBPP parameters can be passed as params using WBPP automation names (e.g. generateRejectionMaps, darkExposureTolerance, smartNamingOverride).",
    input: { light_group_id: z.string().optional(), dirs: z.array(z.string()).optional().describe("Directories to add (all frame types inside)"), files: z.array(z.string()).optional(), calibration_group_ids: z.array(z.string()).optional(), output_dir: z.string().optional(), params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional() },
    handler: async (a) => {
      const files = [...(a.files ?? [])];
      if (a.light_group_id || a.calibration_group_ids?.length) {
        const scan = await loadScan(ctx);
        if (!scan) throw new BridgeError("NO_SCAN", "run scan_frames first");
        for (const id of [a.light_group_id, ...(a.calibration_group_ids ?? [])].filter(Boolean) as string[]) files.push(...groupById(scan, id).files);
      }
      if (!files.length && !a.dirs?.length) throw new BridgeError("BAD_ARGS", "give light_group_id/calibration_group_ids, files or dirs");
      const outDir = a.output_dir ?? ctx.sessions.workPath("wbpp");
      ctx.safety.assertWritable(outDir);
      const run = wbpp.start({ dirs: a.dirs, files, output_dir: outDir, params: a.params });
      return { wbpp_id: run.id, pid: run.pid, output_dir: outDir, frames: files.length, note: "separate PixInsight instance launched; poll wbpp_status (expect 20–60 min for 30 frames)" };
    },
  });

  defineTool(server, {
    name: "wbpp_status",
    description: "Status of a wbpp_run (running/ok/error, log tail, master light paths).",
    input: { wbpp_id: z.string() },
    readOnly: true,
    handler: async ({ wbpp_id }) => wbpp.status(wbpp_id),
  });
}
