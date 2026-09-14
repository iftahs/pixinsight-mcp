import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import fs from "node:fs";
import { BridgeError } from "../bridge/types.js";

export type ToolResult = CallToolResult;

export function text(data: unknown): ToolResult {
  const t = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: t }] };
}

/** Result with an inline JPEG (the agent can look at it) plus JSON metadata. */
export function imageResult(jpegPath: string, meta: unknown): ToolResult {
  const b64 = fs.readFileSync(jpegPath).toString("base64");
  return {
    content: [
      { type: "image", data: b64, mimeType: "image/jpeg" },
      { type: "text", text: JSON.stringify(meta, null, 2) },
    ],
  };
}

export function errorResult(e: unknown): ToolResult {
  const err = e as Error & { code?: string; details?: unknown };
  const body: Record<string, unknown> = {
    error: err?.code ?? (e instanceof BridgeError ? e.code : "ERROR"),
    message: err?.message ?? String(e),
  };
  if (e instanceof BridgeError && e.details) body.details = e.details;
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}

export interface ToolDef<S extends ZodRawShape> {
  name: string;
  title?: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (args: { [K in keyof S]: S[K]["_output"] }) => Promise<ToolResult | unknown>;
}

/** Register a tool with uniform error handling; handlers may return plain data (→ JSON text). */
export function defineTool<S extends ZodRawShape>(server: McpServer, def: ToolDef<S>): void {
  server.registerTool(
    def.name,
    {
      title: def.title ?? def.name,
      description: def.description,
      inputSchema: def.input,
      annotations: { readOnlyHint: !!def.readOnly, destructiveHint: !!def.destructive, openWorldHint: false },
    },
    (async (args: { [K in keyof S]: S[K]["_output"] }) => {
      try {
        const r = await def.handler(args);
        if (r && typeof r === "object" && "content" in (r as object)) return r as ToolResult;
        return text(r);
      } catch (e) {
        return errorResult(e);
      }
    }) as never,
  );
}
