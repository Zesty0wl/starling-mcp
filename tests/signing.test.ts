import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestOf, signRequest } from "../src/signing.js";
import { rsaSigner } from "./helpers.js";

describe("request signing", () => {
  it("digests the exact body with SHA-512, and uses X when there is no body", () => {
    const body = '{"a":1}';
    expect(digestOf(body)).toBe(createHash("sha512").update(body).digest("base64"));
    expect(digestOf(undefined)).toBe("X");
    expect(digestOf("")).toBe("X");
  });

  it("produces a signature over (request-target), Date and Digest that verifies with the public key", () => {
    const { signer, publicKey } = rsaSigner();
    const now = new Date("2026-04-07T18:26:30.668Z");
    const path = "/api/v2/payments/local/account/a/category/c";
    const body = '{"amount":{"currency":"GBP","minorUnits":1}}';
    const signed = signRequest(signer, "tok", "PUT", path, body, now);

    expect(signed.date).toBe("2026-04-07T18:26:30.668Z");
    expect(signed.digest).toBe(digestOf(body));
    const match =
      /^Bearer tok;Signature keyid="key-uid",algorithm="rsa-sha512",headers="\(request-target\) Date Digest",signature="([^"]+)"$/.exec(
        signed.authorization,
      );
    expect(match).not.toBeNull();

    const content = `(request-target): put ${path}\nDate: ${signed.date}\nDigest: ${signed.digest}`;
    const ok = createVerify("SHA512").update(content).verify(publicKey, match![1]!, "base64");
    expect(ok).toBe(true);
  });

  it("supports ECDSA keys", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signed = signRequest(
      { keyUid: "k", algorithm: "ecdsa-sha512", key: privateKey },
      "t",
      "DELETE",
      "/x",
      undefined,
    );
    const sig = /signature="([^"]+)"/.exec(signed.authorization)![1]!;
    const content = `(request-target): delete /x\nDate: ${signed.date}\nDigest: X`;
    expect(createVerify("SHA512").update(content).verify(publicKey, sig, "base64")).toBe(true);
    expect(signed.authorization).toContain('algorithm="ecdsa-sha512"');
  });
});
