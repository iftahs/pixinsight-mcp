import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "../context.js";
import { SessionManager } from "../session.js";
import { defineTool, imageResult } from "./registry.js";
import { piPath, readJsonSafe, writeJsonAtomic } from "../util/fsx.js";
import { loadScan, groupById } from "./inventory.js";
import { BridgeError } from "../bridge/types.js";
import { writeProcessingLog } from "./catalog.js";

export interface BlinkMetric {
  index: number;
  file: string;
  median?: number;
  mad?: number;
  stars?: number;
  saturated?: number;
  gradient?: number;
  flags?: string[];
  suspect?: boolean;
  error?: string;
}

/** Frame review ("Blink") and project save tools. */
export function registerReviewTools(server: McpServer, ctx: AppContext): void {
  defineTool(server, {
    name: "blink_frames",
    description:
      "Blink-style review before stacking: renders a contact sheet of auto-stretched thumbnails for a light group (or file list) with per-frame background, star count, gradient and saturation, and flags suspects (clouds, dawn, trails, defocus). LOOK at the sheet, then pass the bad indexes to exclude_frames. Pages of up to 30 frames.",
    input: { group_id: z.string().optional(), files: z.array(z.string()).optional(), page: z.number().int().min(1).optional(), per_page: z.number().int().min(4).max(40).optional(), thumb: z.number().int().min(120).max(600).optional(), columns: z.number().int().min(2).max(8).optional(), job_id: z.string().optional().describe("Finalize a deferred blink job (after job_wait says ok)") },
    readOnly: true,
    handler: async (a) => {
      if (a.job_id) {
        // Deferred run: pick up the finished job's data and finish the bookkeeping.
        const jr = await ctx.bridge.refresh(a.job_id);
        if (jr.status !== "ok") return { job_id: a.job_id, status: jr.status, progress: jr.progress, error: jr.error, note: "not finished yet; job_wait then call blink_frames { job_id } again" };
        const d = jr.data as { path: string; metrics: BlinkMetric[]; group: unknown };
        const pending = await readJsonSafe<{ group_id?: string; files: string[]; page: number; per: number }>(path.join(ctx.sessions.ensure().root, "blink-pending.json"));
        const offset = pending ? (pending.page - 1) * pending.per : 0;
        const metrics = d.metrics.map((m) => ({ ...m, index: m.index + offset, file: path.basename(m.file) }));
        const store = path.join(ctx.sessions.ensure().root, "blink.json");
        const prev = (await readJsonSafe<{ group_id?: string; files: string[]; metrics: BlinkMetric[] }>(store)) ?? { group_id: pending?.group_id, files: pending?.files ?? [], metrics: [] };
        if (pending) { prev.files = pending.files; prev.group_id = pending.group_id; }
        prev.metrics = [...prev.metrics.filter((m) => !metrics.some((n) => n.index === m.index)), ...metrics].sort((x, y) => x.index - y.index);
        await writeJsonAtomic(store, prev);
        const suspects = metrics.filter((m) => m.suspect);
        return imageResult(d.path, { page: pending?.page ?? 1, total_frames: prev.files.length, group: d.group, suspects: suspects.map((m) => ({ index: m.index, file: m.file, flags: m.flags })), metrics, note: "red-framed thumbnails are suspects; decide visually, then exclude_frames { indexes }" });
      }
      let files = a.files;
      if (!files?.length) {
        const scan = await loadScan(ctx);
        if (!scan || !a.group_id) throw new BridgeError("BAD_ARGS", "group_id (after scan_frames) or files required");
        const g = groupById(scan, a.group_id);
        files = g.files;
        if (ctx.cfg.workLayout === "target" && !ctx.sessions.get()?.target_dir) {
          const work = ctx.sessions.useTargetDir(SessionManager.targetDirOf(g.dir), ctx.cfg.workingDirName);
          ctx.safety.allow(work);
        }
      }
      const per = a.per_page ?? 30;
      const page = a.page ?? 1;
      const slice = files.slice((page - 1) * per, page * per);
      const offset = (page - 1) * per;
      const out = ctx.sessions.previewPath(`blink_${a.group_id ?? "files"}_p${page}_${Date.now()}.jpg`);
      await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "blink-pending.json"), { group_id: a.group_id, files, page, per });
      const r = await ctx.bridge.runOrDefer<{ metrics: BlinkMetric[]; group: unknown }>("blink_contact_sheet", { files: slice.map(piPath), out_path: piPath(out), thumb: a.thumb ?? 300, columns: a.columns ?? 5 }, { timeoutMs: 1_800_000, deferAfterMs: 55_000 });
      if ((r as { deferred?: boolean }).deferred) return r;
      const d = r as { metrics: BlinkMetric[]; group: unknown };
      const metrics = d.metrics.map((m) => ({ ...m, index: m.index + offset, file: path.basename(m.file) }));
      // Persist for exclude_frames
      const store = path.join(ctx.sessions.ensure().root, "blink.json");
      const prev = (await readJsonSafe<{ group_id?: string; files: string[]; metrics: BlinkMetric[] }>(store)) ?? { group_id: a.group_id, files, metrics: [] };
      prev.files = files;
      prev.group_id = a.group_id;
      prev.metrics = [...prev.metrics.filter((m) => m.index < offset || m.index >= offset + per), ...metrics].sort((x, y) => x.index - y.index);
      await writeJsonAtomic(store, prev);
      const suspects = metrics.filter((m) => m.suspect);
      return imageResult(out, { page, pages: Math.ceil(files.length / per), frames_on_page: slice.length, total_frames: files.length, group: d.group, suspects: suspects.map((m) => ({ index: m.index, file: m.file, flags: m.flags })), metrics, note: "red-framed thumbnails are suspects; decide visually, then exclude_frames { indexes }" });
    },
  });

  defineTool(server, {
    name: "exclude_frames",
    description: "Drop frames (by blink index) from the light group before stacking. The exclusion list is applied by pipeline_run / stack. Pass an empty list to clear.",
    input: { indexes: z.array(z.number().int()), reason: z.string().optional() },
    handler: async ({ indexes, reason }) => {
      const store = path.join(ctx.sessions.ensure().root, "blink.json");
      const b = await readJsonSafe<{ group_id?: string; files: string[]; metrics: BlinkMetric[]; excluded?: number[] }>(store);
      if (!b) throw new BridgeError("NO_BLINK", "run blink_frames first");
      b.excluded = [...new Set(indexes)].filter((i) => i >= 0 && i < b.files.length);
      await writeJsonAtomic(store, b);
      await writeJsonAtomic(path.join(ctx.sessions.ensure().root, "exclusions.json"), { group_id: b.group_id, excluded_indexes: b.excluded, excluded_files: b.excluded.map((i) => b.files[i]), reason, updated_at: new Date().toISOString() });
      return { group_id: b.group_id, excluded: b.excluded.map((i) => ({ index: i, file: path.basename(b.files[i]) })), remaining: b.files.length - b.excluded.length };
    },
  });

  defineTool(server, {
    name: "save_project",
    description: "Save the processing 'project': the view as XISF (PixInsight embeds the processing history), companion views (masks/stars), every checkpoint reference and the tool history as manifest.json under <working-files>/project/, plus <working-files>/PROCESSING.md (human-readable log of every step). PixInsight .xosm projects cannot be written by scripts.",
    input: { id: z.string(), name: z.string().optional(), also_views: z.array(z.string()).optional() },
    handler: async ({ id, name, also_views }) => {
      const s = ctx.sessions.ensure();
      const dir = path.join(s.work, "project");
      ctx.safety.assertWritable(dir);
      const r = await ctx.bridge.run<{ main: string; companions: string[] }>("save_project", { id, dir: piPath(dir), name, also_views }, { timeoutMs: 600_000 });
      const history = (await readJsonSafe<unknown[]>(path.join(s.root, "history.json"))) ?? [];
      const checkpoints = fs.existsSync(s.checkpoints) ? fs.readdirSync(s.checkpoints).filter((f) => f.endsWith(".xisf")).map((f) => path.join(s.checkpoints, f)) : [];
      const manifest = { saved_at: new Date().toISOString(), session: s.id, target_dir: s.target_dir, main: r.main, companions: r.companions, checkpoints, history, pipeline: ctx.pipelines.list() };
      const mf = path.join(dir, `${(name ?? id).replace(/[^A-Za-z0-9_-]+/g, "_")}.manifest.json`);
      await writeJsonAtomic(mf, manifest);
      const log = await writeProcessingLog(ctx, name ? `Processing log — ${name}` : undefined);
      return { ...r, manifest: mf, processing_log: log.path, history_steps: history.length, checkpoints: checkpoints.length };
    },
  });
}
