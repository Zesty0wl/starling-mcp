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
 * Reads a secret from the terminal without echoing it. Unlike getpass()
 * (used by `security -w`), there is no 128-character limit, so long JWT
 * tokens can be pasted. When stdin is not a terminal (e.g. `pbpaste |`),
 * the whole of stdin is read instead.
 */
export function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c: string) => {
        data += c;
      });
      stdin.on("end", () => resolve(data.trim()));
      stdin.on("error", reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      // Strip bracketed-paste markers some terminals add around pasted text.
      for (const ch of chunk.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new Error("Cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Stores the token in the Keychain. The token is passed to `security` over a
 * pipe (interactive mode), never as a command-line argument, so it cannot be
 * seen in process listings or shell history.
 */
export function storeToken(environment: Environment, token: string): Promise<void> {
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    return Promise.reject(new Error("That does not look like a Starling access token (unexpected characters)."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 && !stderr.trim()
        ? resolve()
        : reject(new Error(`Could not save to the Keychain: ${stderr.trim() || `security exited with code ${code}`}`)),
    );
    const label = `Starling MCP personal access token (${environment})`;
    child.stdin.end(
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${keychainAccount(environment)} -l "${label}" -w "${token}"\n`,
    );
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
