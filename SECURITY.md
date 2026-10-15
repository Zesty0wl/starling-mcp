# Security

This server sits between an AI model and a real bank account. Please read this before enabling write or payment access.

## Threat model

| Threat | Mitigation |
|---|---|
| Token theft from disk, shell history or process listings | Token read at a hidden prompt (no length limit), validated with Starling, then stored in the macOS Keychain by piping it to `security`; never passed on the command line; never logged; never included in tool output or errors. File fallback must be `chmod 600`. |
| Token sent somewhere other than Starling | Base URL is hard-coded per environment; every request's origin is checked; redirects are refused; pagination follows only the cursor value, never a server-supplied URL. |
| Prompt injection via third-party data (payment references, counterparty names, receipts) | Server instructions tell the model to treat these strictly as data. Money-moving and destructive tools require human confirmation, by client elicitation where available (the model cannot answer it) or by preview plus a single-use code. Write and payment tools are not registered unless explicitly enabled. |
| Payment to an attacker's account | Payments and standing orders can only target existing saved payees (Starling's rule for personal tokens, also enforced locally). Creating a payee is itself a confirmed, payment-tier action. Confirmation text shows the payee name, sort code and account number. Optional per-payment cap. |
| Accidental duplicate payments | A unique `externalIdentifier` per payment (Starling idempotency). Writes are never auto-retried after a 5xx or network error. Confirmation codes are single-use. |
| Exfiltrating local files via uploads | Upload tools accept only image/PDF extensions, regular files and a maximum of 10 MB. |
| Overwriting local files via downloads | Downloads are created with `O_EXCL` (never overwrite) and `0600` permissions. |
| Signing key misuse | Private keys are generated locally with `0600` permissions, and the server refuses keys that other users can read. Signatures are made at send time (Starling rejects signatures more than 5 seconds old). |

## Recommendations

- Give the token only the scopes you need (`starling-mcp scopes`), and keep the server read-only unless you need more.
- If you enable payments, set `STARLING_PAYMENT_LIMIT_MINOR_UNITS` and prefer an MCP client with elicitation support (`get_server_status` reports whether yours does).
- Review the audit log periodically: `~/.local/state/starling-mcp/audit.log`.
- If you suspect a leak, revoke the token in the Developer Portal (or use the `logout_all_tokens` tool), then run `starling-mcp token delete`.

## Reporting a vulnerability

Please report security issues privately through GitHub's *Report a vulnerability* (security advisories) on this repository rather than opening a public issue.
