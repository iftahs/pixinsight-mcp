// Smoke test client: spawns the server over stdio and calls tools. Usage: npx tsx scripts/smoke.ts [tool] [jsonArgs]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], cwd: process.cwd(), stderr: "inherit" });
  const client = new Client({ name: "smoke", version: "0.0.1" });
  await client.connect(transport);
  const [tool, argsJson] = process.argv.slice(2);
  if (!tool) {
    const tools = await client.listTools();
    console.log(`${tools.tools.length} tools:`, tools.tools.map((t) => t.name).join(", "));
  } else {
    const t0 = Date.now();
    const r = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} }, undefined, { timeout: 1_800_000 });
    for (const c of (r as { content: Array<{ type: string; text?: string; data?: string }> }).content) {
      if (c.type === "text") console.log(c.text);
      else if (c.type === "image") console.log(`[image ${Math.round((c.data?.length ?? 0) * 0.75 / 1024)} KB]`);
    }
    console.log(`(${Date.now() - t0} ms)`);
  }
  await client.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
