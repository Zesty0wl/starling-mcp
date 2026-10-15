import { describe, expect, it } from "vitest";
import { buildPath, StarlingApiError, StarlingClient } from "../src/client.js";
import { fakeStarling, rsaSigner, testConfig } from "./helpers.js";

describe("StarlingClient", () => {
  it("only ever calls the configured Starling host, with the bearer token and no redirects followed", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (url: URL, i: RequestInit) => {
      init = i;
      expect(url.origin).toBe("https://api.starlingbank.com");
      return new Response("{}");
    }) as unknown as typeof fetch;
    const client = new StarlingClient(testConfig(), "secret", undefined, fetchImpl);
    await client.json({ method: "GET", path: "/api/v2/accounts" });
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(init?.redirect).toBe("error");
  });

  it("uses the sandbox host when configured", async () => {
    const { fetchImpl, calls } = fakeStarling({ "GET /api/v2/accounts": () => ({ json: {} }) });
    await new StarlingClient(testConfig({ STARLING_ENVIRONMENT: "sandbox" }), "t", undefined, fetchImpl).json({
      method: "GET",
      path: "/api/v2/accounts",
    });
    expect(calls[0]!.url.origin).toBe("https://api-sandbox.starlingbank.com");
  });

  it("percent-encodes path parameters so they cannot change the path", () => {
    expect(buildPath("/api/v2/payees/{payeeUid}", { payeeUid: "../../accounts" })).toBe(
      "/api/v2/payees/..%2F..%2Faccounts",
    );
  });

  it("retries a 429 that has a short Retry-After, for any method", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeStarling({
      "PUT /x": () => (n++ === 0 ? { status: 429, headers: { "retry-after": "0" } } : { json: { ok: true } }),
    });
    const client = new StarlingClient(testConfig(), "t", undefined, fetchImpl);
    expect(await client.json({ method: "PUT", path: "/x", json: {} })).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("retries GET once on a 5xx but never retries a write", async () => {
    const get = fakeStarling({ "GET /x": () => ({ status: 503 }) });
    await expect(
      new StarlingClient(testConfig(), "t", undefined, get.fetchImpl).json({ method: "GET", path: "/x" }),
    ).rejects.toThrow(StarlingApiError);
    expect(get.calls).toHaveLength(2);

    const put = fakeStarling({ "PUT /x": () => ({ status: 503 }) });
    await expect(
      new StarlingClient(testConfig(), "t", undefined, put.fetchImpl).json({ method: "PUT", path: "/x", json: {} }),
    ).rejects.toThrow(/HTTP 503/);
    expect(put.calls).toHaveLength(1);
  });

  it("surfaces Starling error messages and a scope hint on 403", async () => {
    const { fetchImpl } = fakeStarling({
      "GET /x": () => ({ status: 403, json: { errors: [{ message: "INSUFFICIENT_SCOPE" }], success: false } }),
    });
    const err = await new StarlingClient(testConfig(), "t", undefined, fetchImpl)
      .json({ method: "GET", path: "/x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(StarlingApiError);
    expect(err.message).toContain("INSUFFICIENT_SCOPE");
    expect(err.message).toContain("get_token_identity");
    expect(err.message).not.toContain("t;");
  });

  it("refuses signed endpoints when no signing key is configured", async () => {
    const { fetchImpl, calls } = fakeStarling({});
    await expect(
      new StarlingClient(testConfig(), "t", undefined, fetchImpl).json({
        method: "PUT",
        path: "/p",
        json: {},
        signed: true,
      }),
    ).rejects.toThrow(/signed request/);
    expect(calls).toHaveLength(0);
  });

  it("adds Date, Digest and Signature headers to signed requests, signing the exact body sent", async () => {
    const { fetchImpl, calls } = fakeStarling({ "PUT /p": () => ({ json: {} }) });
    await new StarlingClient(testConfig(), "tok", rsaSigner().signer, fetchImpl).json({
      method: "PUT",
      path: "/p",
      json: { b: 1 },
      signed: true,
    });
    const h = calls[0]!.headers;
    expect(h.Authorization).toMatch(/^Bearer tok;Signature keyid="key-uid"/);
    expect(h.Date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(h.Digest).toHaveLength(88);
    expect(calls[0]!.body).toBe('{"b":1}');
  });
});

describe("lazy token loading", () => {
  it("loads the token on first use, caches it, and reloads after a 401", async () => {
    let loads = 0;
    let status = 200;
    const { fetchImpl, calls } = fakeStarling({ "GET /x": () => ({ status, json: {} }) });
    const client = new StarlingClient(testConfig(), async () => `tok${++loads}`, undefined, fetchImpl);
    expect(loads).toBe(0);
    await client.json({ method: "GET", path: "/x" });
    await client.json({ method: "GET", path: "/x" });
    expect(loads).toBe(1);
    status = 401;
    await expect(client.json({ method: "GET", path: "/x" })).rejects.toThrow(/401/);
    status = 200;
    await client.json({ method: "GET", path: "/x" });
    expect(loads).toBe(2);
    expect(calls.at(-1)!.headers.Authorization).toBe("Bearer tok2");
  });

  it("reports a missing token as a tool error rather than crashing", async () => {
    const { fetchImpl, calls } = fakeStarling({});
    const client = new StarlingClient(
      testConfig(),
      async () => {
        throw new Error('No Starling access token found. Run "starling-mcp token set"');
      },
      undefined,
      fetchImpl,
    );
    await expect(client.json({ method: "GET", path: "/x" })).rejects.toThrow(/token set/);
    expect(calls).toHaveLength(0);
  });
});
