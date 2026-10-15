#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StarlingClient } from "./client.js";
import { type AccessTier, CONFIG_DIR, type Config, type Environment, loadConfig, tierAllows } from "./config.js";
import { assertPrivateFile, deleteToken, loadAccessToken, readHidden, storeToken } from "./credentials.js";
import { OPERATIONS } from "./operations.js";
import { createServer, registeredToolCount, VERSION } from "./server.js";
import { loadSigner, type RequestSigner } from "./signing.js";
import { ALL_TOOLS } from "./tools/index.js";

const KEY_DIR = join(CONFIG_DIR, "keys");
const log = (msg: string) => process.stderr.write(`${msg}\n`);

function loadSignerIfConfigured(config: Config): RequestSigner | undefined {
  if (!config.signingKeyUid) return undefined;
  if (!existsSync(config.signingKeyPath)) {
    log(
      `starling-mcp: STARLING_SIGNING_KEY_UID is set but ${config.signingKeyPath} does not exist; signed endpoints disabled`,
    );
    return undefined;
  }
  return loadSigner(config.signingKeyUid, config.signingKeyPath);
}

async function makeClient(config: Config) {
  const { token, source } = await loadAccessToken(config.environment);
  return { client: new StarlingClient(config, token, loadSignerIfConfigured(config)), source };
}

async function serve(): Promise<void> {
  const config = loadConfig();
  // The token is loaded on first use, so the server starts (and explains how to add a token) even before one is stored.
  const client = new StarlingClient(
    config,
    async () => (await loadAccessToken(config.environment)).token,
    loadSignerIfConfigured(config),
  );
  const server = createServer(config, client);
  await server.connect(new StdioServerTransport());
  log(
    `starling-mcp ${VERSION}: ${config.environment}, tier=${config.tier}, ${registeredToolCount(config)} tools, ` +
      `signing ${client.canSign ? "on" : "off"}`,
  );
}

function scopesForTier(tier: AccessTier): string[] {
  const config = { tier } as Config;
  const scopes = new Set<string>();
  for (const tool of ALL_TOOLS) {
    if (!tierAllows(config, tool.tier)) continue;
    for (const op of tool.operations) for (const s of OPERATIONS[op]?.scopes ?? []) scopes.add(s);
  }
  return [...scopes].sort();
}

function printScopes(): void {
  let previous = new Set<string>();
  for (const tier of ["read", "write", "payments"] as AccessTier[]) {
    const all = scopesForTier(tier);
    const added = all.filter((s) => !previous.has(s));
    console.log(`\n${tier} tier${tier === "read" ? "" : " adds"} (${added.length}):\n  ${added.join("\n  ")}`);
    previous = new Set(all);
  }
  console.log(
    "\nTick only the scopes for the tier you plan to enable. You can always create a new token with more scopes later.\n" +
      "Starling will not issue a token with payee:create AND payment scopes (pay-local:create, standing-order:create).\n" +
      "Recommended: leave out payee:create and add payees in the Starling app, so the model can only pay payees you approved.",
  );
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  console.log(`Environment:   ${config.environment} (${config.baseUrl})`);
  console.log(`Access tier:   ${config.tier} (${registeredToolCount(config)} tools)`);
  console.log(`Confirmation:  ${config.confirmation}`);
  console.log(`Payment limit: ${config.paymentLimitMinorUnits ?? "none"}`);
  console.log(`Audit log:     ${config.auditLogPath ?? "disabled"}`);

  const { client, source } = await makeClient(config);
  console.log(
    `Token source:  ${source}${source === "environment" ? "  (consider the Keychain: starling-mcp token set)" : ""}`,
  );
  if (config.signingKeyUid) {
    console.log(
      `Signing:       ${client.canSign ? `key ${config.signingKeyUid} from ${config.signingKeyPath}` : "configured but key file missing"}`,
    );
  } else {
    console.log("Signing:       not configured (payments, standing orders, email and address changes need it)");
  }

  const identity = await client.json<{ scopes?: string[]; expiresAt?: string; accountHolderUid?: string }>({
    method: "GET",
    path: "/api/v2/identity/token",
  });
  const granted = new Set(identity.scopes ?? []);
  console.log(`Token expires: ${identity.expiresAt ?? "unknown"}`);
  console.log(`Granted scopes (${granted.size}): ${[...granted].sort().join(", ")}`);

  const accounts = await client.json<{ accounts?: { name: string; currency: string; accountType: string }[] }>({
    method: "GET",
    path: "/api/v2/accounts",
  });
  console.log(
    `Accounts:      ${(accounts.accounts ?? []).map((a) => `${a.name} (${a.currency}, ${a.accountType})`).join("; ") || "none visible"}`,
  );

  const blocked: string[] = [];
  for (const tool of ALL_TOOLS) {
    if (!tierAllows(config, tool.tier)) continue;
    const missing = new Set<string>();
    for (const op of tool.operations) {
      const needed = OPERATIONS[op]?.scopes ?? [];
      if (needed.length && !needed.some((s) => granted.has(s))) for (const s of needed) missing.add(s);
    }
    if (missing.size) blocked.push(`  ${tool.name}: needs ${[...missing].join(" or ")}`);
  }
  console.log(
    blocked.length
      ? `\nTools the token's scopes do not cover (${blocked.length}):\n${blocked.join("\n")}`
      : "\nAll enabled tools are covered by the token's scopes.",
  );
  console.log(`\nAPI requests used by this check: ${client.requestsToday}`);
}

