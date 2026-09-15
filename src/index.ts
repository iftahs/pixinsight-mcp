#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppContext } from "./context.js";
import { registerSessionTools } from "./tools/session.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerInspectionTools } from "./tools/inspection.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerCalibrationTools } from "./tools/calibration.js";
import { registerStackingTools } from "./tools/stacking.js";
import { registerPostprocessTools } from "./tools/postprocess.js";
import { registerMaskTools } from "./tools/masks.js";
import { registerPipelineTools } from "./tools/pipeline.js";
import { registerReviewTools } from "./tools/review.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { writeGeneratedIncludes } from "./bridge/generated.js";

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: "pixinsight-mcp", version: "0.1.0" },
    {
      instructions:
        "PixInsight control for astrophotography. Start with pi_status, then scan_frames → match_calibration (show the plan to the user) → blink_frames (look, exclude_frames bad subs) → pipeline_run (WBPP engine by default; working files in <target>/working-files, intermediates deleted) or the manual chain (build_master_* → calibrate_lights → cosmetic_correction → debayer → measure_subframes → select_subframes → register → local_normalization → integrate). " +
        "Long operations return job_id: poll job_status / job_wait, never block. After every processing step call render_preview and image_statistics and LOOK at the result. Destructive tools checkpoint first; roll back with restore_checkpoint. Read resource pi://skill for the full workflow guide.",
    },
  );
  registerSessionTools(server, ctx);
  registerJobTools(server, ctx);
  registerInventoryTools(server, ctx);
  registerInspectionTools(server, ctx);
  registerCalibrationTools(server, ctx);
  registerStackingTools(server, ctx);
  registerPostprocessTools(server, ctx);
  registerMaskTools(server, ctx);
  registerPipelineTools(server, ctx);
  registerReviewTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}

async function main(): Promise<void> {
  const ctx = new AppContext();
  writeGeneratedIncludes(ctx.cfg);
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`pixinsight-mcp ready (workdir ${ctx.cfg.workdir}, config ${ctx.cfg.configSource})\n`);
}

const isMain = process.argv[1] && /index\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`pixinsight-mcp failed to start: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
