import { z } from "zod";
import { saveDownload } from "../files.js";
import { formatMoney } from "../money.js";
import { accountUid, date, minorUnits } from "./schemas.js";
import { defineTool, json, text } from "./types.js";

type Signed = { currency: string; minorUnits: number };

export const accountTools = [
  defineTool({
    name: "get_server_status",
    title: "Server status",
    description:
      "Shows how this Starling MCP server is configured: environment, enabled access tier, whether request signing is set up, how confirmations work, and how many API requests it has made today (personal tokens allow 1,000/day). Makes no API calls.",
    tier: "read",
    operations: [],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json({
        environment: ctx.config.environment,
        apiBaseUrl: ctx.config.baseUrl,
        accessTier: ctx.config.tier,
        writesEnabled: ctx.config.tier !== "read",
        paymentsEnabled: ctx.config.tier === "payments",
        paymentLimit:
          ctx.config.paymentLimitMinorUnits === undefined
            ? "none"
            : `${ctx.config.paymentLimitMinorUnits} minor units per payment`,
        requestSigningConfigured: ctx.client.canSign,
        confirmationMode: ctx.confirmer.mode,
        clientSupportsElicitation: ctx.confirmer.elicitationSupported(),
        auditLog: ctx.config.auditLogPath ?? "disabled",
        downloadDirectory: ctx.config.downloadDir,
        requestsMadeTodayByThisProcess: ctx.client.requestsToday,
      });
    },
  }),

  defineTool({
    name: "get_token_identity",
    title: "Token identity and scopes",
    description:
      "Returns the access token's granted OAuth scopes, expiry, consent expiry and account holder UID. Use this to diagnose 403 errors (missing scope).",
    tier: "read",
    operations: ["getTokenIdentity"],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json(await ctx.client.json({ method: "GET", path: "/api/v2/identity/token" }));
    },
  }),

  defineTool({
    name: "get_authorising_individual",
    title: "Authorising individual",
    description: "Returns the person who authorised this token (name, date of birth, email, phone).",
    tier: "read",
    operations: ["getAuthorisingIndividual"],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json(await ctx.client.json({ method: "GET", path: "/api/v2/identity/individual" }));
    },
  }),

  defineTool({
    name: "list_accounts",
    title: "List accounts",
    description:
      "Lists the accounts this token can access, with accountUid, accountType, currency, name and defaultCategory (the category UID of the main balance, needed by feed and payment endpoints).",
    tier: "read",
    operations: ["getAccounts"],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json({ accounts: await ctx.accounts.list(true) });
    },
  }),

  defineTool({
    name: "get_account_balance",
    title: "Account balance",
    description:
      "Gets an account's balance. clearedBalance = settled transactions only; effectiveBalance = including pending outgoing (what the app shows). The total* fields include all spaces and savings goals. Amounts are in minor units; a formatted summary is included.",
    tier: "read",
    operations: ["getAccountBalance"],
    readOnly: true,
    input: { accountUid },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      const balance = await ctx.client.json<Record<string, Signed | undefined>>({
        method: "GET",
        path: "/api/v2/accounts/{accountUid}/balance",
        params: { accountUid: account.accountUid },
      });
      const formatted: Record<string, string> = {};
      for (const [k, v] of Object.entries(balance ?? {})) {
        if (v && typeof v.minorUnits === "number") formatted[k] = formatMoney(v.minorUnits, v.currency);
      }
      return json({ accountUid: account.accountUid, formatted, raw: balance });
    },
  }),

  defineTool({
    name: "get_account_identifiers",
    title: "Account identifiers",
    description: "Gets the account's sort code and account number, plus IBAN and BIC (and any other identifiers).",
    tier: "read",
    operations: ["getAccountIdentifiers"],
    readOnly: true,
    input: { accountUid },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/accounts/{accountUid}/identifiers",
          params: { accountUid: account.accountUid },
        }),
      );
    },
  }),

  defineTool({
    name: "check_funds",
    title: "Confirmation of funds",
    description:
      "Checks whether the account has enough available money for a payment of the given amount, taking the overdraft into account.",
    tier: "read",
    operations: ["getConfirmationOfFunds"],
    readOnly: true,
    input: { accountUid, amountMinorUnits: minorUnits("Amount to check") },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/accounts/{accountUid}/confirmation-of-funds",
          params: { accountUid: account.accountUid },
          query: { targetAmountInMinorUnits: args.amountMinorUnits },
        }),
      );
    },
  }),

  defineTool({
    name: "export_transactions_csv",
    title: "Export statement CSV",
    description:
      "Downloads Starling's CSV export of all settled transactions on the main account between two dates (the same export as the app). Saves it to a file with owner-only permissions and returns the path; set inline=true to also return the CSV text.",
    tier: "read",
    operations: ["downloadCSVFeedExportForDateRange"],
    readOnly: true,
    input: {
      accountUid,
      start: date("First day to include"),
      end: date("Last day to include").optional(),
      saveAs: z
        .string()
        .optional()
        .describe(
          "File name or absolute path. Relative names go in the download directory (default ~/Downloads/starling)",
        ),
      inline: z.boolean().optional().describe("Also return the CSV contents in the response (default false)"),
    },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      const csv = await ctx.client.text({
        method: "GET",
        path: "/api/v2/accounts/{accountUid}/feed-export",
        params: { accountUid: account.accountUid },
        query: { start: args.start, end: args.end },
        accept: "text/csv",
      });
      const name = args.saveAs ?? `starling-${args.start}-to-${args.end ?? "today"}.csv`;
      const path = await saveDownload(ctx.config.downloadDir, name, csv);
      const rows = Math.max(0, csv.trim().split("\n").length - 1);
      return text(`Saved ${rows} transactions to ${path}${args.inline ? `\n\n${csv}` : ""}`);
    },
  }),
];
