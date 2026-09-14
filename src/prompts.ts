import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context.js";
import { loadSkill } from "./resources.js";

export function registerPrompts(server: McpServer, ctx: AppContext): void {
  server.registerPrompt(
    "process-session",
    {
      title: "Process an imaging session end to end",
      description: "Inventory → calibration plan (confirm with user) → stacking → post-processing with previews between steps.",
      argsSchema: { root: z.string().optional().describe("Folder with lights/darks/flats/bias (default: config dataRoot)"), target: z.string().optional().describe("Target name to pick when several light groups exist") },
    },
    ({ root, target }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Process the astrophotography data in ${root ?? ctx.cfg.dataRoot ?? "<dataRoot>"}${target ? ` (target: ${target})` : ""} through the PixInsight MCP server.\n\n` +
              `Follow this skill:\n\n${loadSkill()}\n\n` +
              `Start with pi_status and scan_frames. Show me the calibration plan from match_calibration and wait for my confirmation before pipeline_run. ` +
              `Poll pipeline_status and keep me informed. After the master light exists: render_preview, image_statistics, measure_stars, then the linear post-processing chain, looking at a preview after every step.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "inspect-frame",
    { title: "Judge a single frame", description: "Open a raw frame, preview it, measure stars, and report whether it is usable.", argsSchema: { path: z.string() } },
    ({ path }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Open ${path} with open_image, render_preview (stretch stf), measure_stars and image_statistics. Tell me: focus (FWHM), tracking (eccentricity), gradients/clouds, satellite trails, whether the frame is usable, and what to change at capture time.` } }],
    }),
  );
}
