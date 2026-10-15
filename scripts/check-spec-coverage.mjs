#!/usr/bin/env node
// Compares Starling's live OpenAPI spec with the operations this server implements,
// so new or changed endpoints are noticed. Run after `npm run build`.
import { OPERATIONS } from "../dist/operations.js";
import { ALL_TOOLS } from "../dist/tools/index.js";

const SPEC_URL = "https://api.starlingbank.com/api/openapi.json";
const res = await fetch(SPEC_URL);
if (!res.ok) throw new Error(`Could not download ${SPEC_URL}: HTTP ${res.status}`);
const spec = await res.json();

const live = {};
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    if (!["get", "put", "post", "delete", "patch"].includes(method)) continue;
    const security = op.security ?? [];
    live[op.operationId] = {
      method: method.toUpperCase(),
      path,
      scopes: [...new Set(security.flatMap((s) => Object.values(s).flat()))].filter((s) => s !== "none").sort(),
      signed: security.some((s) => "BearerAndSignature" in s),
    };
  }
}

const problems = [];
const covered = new Set(ALL_TOOLS.flatMap((t) => t.operations));
for (const [id, op] of Object.entries(live)) {
  const known = OPERATIONS[id];
  if (!known) problems.push(`NEW endpoint not implemented: ${op.method} ${op.path} (${id})`);
  else {
    if (known.path !== op.path || known.method !== op.method)
      problems.push(`CHANGED route: ${id} is now ${op.method} ${op.path}`);
    if (known.signed !== op.signed) problems.push(`CHANGED signing: ${id} signed=${op.signed}`);
    if (JSON.stringify(known.scopes) !== JSON.stringify(op.scopes))
      problems.push(`CHANGED scopes: ${id} → ${op.scopes.join(", ")}`);
  }
  if (!covered.has(id)) problems.push(`No tool calls ${id}`);
}
for (const id of Object.keys(OPERATIONS)) if (!live[id]) problems.push(`REMOVED from Starling's spec: ${id}`);

console.log(`Live spec: ${Object.keys(live).length} operations. Implemented: ${Object.keys(OPERATIONS).length}.`);
if (problems.length) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log("Every operation in Starling's public API is implemented, and routes, scopes and signing match.");
