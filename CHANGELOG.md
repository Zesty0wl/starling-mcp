# Changelog

## 0.1.0 (unreleased)

- First release: all 87 operations of the Starling Bank public API, exposed as 84 MCP tools across three access tiers (read, write, payments).
- Local analysis tools: `get_financial_overview`, `summarise_spending`, `find_recurring_payments`.
- macOS Keychain token storage, request signing, human confirmation (elicitation or single-use codes), payment cap, audit log, rate limiting.
- CLI: `token set|delete`, `doctor`, `scopes`, `keys generate|rotation-signature`.
