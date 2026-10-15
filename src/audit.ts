import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEntry {
  tool: string;
  outcome: "success" | "error" | "declined" | "awaiting_confirmation";
  /** Non-secret facts about the action: UIDs, amounts, references. Never tokens. */
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * Append-only local record of every state-changing call, so you can see
 * exactly what was done to your account through this server.
 */
export class AuditLog {
  private ready: Promise<void> | undefined;

  constructor(private readonly path: string | undefined) {}

  async record(entry: AuditEntry): Promise<void> {
    if (!this.path) return;
    const path = this.path;
    try {
      this.ready ??= mkdir(dirname(path), { recursive: true, mode: 0o700 }).then(() => undefined);
      await this.ready;
      await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    } catch (err) {
      process.stderr.write(`starling-mcp: could not write audit log: ${(err as Error).message}\n`);
    }
  }
}
