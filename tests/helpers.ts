import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StarlingClient } from "../src/client.js";
import { type Config, loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { RequestSigner } from "../src/signing.js";

export const ACCOUNT = "11111111-1111-4111-8111-111111111111";
export const CATEGORY = "22222222-2222-4222-8222-222222222222";
export const PAYEE = "33333333-3333-4333-8333-333333333333";
export const PAYEE_ACCOUNT = "44444444-4444-4444-8444-444444444444";

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (req: Recorded) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** A fake Starling API: routes are "METHOD /path" with {param} wildcards. */
export function fakeStarling(routes: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const req: Recorded = {
      method: init.method ?? "GET",
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(req);
    for (const [key, handler] of Object.entries(routes)) {
      const [method, pattern] = key.split(" ") as [string, string];
      const re = new RegExp(`^${pattern.replace(/\{\w+\}/g, "[^/]+")}$`);
      if (method === req.method && re.test(url.pathname)) {
        const r = handler(req);
        const body = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
        return new Response(body || null, { status: r.status ?? 200, headers: r.headers });
      }
    }
    return new Response(JSON.stringify({ errors: [{ message: `no fake route for ${req.method} ${url.pathname}` }] }), {
      status: 404,
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function testConfig(env: Record<string, string> = {}): Config {
  return { ...loadConfig({ STARLING_AUDIT_LOG: "off", STARLING_REQUESTS_PER_SECOND: "1000", ...env }) };
}

export function rsaSigner(): { signer: RequestSigner; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { signer: { keyUid: "key-uid", algorithm: "rsa-sha512", key: privateKey }, publicKey };
}

export const ACCOUNTS_ROUTE = {
  "GET /api/v2/accounts": () => ({
    json: {
      accounts: [
        {
          accountUid: ACCOUNT,
          accountType: "PRIMARY",
          defaultCategory: CATEGORY,
          currency: "GBP",
          createdAt: "2020-01-01T00:00:00Z",
          name: "Personal",
        },
      ],
    },
  }),
};

export async function connect(
  config: Config,
  fetchImpl: typeof fetch,
  signer?: RequestSigner,
  onElicit?: (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> },
) {
  const starling = new StarlingClient(config, "test-token", signer, fetchImpl);
  const server = createServer(config, starling);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: onElicit ? { elicitation: {} } : {} });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, async (req) => onElicit(req.params.message));
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
