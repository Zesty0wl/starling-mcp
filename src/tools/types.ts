import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AccountResolver } from "../accounts.js";
import type { AuditLog } from "../audit.js";
import type { StarlingClient } from "../client.js";
import type { AccessTier, Config } from "../config.js";
import type { Confirmer } from "../confirm.js";

export interface ToolContext {
  client: StarlingClient;
  config: Config;
  accounts: AccountResolver;
  confirmer: Confirmer;
  audit: AuditLog;
  server: McpServer;
}

/** Thrown inside a tool to stop with a non-error message (e.g. awaiting confirmation). */
export class ToolStop extends Error {
  constructor(
    message: string,
    readonly outcome: "declined" | "awaiting_confirmation",
  ) {
    super(message);
  }
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Lowest access tier at which this tool is registered. */
  tier: AccessTier;
  /** Starling OpenAPI operationIds this tool calls; used by the spec coverage check. */
  operations: string[];
  /** Adds the optional confirmationCode argument and requires human confirmation. */
  confirm?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  input: S;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<CallToolResult>;
  /** Facts for the audit log; defaults to the arguments. */
  auditDetails?(args: z.infer<z.ZodObject<S>>): Record<string, unknown>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data ?? { success: true }, null, 2) }] };
}

export function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

export function done(message: string, data?: unknown): CallToolResult {
  return data === undefined || data === null || data === ""
    ? text(message)
    : { content: [{ type: "text", text: `${message}\n${JSON.stringify(data, null, 2)}` }] };
}

export function image(base64: string, mimeType: string, caption?: string): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "image", data: base64, mimeType }];
  if (caption) content.push({ type: "text", text: caption });
  return { content };
}

/**
 * Runs human confirmation for a dangerous action; throws ToolStop unless approved.
 */
export async function requireConfirmation(
  ctx: ToolContext,
  tool: string,
  summary: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { confirmationCode, ...rest } = args as { confirmationCode?: string };
  const outcome = await ctx.confirmer.confirm(tool, summary, rest, confirmationCode);
  if (outcome.status === "confirmed") return;
  throw new ToolStop(outcome.message, outcome.status === "pending" ? "awaiting_confirmation" : "declined");
}
