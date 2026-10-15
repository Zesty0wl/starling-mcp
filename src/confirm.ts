import { createHash, randomInt } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";

const CODE_TTL_MS = 5 * 60 * 1000;

export type ConfirmOutcome =
  | { status: "confirmed" }
  | { status: "declined"; message: string }
  | { status: "pending"; message: string };

interface Pending {
  fingerprint: string;
  expires: number;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Human-in-the-loop confirmation for actions that move money or are hard to undo.
 *
 * - "elicit": the MCP client shows the user a confirmation form directly. The
 *   model cannot answer it, so this is the strongest guard against prompt
 *   injection (e.g. instructions hidden in a transaction reference).
 * - "token": for clients without elicitation. The first call returns a preview
 *   and a one-time code; the identical call must be repeated with that code
 *   within 5 minutes. Any change to the arguments invalidates the code.
 */
export class Confirmer {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly server: McpServer,
    private readonly config: Config,
  ) {}

  elicitationSupported(): boolean {
    const caps = this.server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
    if (!caps) return false;
    // An empty object means form mode (spec default); url-only clients cannot show a form.
    return Object.keys(caps).length === 0 || "form" in caps;
  }

  get mode(): "elicit" | "token" {
    if (this.config.confirmation === "auto") return this.elicitationSupported() ? "elicit" : "token";
    return this.config.confirmation;
  }

  async confirm(
    tool: string,
    summary: string,
    args: Record<string, unknown>,
    confirmationCode: string | undefined,
  ): Promise<ConfirmOutcome> {
    if (this.mode === "elicit") {
      if (!this.elicitationSupported()) {
        return {
          status: "declined",
          message:
            "STARLING_CONFIRMATION=elicit, but this MCP client does not support elicitation, so the action cannot be confirmed. Nothing was done.",
        };
      }
      const result = await this.server.server.elicitInput({
        mode: "form",
        message: `Starling: please confirm\n\n${summary}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: "Yes, do this", description: "Tick to approve this action" },
          },
          required: ["confirm"],
        },
      });
      if (result.action === "accept" && result.content?.confirm === true) return { status: "confirmed" };
      return { status: "declined", message: "The user did not approve this action. Nothing was done." };
    }

    const fingerprint = createHash("sha256")
      .update(`${tool}\n${canonical(args)}`)
      .digest("hex");
    const now = Date.now();
    for (const [code, p] of this.pending) if (p.expires < now) this.pending.delete(code);

    if (confirmationCode) {
      const p = this.pending.get(confirmationCode);
      // Any use burns the code, so a mismatched or guessed attempt cannot be retried.
      this.pending.delete(confirmationCode);
      if (p && p.fingerprint === fingerprint) return { status: "confirmed" };
      return {
        status: "declined",
        message:
          "That confirmation code is invalid, expired, already used, or the arguments changed since it was issued. Nothing was done. Call again without confirmationCode to get a fresh preview.",
      };
    }

    const code = String(randomInt(100000, 1000000));
    this.pending.set(code, { fingerprint, expires: now + CODE_TTL_MS });
    return {
      status: "pending",
      message:
        `CONFIRMATION REQUIRED. Nothing has been done yet.\n\n${summary}\n\n` +
        `Show these details to the user and ask for their explicit approval. Only if they approve, ` +
        `call ${tool} again with exactly the same arguments plus confirmationCode "${code}" (valid 5 minutes, single use).`,
    };
  }
}
