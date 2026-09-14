// Long-lived client: run pipeline_run and poll pipeline_status until done.
// Usage: npx tsx scripts/pipeline-smoke.ts '{"light_group_id":"light_01","max_frames":4}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const txt = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === "text")?.text ?? "");
async function main() {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], cwd: process.cwd(), stderr: "inherit" });
  const client = new Client({ name: "pipeline-smoke", version: "0.0.1" });
  await client.connect(transport);
  const args = JSON.parse(process.argv[2] ?? "{}");
  if (!args.resume_id) await client.callTool({ name: "scan_frames", arguments: {} });
  const start = JSON.parse(txt(await client.callTool({ name: "pipeline_run", arguments: args })));
  console.log("started", JSON.stringify(start));
  if (start.error) { await client.close(); process.exit(1); }
  const t0 = Date.now();
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 15000));
    const st = JSON.parse(txt(await client.callTool({ name: "pipeline_status", arguments: { pipeline_id: start.pipeline_id } })));
    const line = `${Math.round((Date.now() - t0) / 1000)}s ${st.status} stage=${st.stage} ${st.stages_done} ${st.progress ? JSON.stringify(st.progress) : ""}`;
    if (line !== last) console.log(line);
    last = line;
    if (st.status !== "running") { console.log(JSON.stringify(st, null, 1)); break; }
  }
  await client.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
