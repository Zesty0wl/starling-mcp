# starling-mcp

A privacy-first [Model Context Protocol](https://modelcontextprotocol.io) server for the [Starling Bank public API](https://developer.starlingbank.com/docs). It lets an AI assistant such as Claude read and manage **your own** Starling accounts: balances, transactions, spaces, savings goals, cards, direct debits, payees, payments and standing orders.

It implements **all 87 operations** in Starling's public API spec. A test enforces this, and `npm run spec:check` compares the server against Starling's live spec. It also adds local analysis tools on top: spending summaries, subscription detection and a one-call financial overview.

> Not affiliated with or endorsed by Starling Bank.

## Privacy and safety design

Your bank token can move money, so the design assumes it must never leak and that the model can be manipulated.

- **Local only.** stdio transport, no HTTP listener, no telemetry, no analytics, no third-party services. The only host it ever contacts is `api.starlingbank.com` (or `api-sandbox.starlingbank.com`). That host is hard-coded, redirects are refused, and path parameters are percent-encoded.
- **Token in the macOS Keychain.** `starling-mcp token set` has macOS's `security` tool prompt for the token, so it never appears in shell history, process arguments or config files. Environment variables and a `chmod 600` file are supported as fallbacks.
- **Read-only by default.** Write tools and payment tools are not even registered unless you opt in with `STARLING_ENABLE_WRITES` / `STARLING_ENABLE_PAYMENTS`. The token's own scopes are a second, independent limit.
- **Human confirmation for anything risky.** Payments, standing orders, payee changes, cancelling direct debits, deleting savings spaces, personal-detail changes and token revocation all require explicit approval:
  - With clients that support MCP *elicitation*, the client shows you a confirmation dialog directly. The model cannot answer it, which is the strongest defence against prompt injection (for example, instructions hidden in a payment reference someone sent you).
  - Otherwise a two-step flow is used. The first call returns a preview and a one-time code, and only an identical second call with that code within 5 minutes executes. Codes are single-use and burn on any mismatch.
- **Payments only to existing payees.** This is Starling's rule for personal tokens, and the confirmation names the payee, sort code and account number before anything is sent. An optional hard cap applies per payment (`STARLING_PAYMENT_LIMIT_MINOR_UNITS`).
- **Request signing** for payment-class endpoints, using your own key pair. Private keys stay on disk with `0600` permissions, and the server refuses to load keys other users can read.
- **Local audit log** of every state-changing call (no tokens), at `~/.local/state/starling-mcp/audit.log` with `0600` permissions.
- **Rate-limit aware.** Requests are paced to Starling's 5/second limit for personal tokens. 429s are retried only when Starling says to retry soon, and writes are never blindly retried after a server error.
- **Minimal dependencies.** Only the official MCP SDK and `zod`. HTTP, crypto and signing use Node's standard library.

## Quick start

Requires Node.js 22 or later.

```sh
git clone https://github.com/<you>/starling-mcp.git && cd starling-mcp
npm ci && npm run build
npm link            # puts `starling-mcp` on your PATH (optional)
```

1. **Create a personal access token.** In the [Starling Developer Portal](https://developer.starlingbank.com), go to *Personal Access*, link your Starling account and create a token. Tick the scopes for the tier you want; `starling-mcp scopes` lists them. Fewer scopes means less risk. Starling refuses tokens that combine `payee:create` with the payment scopes (`pay-local:create`, `standing-order:create`). Leave out `payee:create` and add payees in the Starling app: then even a fully enabled server can only pay people you approved in the app.
2. **Store it in the Keychain.** Run this in a terminal; input is hidden:
   ```sh
   starling-mcp token set
   ```
3. **Check everything.**
   ```sh
   starling-mcp doctor
   ```
   This shows the granted scopes, the accounts visible to the token, and any enabled tools the token's scopes don't cover.
4. **Add it to your MCP client.**

   Claude Code (read-only):
   ```sh
   claude mcp add starling --scope user -- node /path/to/starling-mcp/dist/index.js
   ```
   Claude Code with writes and payments, a £500 per-payment cap and request signing:
   ```sh
   claude mcp add starling --scope user \
     -e STARLING_ENABLE_WRITES=true -e STARLING_ENABLE_PAYMENTS=true \
     -e STARLING_PAYMENT_LIMIT_MINOR_UNITS=50000 \
     -e STARLING_SIGNING_KEY_UID=<api-key-uid-from-portal> \
     -- node /path/to/starling-mcp/dist/index.js
   ```
   Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):
   ```json
   {
     "mcpServers": {
       "starling": {
         "command": "node",
         "args": ["/path/to/starling-mcp/dist/index.js"],
         "env": { "STARLING_ENABLE_WRITES": "false" }
       }
     }
   }
   ```

## Configuration

All configuration is through environment variables. None of them hold secrets except the token fallbacks.

| Variable | Default | Purpose |
|---|---|---|
| `STARLING_ENVIRONMENT` | `production` | `production` or `sandbox`. |
| `STARLING_ENABLE_WRITES` | `false` | Registers tools that change things: notes, categories, receipts, attachments, card controls, savings spaces, round-ups, direct-debit cancellation, profile and contact details. |
| `STARLING_ENABLE_PAYMENTS` | `false` | Also registers payments, standing orders and payee management. Requires writes. |
| `STARLING_PAYMENT_LIMIT_MINOR_UNITS` | none | Maximum amount per payment or standing order, in pence (`50000` = £500). |
| `STARLING_CONFIRMATION` | `auto` | `auto` uses elicitation when the client supports it and falls back to codes otherwise. `elicit` requires elicitation and refuses otherwise. `token` always uses codes. |
| `STARLING_SIGNING_KEY_UID` | none | UID of your uploaded API signing key; enables signed endpoints. |
| `STARLING_SIGNING_KEY_PATH` | `~/.config/starling-mcp/keys/starling-api-private.key` | Private key used for signing. |
| `STARLING_DEFAULT_ACCOUNT_UID` | none | Account used when a tool's `accountUid` is omitted (otherwise the only account, or the `PRIMARY` one). |
| `STARLING_AUDIT_LOG` | `~/.local/state/starling-mcp/audit.log` | Path, or `off`. |
| `STARLING_DOWNLOAD_DIR` | `~/Downloads/starling` | Where CSV exports and attachments are saved. |
| `STARLING_REQUESTS_PER_SECOND` | `5` | Client-side pacing. |
| `STARLING_ACCESS_TOKEN_FILE` | none | Fallback: path to a file containing the token (must be `chmod 600`). |
| `STARLING_ACCESS_TOKEN` | none | Last-resort fallback. Avoid this, because environment variables are easy to leak. |

## Request signing (payments, standing orders, email and address changes)

Starling requires these endpoints to be [signed](https://developer.starlingbank.com/docs#api-keys-and-message-signing) with a key pair you control:

```sh
starling-mcp keys generate
```

This creates RSA-4096 *API* and *rotation* key pairs in `~/.config/starling-mcp/keys` (private keys `0600`) and prints the public keys. Upload both public keys in the Developer Portal under *Personal Access → Keys*, then set `STARLING_SIGNING_KEY_UID` to the API key's UID. To rotate keys later, use `starling-mcp keys rotation-signature <new-public.key> <rotation-key-uid>`.

## Tools

✋ = asks for your confirmation before acting. Amounts are always integers in minor units (pence). `accountUid` and `categoryUid` are optional almost everywhere and default to your primary account's main balance. A space or savings goal UID can be used as a `categoryUid`.

### Overview and analysis (computed locally)

| Tool | Tier | What it does |
|---|---|---|
| `get_server_status` | read | Shows how this Starling MCP server is configured: environment, enabled access tier, whether request signing is set up, how confirmations work, and how many API requests it has made today (personal tokens allow 1,000/day). |
| `get_financial_overview` | read | One-call snapshot of every account: balances (cleared, effective, total including spaces), plus each savings space and spending space with its balance. |
| `summarise_spending` | read | Analyses transactions locally and totals them by spending category, by counterparty (merchant/payee), or by month (in/out/net). |
| `find_recurring_payments` | read | Scans outgoing transactions (default: last 12 months) for payments that repeat on a regular cadence: subscriptions, direct debits, standing orders, memberships. |
| `list_spending_categories` | read | Lists every spending category value Starling accepts (for filtering and recategorising). |

### Accounts and balances

| Tool | Tier | What it does |
|---|---|---|
| `list_accounts` | read | Lists the accounts this token can access, with accountUid, accountType, currency, name and defaultCategory (the category UID of the main balance, needed by feed and payment endpoints). |
| `get_account_balance` | read | Gets an account's balance. |
| `get_account_identifiers` | read | Gets the account's sort code and account number, plus IBAN and BIC (and any other identifiers). |
| `check_funds` | read | Checks whether the account has enough available money for a payment of the given amount, taking the overdraft into account. |
| `export_transactions_csv` | read | Downloads Starling's CSV export of all settled transactions on the main account between two dates (the same export as the app). |

### Transactions

| Tool | Tier | What it does |
|---|---|---|
| `list_transactions` | read | Lists transactions (feed items) for the main account or a space between two dates, newest first, with optional filters. |
| `get_feed_changes_since` | read | Returns feed items created or updated since a timestamp (within the last year). |
| `list_settled_transactions` | read | Lists settled transactions across the whole account (all categories) whose SETTLEMENT time falls between two timestamps (max 1 year). |
| `get_transaction` | read | Gets every detail of a single feed item (transaction). |
| `get_card_transaction_details` | read | For card payments: Mastercard details such as merchant identifier, merchant category code (MCC), point-of-sale time, authorisation code and card last 4 digits. |
| `list_transaction_attachments` | read | Lists the files (images / PDFs) attached to a transaction. |
| `download_transaction_attachment` | read | Downloads a file attached to a transaction. |
| `get_transaction_receipt` | read | Gets the itemised receipt that this application (token) submitted for a transaction. |
| `list_transaction_receipts` | read | Gets all itemised receipts for a transaction, from any source (you, Starling, or partners). |
| `set_transaction_note` | write | Sets (or clears, with an empty string) your private note on a transaction. |
| `set_transaction_spending_category` | write | Changes a transaction's spending category (e.g. |
| `upload_transaction_attachment` | write | Attaches a local image or PDF (e.g. |
| `submit_transaction_receipt` | write | Creates or updates an itemised receipt for a transaction (merchant, line items, tax, payment methods). |

### Spaces, savings goals and round-ups

| Tool | Tier | What it does |
|---|---|---|
| `list_spaces` | read | Lists all active spaces on an account: savings spaces (savings goals: name, total saved, target, %) and spending spaces (e.g. |
| `get_spending_space` | read | Gets one spending space (balance, type, linked card). |
| `get_space_photo` | read | Returns the photo of a space (savings or spending). |
| `list_savings_goals` | read | Lists savings goals (savings spaces) with total saved, target and percentage. |
| `get_savings_goal` | read | Gets one savings goal. |
| `get_savings_goal_photo` | read | Returns the photo of a savings goal. |
| `get_savings_goal_recurring_transfer` | read | Gets the recurring transfer (automatic top-up) into a savings space, if one is set. |
| `get_round_up` | read | Shows whether round-ups are active, which savings space they go to, and the multiplier. |
| `create_savings_goal` | write | Creates a new savings space, optionally with a target and photo. |
| `update_savings_goal` | write | Renames a savings space or changes its target / photo. |
| `delete_savings_goal` | write ✋ | Deletes a savings space. |
| `transfer_to_savings_goal` | write | Moves money from the main balance into one of your own savings spaces. |
| `withdraw_from_savings_goal` | write | Moves money from one of your savings spaces back to the main balance. |
| `set_savings_goal_recurring_transfer` | write | Creates or replaces an automatic recurring transfer from the main balance into a savings space (e.g. |
| `delete_savings_goal_recurring_transfer` | write | Stops the automatic recurring transfer into a savings space. |
| `enable_round_up` | write | Turns on round-ups: each card payment is rounded up to the next pound and the difference (times the multiplier, 1-10) is moved into a savings space. |
| `disable_round_up` | write | Turns off round-ups for the account. |

### Cards

| Tool | Tier | What it does |
|---|---|---|
| `list_cards` | read | Lists the account holder's cards with their controls: enabled (not locked), ATM, online, POS (contactless/chip & PIN), mobile wallet, gambling, mag stripe, currency flags, last 4 digits and activation/cancellation state. |
| `set_card_control` | write | Turns a card control on or off. |
| `set_card_currency_switch` | write | Enables or disables card payments in a specific currency (the card's currency switch control). |

### Direct debits

| Tool | Tier | What it does |
|---|---|---|
| `list_direct_debit_mandates` | read | Lists direct debit mandates (who can take money by direct debit), with originator, reference, status, created date and last payment. |
| `get_direct_debit_mandate` | read | Gets one direct debit mandate. |
| `list_direct_debit_payments` | read | Lists the payments taken under a direct debit mandate since a date. |
| `cancel_direct_debit_mandate` | write ✋ | Cancels a direct debit mandate so the originator can no longer collect payments. |

### Payees

| Tool | Tier | What it does |
|---|---|---|
| `list_payees` | read | Lists saved payees and their accounts (payeeAccountUid, sort code / account number, recent references). |
| `get_payee` | read | Gets one saved payee and its accounts. |
| `get_payee_image` | read | Returns the payee's image (PNG), if one exists. |
| `list_payee_payments` | read | Lists the history of payments made to a payee account since a date. |
| `list_payee_scheduled_payments` | read | Lists scheduled (future-dated and recurring) payments to a payee account. |
| `create_payee` | payments ✋ | Saves a new payee with one or more bank accounts. |
| `update_payee` | payments ✋ | Updates a payee's details (name, type, contact details). |
| `add_payee_account` | payments ✋ | Adds another bank account to an existing payee. |
| `delete_payee` | payments ✋ | Deletes a saved payee and all its accounts. |
| `delete_payee_account` | payments ✋ | Removes one bank account from a payee. |

### Payments and standing orders

| Tool | Tier | What it does |
|---|---|---|
| `get_payment_order` | read | Gets a payment order (an instructed payment or standing order) by its paymentOrderUid. |
| `list_payment_order_payments` | read | Lists the actual payments made under a payment order, with status (PENDING, ACCEPTED, REJECTED) and reasons. |
| `list_standing_orders` | read | Lists standing orders paid from the main account (or a space), with amount, payee, reference, recurrence and next date. |
| `get_standing_order` | read | Gets one standing order. |
| `list_standing_order_upcoming_payments` | read | Lists the next payment dates of a standing order (1 to 100, default 10). |
| `make_payment` | payments ✋ | Sends an immediate payment (UK Faster Payments, or SEPA from a EUR account) to an EXISTING saved payee account. |
| `create_standing_order` | payments ✋ | Creates a standing order to an EXISTING saved payee account. |
| `update_standing_order` | payments ✋ | Changes a standing order's amount, reference, schedule or spending category. |
| `cancel_standing_order` | payments ✋ | Cancels a standing order so no further payments are made. |

### Identity and account holder

| Tool | Tier | What it does |
|---|---|---|
| `get_token_identity` | read | Returns the access token's granted OAuth scopes, expiry, consent expiry and account holder UID. |
| `get_authorising_individual` | read | Returns the person who authorised this token (name, date of birth, email, phone). |
| `get_account_holder` | read | Returns the account holder UID and type (INDIVIDUAL, JOINT, SOLE_TRADER or BUSINESS). |
| `get_account_holder_name` | read | Returns the account holder's name. |
| `get_individual_details` | read | Personal account holders: title, name, date of birth, email and phone. |
| `get_joint_account_details` | read | Joint account holders: details of both people on the account. |
| `get_business_details` | read | Business account holders: company name, type, registration number, VAT number, etc. |
| `get_sole_trader_details` | read | Sole trader account holders: trading name, business category and subcategory. |
| `get_business_registered_address` | read | Business account holders: the company's registered address. |
| `get_business_correspondence_address` | read | Business account holders: correspondence address (falls back to the registered address). |
| `get_addresses` | read | Returns the account holder's current and previous addresses. |
| `get_settle_up_profile` | read | Returns the account holder's Settle Up profile (their Starling payment link/handle) if they have one. |
| `get_profile_image` | read | Returns the account holder's profile image, if one exists. |
| `update_profile_image` | write | Replaces the account holder's profile image with a local JPEG/PNG/GIF/WEBP/HEIC file. |
| `delete_profile_image` | write | Deletes the account holder's profile image. |
| `update_email` | write ✋ | Changes the individual account holder's email address with Starling. |
| `update_address` | write ✋ | Changes the account holder's current residential address with Starling. |
| `logout_all_tokens` | write ✋ | Logs the individual out by disabling ALL of their active API access tokens, including the one this server uses. |

## Rate limits

Personal access tokens are limited to **5 requests per second and 1,000 per day**. The analysis tools are designed around this: a year of transactions is one request, and `get_financial_overview` costs 1 + 2 requests per account. `get_server_status` shows how many requests this process has used today.

## What is deliberately not included

- **Open Banking AISP/PISP APIs.** These are only for FCA-regulated third-party providers.
- **Payment Services API.** This is for payment businesses using Starling as a payment rail; it needs mTLS and a commercial agreement.
- **Onboarding / Banking-as-a-Service and Marketplace OAuth.** These are partner-only APIs.
- **Webhooks.** Starling pushes these to a public HTTPS endpoint. Receiving them would mean running an internet-facing server, which conflicts with this project's local-only design. Use `get_feed_changes_since` to pick up changes instead.
- **Statements and spending-insights endpoints.** Starling has withdrawn these from the public API (they now return 404). Use `export_transactions_csv` and `summarise_spending` instead.

## Development

```sh
npm test            # unit + MCP integration tests (fake Starling API, no network)
npm run check       # lint + type-check
npm run build
npm run spec:check  # compare against Starling's live OpenAPI spec (network)
```

Tool definitions live in `src/tools/`. Each tool declares the Starling `operationId`s it calls, its access tier, and whether it needs confirmation, and the test suite enforces the safety invariants: read-tier tools only issue GETs, and every signed or payment-tier tool requires confirmation.

## Licence

MIT
