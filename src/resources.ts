import fs from "node:fs";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppContext } from "./context.js";
import { readJsonSafe, tailFile } from "./util/fsx.js";

/** MCP resources: session state, previews, job logs, master library. */
export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    "session-state",
    "pi://session/current",
    { title: "Current session", description: "Current session state, last scan summary, selection, registration and integration results", mimeType: "application/json" },
    async (uri) => {
      const s = ctx.sessions.get();
      if (!s) return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ session: null }) }] };
      const read = (f: string) => readJsonSafe(path.join(s.root, f));
      const body = { session: s, scan_summary: (await read("scan.json").then((x) => (x as { summary?: unknown } | undefined)?.summary)) ?? null, selection: (await read("selection.json")) ?? null, registration: (await read("registration.json")) ?? null, integration: (await read("integration.json")) ?? null };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerResource(
    "previews",
    new ResourceTemplate("pi://previews/{name}", {
      list: async () => {
        const s = ctx.sessions.get();
        if (!s || !fs.existsSync(s.previews)) return { resources: [] };
        return { resources: fs.readdirSync(s.previews).filter((f) => f.endsWith(".jpg")).sort().slice(-50).map((f) => ({ uri: `pi://previews/${f}`, name: f, mimeType: "image/jpeg" })) };
      },
    }),
    { title: "Session previews", description: "Rendered JPEG previews of this session", mimeType: "image/jpeg" },
    async (uri, { name }) => {
      const s = ctx.sessions.ensure();
      const p = path.join(s.previews, String(name));
      const data = fs.readFileSync(p).toString("base64");
      return { contents: [{ uri: uri.href, mimeType: "image/jpeg", blob: data }] };
    },
  );

  server.registerResource(
    "job-log",
    new ResourceTemplate("pi://jobs/{id}/log", { list: async () => ({ resources: ctx.bridge.listJobs().slice(-50).map((j) => ({ uri: `pi://jobs/${j.id}/log`, name: `${j.op} ${j.id}`, mimeType: "text/plain" })) }) }),
    { title: "Job console logs", description: "PixInsight console output captured per job", mimeType: "text/plain" },
    async (uri, { id }) => {
      const j = ctx.bridge.getJob(String(id));
      const p = j?.log_path ?? path.join(ctx.cfg.workdir, "bridge", "logs", `${id}.log`);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: await tailFile(p, 200_000) }] };
    },
  );

  server.registerResource(
    "masters",
    "pi://masters",
    { title: "Master library", description: "Cached master bias/dark/flat frames with provenance", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ctx.masters.list(), null, 2) }] }),
  );

  server.registerResource(
    "skill",
    "pi://skill",
    { title: "Astro processing skill", description: "Agent-facing workflow guide for this server", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: loadSkill() }] }),
  );
}

export function loadSkill(): string {
  const candidates = [path.resolve(process.cwd(), "skill/SKILL.md"), path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../skill/SKILL.md")];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  return "SKILL.md not found";
}
