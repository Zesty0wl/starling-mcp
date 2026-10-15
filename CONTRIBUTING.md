# Contributing

Thanks for helping. This server sits between an AI model and real bank accounts, so changes are held to a high bar for safety and privacy.

## Ground rules

- **Never include real account data** in issues, pull requests, tests or logs: no tokens, UIDs, transactions, names, sort codes or account numbers. Use the sandbox (`STARLING_ENVIRONMENT=sandbox`) or the fake API in `tests/helpers.ts`.
- **Security problems go through private reporting**, not public issues. See [SECURITY.md](SECURITY.md).
- **No new network destinations.** The server only talks to Starling's API hosts. Anything that adds telemetry, analytics or third-party calls won't be merged.
- **Keep dependencies minimal.** New runtime dependencies need a strong reason.

## Development

Requires Node.js 22 or later.

```sh
npm ci
npm test            # unit and MCP integration tests (no network)
npm run check       # Biome lint + TypeScript type-check
npm run build
npm run spec:check  # compare with Starling's live OpenAPI spec (network)
```

## Adding or changing a tool

Tools live in `src/tools/`. Each one declares:

- the Starling `operationId`s it calls (used by the coverage test and `spec:check`);
- its access tier (`read`, `write` or `payments`);
- whether it needs human confirmation (`confirm: true`).

The test suite enforces the safety invariants: read-tier tools may only issue GET requests, and every signed or payment-tier tool must require confirmation. Please keep it that way, and add tests that exercise new behaviour against the fake API.

## Pull requests

- Keep changes focused, and describe the user-visible effect.
- Run `npm run check && npm test` before opening the PR.
- Add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