async function generateKeys(force: boolean): Promise<void> {
  await mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  for (const name of ["api", "rotation"]) {
    const priv = join(KEY_DIR, `starling-${name}-private.key`);
    const pub = join(KEY_DIR, `starling-${name}-public.key`);
    if (existsSync(priv) && !force) {
      console.log(`${priv} already exists; keeping it (use --force to replace).`);
    } else {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      await writeFile(priv, privateKey, { mode: 0o600, flag: force ? "w" : "wx" });
      await writeFile(pub, publicKey, { mode: 0o644 });
    }
    console.log(`\n${name.toUpperCase()} public key (${pub}):\n${readFileSync(pub, "utf8")}`);
  }
  console.log(
    "Upload both PUBLIC keys in the Starling Developer Portal (Personal Access → Keys), production environment.\n" +
      "Then set STARLING_SIGNING_KEY_UID to the API key's UID shown in the portal. Private keys never leave this machine.",
  );
}

/** Signs a new public API key with the rotation key, for uploading during key rotation. */
function rotationSignature(newPublicKeyPath: string, keyId: string): void {
  const rotationKey = join(KEY_DIR, "starling-rotation-private.key");
  assertPrivateFile(rotationKey);
  const body = createPublicKey(readFileSync(newPublicKeyPath))
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const date = new Date().toISOString();
  const digest = createHash("sha512").update(body).digest("base64");
  const signature = createSign("SHA512")
    .update(`Date: ${date}\nDigest: ${digest}`)
    .sign(createPrivateKey(readFileSync(rotationKey)), "base64");
  console.log(`Signature timestamp (upload within 5 minutes): ${date}`);
  console.log(
    `Signature: Signature keyid="${keyId}",algorithm="rsa-sha512",headers="Date Digest",signature="${signature}"`,
  );
}

function usage(): void {
  console.log(`starling-mcp ${VERSION} — privacy-first MCP server for the Starling Bank API

Usage:
  starling-mcp                         Run the MCP server on stdio (what MCP clients launch)
  starling-mcp token set [--sandbox]   Check a personal access token and store it in the macOS Keychain (hidden prompt,
                                       or pipe it: pbpaste | starling-mcp token set)
  starling-mcp token delete [--sandbox]
  starling-mcp doctor                  Check configuration, token scopes and account access
  starling-mcp scopes                  List the token scopes each access tier needs
  starling-mcp keys generate [--force] Create request-signing key pairs in ${KEY_DIR}
  starling-mcp keys rotation-signature <new-public-key.pem> <rotation-key-uid>

Configuration is by environment variable; see README.md.`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  const env: Environment = argv.includes("--sandbox") ? "sandbox" : "production";
  switch (cmd) {
    case undefined:
    case "serve":
      return serve();
    case "token":
      if (sub === "set") {
        const token = await readHidden(
          `Paste your Starling ${env} personal access token (hidden), then press Return: `,
        );
        if (!token) throw new Error("No token entered.");
        console.log(`Received ${token.length} characters. Checking it with Starling…`);
        process.env.STARLING_ENVIRONMENT = env;
        const client = new StarlingClient(loadConfig(), token, undefined);
        const id = await client.json<{ scopes?: string[]; expiresAt?: string }>({
          method: "GET",
          path: "/api/v2/identity/token",
        });
        await storeToken(env, token);
        console.log(
          `Token OK and saved to the macOS Keychain. ${id.scopes?.length ?? 0} scopes granted; expires ${id.expiresAt ?? "never"}.`,
        );
        if (!process.stdin.isTTY) console.log("If you piped it from the clipboard, clear it with: pbcopy < /dev/null");
        return;
      }
      if (sub === "delete") {
        console.log((await deleteToken(env)) ? "Token removed from the Keychain." : "No token found in the Keychain.");
        return;
      }
      break;
    case "doctor":
      return doctor();
    case "scopes":
      return printScopes();
    case "keys":
      if (sub === "generate") return generateKeys(rest.includes("--force"));
      if (sub === "rotation-signature" && rest[0] && rest[1]) return rotationSignature(rest[0], rest[1]);
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      return usage();
  }
  usage();
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  log(`starling-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
