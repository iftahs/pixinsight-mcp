// Run WBPP cross-check and poll until done. Usage: npx tsx scripts/wbpp-smoke.ts '{"light_group_id":"light_01","calibration_group_ids":["dark_03"]}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const txt = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content.find((c) => c.type === "text")?.text ?? "");
async function main() {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], cwd: process.cwd(), stderr: "inherit" });
  const client = new Client({ name: "wbpp-smoke", version: "0.0.1" });
  await client.connect(transport);
  const start = JSON.parse(txt(await client.callTool({ name: "wbpp_run", arguments: JSON.parse(process.argv[2] ?? "{}") })));
  console.log("started", JSON.stringify(start));
  if (start.error) { await client.close(); process.exit(1); }
  for (;;) {
    await new Promise((r) => setTimeout(r, 30000));
    const st = JSON.parse(txt(await client.callTool({ name: "wbpp_status", arguments: { wbpp_id: start.wbpp_id } })));
    console.log(`${st.elapsed_s}s ${st.status} ${(st.log_tail ?? "").split("\n").filter((l: string) => l.trim()).slice(-1)[0]?.slice(0, 120) ?? ""}`);
    if (st.status !== "running") { console.log(JSON.stringify({ ...st, log_tail: (st.log_tail ?? "").slice(-3000) }, null, 1)); break; }
  }
  await client.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
