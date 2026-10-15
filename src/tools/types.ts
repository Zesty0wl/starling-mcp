import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AccountResolver } from "../accounts.js";
import type { AuditLog } from "../audit.js";
import { StarlingApiError, type StarlingClient } from "../client.js";
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

/** Compact JSON (no indentation): models read it equally well and it costs far less context. */
export function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data ?? { success: true }) }] };
}

/** Removes null, undefined and empty-string fields so list output stays small. */
export function prune<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== ""),
  ) as Partial<T>;
}

/** Resolves to undefined when Starling answers 404 (e.g. no photo has been set). */
export async function orNotFound<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof StarlingApiError && err.status === 404) return undefined;
    throw err;
  }
}

export function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

export function done(message: string, data?: unknown): CallToolResult {
  return data === undefined || data === null || data === ""
    ? text(message)
    : { content: [{ type: "text", text: `${message}\n${JSON.stringify(data)}` }] };
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
