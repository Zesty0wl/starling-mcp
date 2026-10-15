import { homedir } from "node:os";
import { join } from "node:path";

export type Environment = "production" | "sandbox";

/** Which tools are registered. Each tier includes the ones before it. */
export type AccessTier = "read" | "write" | "payments";

export interface Config {
  environment: Environment;
  baseUrl: string;
  tier: AccessTier;
  /** Largest single external payment / standing order amount allowed, in minor units. */
  paymentLimitMinorUnits: number | undefined;
  /** How dangerous calls are confirmed. */
  confirmation: "auto" | "elicit" | "token";
  signingKeyUid: string | undefined;
  signingKeyPath: string;
  auditLogPath: string | undefined;
  downloadDir: string;
  requestsPerSecond: number;
  defaultAccountUid: string | undefined;
}

/** The only hosts this server will ever talk to. */
export const BASE_URLS: Record<Environment, string> = {
  production: "https://api.starlingbank.com",
  sandbox: "https://api-sandbox.starlingbank.com",
};

export const CONFIG_DIR = join(homedir(), ".config", "starling-mcp");
export const STATE_DIR = join(homedir(), ".local", "state", "starling-mcp");
export const KEYCHAIN_SERVICE = "starling-mcp";

function flag(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const environment = (env.STARLING_ENVIRONMENT ?? "production").toLowerCase();
  if (environment !== "production" && environment !== "sandbox") {
    throw new Error(`STARLING_ENVIRONMENT must be "production" or "sandbox", got "${environment}"`);
  }

  let tier: AccessTier = "read";
  if (flag(env.STARLING_ENABLE_WRITES)) tier = "write";
  if (flag(env.STARLING_ENABLE_PAYMENTS)) {
    if (tier !== "write") {
      throw new Error("STARLING_ENABLE_PAYMENTS requires STARLING_ENABLE_WRITES=true as well");
    }
    tier = "payments";
  }

  let paymentLimitMinorUnits: number | undefined;
  if (env.STARLING_PAYMENT_LIMIT_MINOR_UNITS) {
    paymentLimitMinorUnits = Number(env.STARLING_PAYMENT_LIMIT_MINOR_UNITS);
    if (!Number.isSafeInteger(paymentLimitMinorUnits) || paymentLimitMinorUnits < 0) {
      throw new Error("STARLING_PAYMENT_LIMIT_MINOR_UNITS must be a non-negative integer (e.g. 50000 for £500)");
    }
  }

  const confirmation = (env.STARLING_CONFIRMATION ?? "auto").toLowerCase();
  if (confirmation !== "auto" && confirmation !== "elicit" && confirmation !== "token") {
    throw new Error(`STARLING_CONFIRMATION must be "auto", "elicit" or "token", got "${confirmation}"`);
  }

  const audit = env.STARLING_AUDIT_LOG?.trim();
  const auditLogPath =
    audit && ["off", "false", "0", "none"].includes(audit.toLowerCase())
      ? undefined
      : expandHome(audit || join(STATE_DIR, "audit.log"));

  const requestsPerSecond = Number(env.STARLING_REQUESTS_PER_SECOND ?? 5);
  if (!(requestsPerSecond > 0)) throw new Error("STARLING_REQUESTS_PER_SECOND must be positive");

  return {
    environment,
    baseUrl: BASE_URLS[environment],
    tier,
    paymentLimitMinorUnits,
    confirmation,
    signingKeyUid: env.STARLING_SIGNING_KEY_UID?.trim() || undefined,
    signingKeyPath: expandHome(env.STARLING_SIGNING_KEY_PATH ?? join(CONFIG_DIR, "keys", "starling-api-private.key")),
    auditLogPath,
    downloadDir: expandHome(env.STARLING_DOWNLOAD_DIR ?? join(homedir(), "Downloads", "starling")),
    requestsPerSecond,
    defaultAccountUid: env.STARLING_DEFAULT_ACCOUNT_UID?.trim() || undefined,
  };
}

export function tierAllows(config: Config, required: AccessTier): boolean {
  const order: AccessTier[] = ["read", "write", "payments"];
  return order.indexOf(config.tier) >= order.indexOf(required);
}
