import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { type Environment, KEYCHAIN_SERVICE } from "./config.js";

const execFileAsync = promisify(execFile);
const SECURITY = "/usr/bin/security";

export function keychainAccount(environment: Environment): string {
  return `access-token-${environment}`;
}

/**
 * Refuses secret files that other users can read. A personal access token
 * has the same power as your banking login, so treat it like an SSH key.
 */
export function assertPrivateFile(path: string): void {
  const st = statSync(path);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error(
      `${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 600 "${path}"`,
    );
  }
}

async function readKeychain(environment: Environment): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync(SECURITY, [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      keychainAccount(environment),
      "-w",
    ]);
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export type TokenSource = "keychain" | "file" | "environment";

/**
 * Resolves the access token, in order of preference:
 * the macOS Keychain, then STARLING_ACCESS_TOKEN_FILE, then STARLING_ACCESS_TOKEN.
 */
export async function loadAccessToken(
  environment: Environment,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ token: string; source: TokenSource }> {
  const fromKeychain = await readKeychain(environment);
  if (fromKeychain) return { token: fromKeychain, source: "keychain" };

  if (env.STARLING_ACCESS_TOKEN_FILE) {
    assertPrivateFile(env.STARLING_ACCESS_TOKEN_FILE);
    const token = readFileSync(env.STARLING_ACCESS_TOKEN_FILE, "utf8").trim();
    if (token) return { token, source: "file" };
  }

  const fromEnv = env.STARLING_ACCESS_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "environment" };

  throw new Error(
    `No Starling access token found for ${environment}. Run "starling-mcp token set" to store one in the macOS Keychain.`,
  );
}

/**
 * Stores the token in the Keychain. `security` prompts for the value itself,
 * so the token never appears in argv, shell history or this process's memory.
 */
export function storeTokenInteractively(environment: Environment): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      SECURITY,
      [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        keychainAccount(environment),
        "-l",
        `Starling MCP personal access token (${environment})`,
        "-w",
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`security exited with code ${code}`))));
  });
}

export async function deleteToken(environment: Environment): Promise<boolean> {
  try {
    await execFileAsync(SECURITY, [
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      keychainAccount(environment),
    ]);
    return true;
  } catch {
    return false;
  }
}
