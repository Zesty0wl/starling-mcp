import { createHash, createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertPrivateFile } from "./credentials.js";

export type SigningAlgorithm = "rsa-sha512" | "ecdsa-sha512";

export interface RequestSigner {
  keyUid: string;
  algorithm: SigningAlgorithm;
  key: KeyObject;
}

export function loadSigner(keyUid: string, keyPath: string): RequestSigner {
  assertPrivateFile(keyPath);
  const key = createPrivateKey(readFileSync(keyPath));
  const algorithm: SigningAlgorithm = key.asymmetricKeyType === "ec" ? "ecdsa-sha512" : "rsa-sha512";
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "ec") {
    throw new Error(`Unsupported signing key type "${key.asymmetricKeyType}". Starling accepts RSA or ECDSA keys.`);
  }
  return { keyUid, algorithm, key };
}

/** SHA-512 of the exact body bytes, base64; Starling uses "X" when there is no body. */
export function digestOf(body: string | undefined): string {
  if (body === undefined || body === "") return "X";
  return createHash("sha512").update(body, "utf8").digest("base64");
}

export interface SignedHeaders {
  authorization: string;
  date: string;
  digest: string;
}

/**
 * Implements Starling's message signing scheme:
 * https://developer.starlingbank.com/docs#make-signed-requests
 */
export function signRequest(
  signer: RequestSigner,
  accessToken: string,
  method: string,
  pathWithQuery: string,
  body: string | undefined,
  now: Date = new Date(),
): SignedHeaders {
  const date = now.toISOString();
  const digest = digestOf(body);
  const content = `(request-target): ${method.toLowerCase()} ${pathWithQuery}\nDate: ${date}\nDigest: ${digest}`;
  const signature = createSign("SHA512").update(content).sign(signer.key, "base64");
  const authorization =
    `Bearer ${accessToken};Signature keyid="${signer.keyUid}",algorithm="${signer.algorithm}",` +
    `headers="(request-target) Date Digest",signature="${signature}"`;
  return { authorization, date, digest };
}
