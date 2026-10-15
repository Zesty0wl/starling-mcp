# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-15

First public release.

### Added
- All 87 operations of the Starling Bank public API, exposed as 84 MCP tools in three access tiers: read (default), write (`STARLING_ENABLE_WRITES`) and payments (`STARLING_ENABLE_PAYMENTS`).
- Local analysis tools that need no extra API calls beyond the feed: `get_financial_overview`, `summarise_spending` (by spending category, counterparty or month) and `find_recurring_payments` (subscription detection with estimated annual cost).
- Token storage in the macOS Keychain, with `STARLING_ACCESS_TOKEN_FILE` and `STARLING_ACCESS_TOKEN` as fallbacks. The token is loaded lazily, so the server starts without one and picks up a newly stored or rotated token without a restart.
- Request signing for payment-class endpoints (RSA or ECDSA), plus `keys generate` and `keys rotation-signature`.
- Human confirmation for money movement and destructive actions: MCP elicitation where the client supports it, otherwise a preview with a single-use code that is burned on any use.
- Optional per-payment cap (`STARLING_PAYMENT_LIMIT_MINOR_UNITS`), local audit log of every state-changing call, and client-side rate limiting for Starling's 5 requests/second limit.
- CLI: `token set|delete`, `doctor`, `scopes`, `keys`.
- `npm run spec:check` compares the implementation with Starling's live OpenAPI spec.

### Fixed (found while testing against a live account)
- `token set` silently truncated tokens to 128 characters because it relied on macOS `getpass()`. It now reads input itself, validates the token with Starling before saving, and passes it to `security` over a pipe.
- List tools returned very large results (one account's payee list was 60k characters). Results are now compact JSON; `list_payees`, `list_direct_debit_mandates`, `list_standing_orders` and `list_payment_order_payments` return trimmed rows by default, with `detail: "full"` available.
- Direct debits and standing orders hide cancelled entries by default (`includeCancelled` to show them).
- Missing photos and profile images return a message instead of a 404 error.

### Documented
- Starling refuses personal access tokens that combine `payee:create` with payment scopes; the recommended setup leaves out `payee:create`.
- `doctor` and `get_token_identity` explain the 90-day consent window.

[Unreleased]: https://github.com/Zesty0wl/starling-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Zesty0wl/starling-mcp/releases/tag/v0.1.0
