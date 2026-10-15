import { date, uid } from "./schemas.js";
import { defineTool, done, json, requireConfirmation } from "./types.js";

export const directDebitTools = [
  defineTool({
    name: "list_direct_debit_mandates",
    title: "List direct debits",
    description:
      "Lists direct debit mandates (who can take money by direct debit), with originator, reference, status, created date and last payment. Pass accountUid to restrict to one account.",
    tier: "read",
    operations: ["listMandates", "listMandatesForAccount"],
    readOnly: true,
    input: { accountUid: uid("Only list mandates for this account").optional() },
    async run(args, ctx) {
      return json(
        args.accountUid
          ? await ctx.client.json({
              method: "GET",
              path: "/api/v2/direct-debit/mandates/account/{accountUid}",
              params: { accountUid: args.accountUid },
            })
          : await ctx.client.json({ method: "GET", path: "/api/v2/direct-debit/mandates" }),
      );
    },
  }),

  defineTool({
    name: "get_direct_debit_mandate",
    title: "Get direct debit",
    description: "Gets one direct debit mandate.",
    tier: "read",
    operations: ["getMandate"],
    readOnly: true,
    input: { mandateUid: uid("Mandate UID") },
    async run(args, ctx) {
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/direct-debit/mandates/{mandateUid}",
          params: { mandateUid: args.mandateUid },
        }),
      );
    },
  }),

  defineTool({
    name: "list_direct_debit_payments",
    title: "Direct debit payment history",
    description: "Lists the payments taken under a direct debit mandate since a date.",
    tier: "read",
    operations: ["listPaymentsForMandate"],
    readOnly: true,
    input: { mandateUid: uid("Mandate UID"), since: date("Start date") },
    async run(args, ctx) {
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/direct-debit/mandates/{mandateUid}/payments",
          params: { mandateUid: args.mandateUid },
          query: { since: args.since },
        }),
      );
    },
  }),

  defineTool({
    name: "cancel_direct_debit_mandate",
    title: "Cancel direct debit",
    description:
      "Cancels a direct debit mandate so the originator can no longer collect payments. Cannot be undone from here (the originator would need to set up a new mandate). Requires the user's confirmation.",
    tier: "write",
    operations: ["cancelMandate"],
    confirm: true,
    destructive: true,
    input: { mandateUid: uid("Mandate UID") },
    async run(args, ctx) {
      const mandate = await ctx.client.json<Record<string, unknown>>({
        method: "GET",
        path: "/api/v2/direct-debit/mandates/{mandateUid}",
        params: { mandateUid: args.mandateUid },
      });
      await requireConfirmation(
        ctx,
        "cancel_direct_debit_mandate",
        `Cancel the direct debit to ${String(mandate?.originatorName ?? "unknown originator")} ` +
          `(reference ${String(mandate?.reference ?? "?")}, status ${String(mandate?.status ?? "?")}, mandate ${args.mandateUid}).`,
        args,
      );
      await ctx.client.json({
        method: "DELETE",
        path: "/api/v2/direct-debit/mandates/{mandateUid}",
        params: { mandateUid: args.mandateUid },
      });
      return done(`Direct debit mandate ${args.mandateUid} cancelled.`);
    },
  }),
];
