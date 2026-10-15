import type { Config } from "./config.js";
import { RateLimiter } from "./rateLimiter.js";
import { type RequestSigner, signRequest } from "./signing.js";

export const USER_AGENT = "starling-mcp/0.1.0";
const TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_SECONDS = 10;

export type Method = "GET" | "PUT" | "POST" | "DELETE";
type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  method: Method;
  /** Path template like /api/v2/accounts/{accountUid}/balance. */
  path: string;
  params?: Record<string, string>;
  query?: Record<string, QueryValue>;
  /** JSON body; serialised once so the signature covers the exact bytes sent. */
  json?: unknown;
  /** Raw body for uploads. */
  raw?: { data: Uint8Array; contentType: string };
  /** Endpoint requires a request signature (payments, standing orders, personal details). */
  signed?: boolean;
  accept?: string;
}

export interface BinaryResponse {
  data: Buffer;
  contentType: string;
  filename: string | undefined;
}

export class StarlingApiError extends Error {
  constructor(
    readonly status: number,
    readonly details: string[],
    readonly operation: string,
  ) {
    super(StarlingApiError.describe(status, details, operation));
    this.name = "StarlingApiError";
  }

  private static describe(status: number, details: string[], operation: string): string {
    const hints: Record<number, string> = {
      400: "Starling rejected the request as invalid.",
      401: "The access token is invalid or has expired. Create a new one and store it with `starling-mcp token set`.",
      403: "Forbidden. Usually the token lacks the scope this endpoint needs (call get_token_identity to see granted scopes), or the data is outside the 90-day consent window.",
      404: "Not found. Check the UIDs, and that this resource exists for this account holder type.",
      429: "Rate limited by Starling (personal tokens allow 5 requests/second and 1,000/day).",
    };
    const base = hints[status] ?? (status >= 500 ? "Starling returned a server error." : "Request failed.");
    const extra = details.length ? ` Details: ${details.join("; ")}` : "";
    return `${operation} → HTTP ${status}. ${base}${extra}`;
  }
}

export function buildPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
}

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) usp.set(k, String(v));
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function errorDetails(res: Response): Promise<string[]> {
  const text = await res.text().catch(() => "");
  if (!text) return [];
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const out: string[] = [];
    if (Array.isArray(body.errors)) {
      for (const e of body.errors) {
        if (e && typeof e === "object" && "message" in e) out.push(String((e as { message: unknown }).message));
        else out.push(String(e));
      }
    }
    for (const key of ["error", "error_description", "message"]) {
      if (typeof body[key] === "string") out.push(body[key] as string);
    }
    return out.length ? out : [text.slice(0, 500)];
  } catch {
    return [text.slice(0, 500)];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fixed token, or a loader (e.g. the Keychain) that is called lazily and again after a 401. */
export type TokenSource = string | (() => Promise<string>);

export class StarlingClient {
  private readonly limiter: RateLimiter;
  private readonly origin: string;
  private cachedToken: string | undefined;

  constructor(
    config: Config,
    private readonly token: TokenSource,
    private readonly signer: RequestSigner | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.limiter = new RateLimiter(config.requestsPerSecond);
    this.origin = new URL(config.baseUrl).origin;
  }

  private async accessToken(): Promise<string> {
    if (typeof this.token === "string") return this.token;
    this.cachedToken ??= await this.token();
    return this.cachedToken;
  }

  get requestsToday(): number {
    return this.limiter.requestsToday;
  }

  get canSign(): boolean {
    return this.signer !== undefined;
  }

  async json<T = unknown>(opts: RequestOptions): Promise<T> {
    const res = await this.send({ ...opts, accept: opts.accept ?? "application/json" });
    const text = await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async text(opts: RequestOptions): Promise<string> {
    const res = await this.send(opts);
    return res.text();
  }

  async binary(opts: RequestOptions): Promise<BinaryResponse> {
    const res = await this.send({ ...opts, accept: opts.accept ?? "*/*" });
    const data = Buffer.from(await res.arrayBuffer());
    const disposition = res.headers.get("content-disposition") ?? "";
    const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    return {
      data,
      contentType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim(),
      filename: filename ? decodeURIComponent(filename) : undefined,
    };
  }

  private async send(opts: RequestOptions): Promise<Response> {
    const pathWithQuery = buildPath(opts.path, opts.params) + buildQuery(opts.query);
    const url = new URL(pathWithQuery, this.origin);
    // Defence in depth: the token must only ever be sent to Starling.
    if (url.origin !== this.origin) throw new Error(`Refusing to call ${url.origin}`);

    const operation = `${opts.method} ${opts.path}`;
    const body = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
    const idempotent = opts.method === "GET";
    const accessToken = await this.accessToken();

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Accept: opts.accept ?? "application/json",
        "User-Agent": USER_AGENT,
      };
      if (opts.signed) {
        if (!this.signer) {
          throw new Error(
            `${operation} needs a signed request. Generate a key pair with "starling-mcp keys generate", upload the public key in the Starling Developer Portal, then set STARLING_SIGNING_KEY_UID. See README "Request signing".`,
          );
        }
        // Signed at send time: Starling rejects signatures more than 5 seconds old.
        const signed = signRequest(this.signer, accessToken, opts.method, url.pathname + url.search, body);
        headers.Authorization = signed.authorization;
        headers.Date = signed.date;
        headers.Digest = signed.digest;
      } else {
        headers.Authorization = `Bearer ${accessToken}`;
      }

      let payload: BodyInit | undefined;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = body;
      } else if (opts.raw) {
        headers["Content-Type"] = opts.raw.contentType;
        payload = opts.raw.data as Uint8Array<ArrayBuffer>;
      }

      await this.limiter.acquire();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: opts.method,
          headers,
          body: payload,
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (idempotent && attempt < 1) {
          await sleep(1000);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${operation} failed before a response was received (${reason}).` +
            (idempotent ? "" : " The request may or may not have been processed: check before retrying."),
        );
      }

      if (res.ok) return res;

      // A 429 means Starling did not process the request, so retrying is safe for any method.
      if (res.status === 429 && attempt < 2) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        if (Number.isFinite(retryAfter) && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
          await res.body?.cancel();
          await sleep(Math.max(retryAfter, 1) * 1000);
          continue;
        }
      }
      if (idempotent && res.status >= 500 && attempt < 1) {
        await res.body?.cancel();
        await sleep(1000);
        continue;
      }
      // Re-read the token next time, so one stored with `starling-mcp token set` is picked up without a restart.
      if (res.status === 401) this.cachedToken = undefined;
      throw new StarlingApiError(res.status, await errorDetails(res), operation);
    }
  }
}
