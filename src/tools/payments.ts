import { randomUUID } from "node:crypto";
import { z } from "zod";
import { formatMoney } from "../money.js";
import { describePayeeAccount, findPayeeAccount, listPayees } from "./payees.js";
import { accountUid, categoryUid, minorUnits, paymentReference, recurrence, spendingCategory, uid } from "./schemas.js";
import { defineTool, done, json, prune, requireConfirmation, type ToolContext } from "./types.js";

const SO_PATH = "/api/v2/payments/local/account/{accountUid}/category/{categoryUid}/standing-orders";

function enforceLimit(ctx: ToolContext, amount: number, currency: string): void {
  const limit = ctx.config.paymentLimitMinorUnits;
  if (limit !== undefined && amount > limit) {
    throw new Error(
      `${formatMoney(amount, currency)} is above this server's payment limit of ${formatMoney(limit, currency)} ` +
        "(STARLING_PAYMENT_LIMIT_MINOR_UNITS). Nothing was done.",
    );
  }
}

function describeRecurrence(r: z.infer<typeof recurrence>): string {
  const every = r.interval && r.interval > 1 ? `every ${r.interval} ` : "";
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[r.frequency];
  const base = every ? `${every}${unit}s` : r.frequency.toLowerCase();
  const end = r.count ? `, ${r.count} payments` : r.untilDate ? `, until ${r.untilDate}` : ", until cancelled";
  return `${base} from ${r.startDate}${end}`;
}

interface OrderPayment {
  paymentUid: string;
  amount: { currency: string; minorUnits: number };
  reference?: string;
  createdAt: string;
  completedAt?: string | null;
  rejectedAt?: string | null;
  paymentStatusDetails?: { paymentStatus?: string; description?: string };
}

interface StandingOrder {
  paymentOrderUid: string;
  amount: { currency: string; minorUnits: number };
  reference: string;
  payeeUid?: string;
  payeeAccountUid?: string;
  standingOrderRecurrence: z.infer<typeof recurrence>;
  nextDate?: string;
  cancelledAt?: string;
  spendingCategory?: string;
}

export const paymentTools = [
  defineTool({
    name: "make_payment",
    title: "Send a payment",
    description:
      "Sends an immediate payment (UK Faster Payments, or SEPA from a EUR account) to an EXISTING saved payee account. " +
      "With a personal access token Starling only allows payments to existing payees. Requires request signing and the user's confirmation; " +
      "subject to the server's payment limit. Starling may hold the payment for review (PENDING) for a few hours.",
    tier: "payments",
    operations: ["makeLocalPayment"],
    confirm: true,
    input: {
      accountUid,
      categoryUid: categoryUid.describe("Pay from this space/category instead of the main balance (optional)"),
      destinationPayeeAccountUid: uid("payeeAccountUid of the recipient, from list_payees"),
      amountMinorUnits: minorUnits("Amount").refine((v) => v > 0, "Amount must be greater than zero"),
      reference: z
        .string()
        .min(1)
        .max(35)
        .regex(
          /^[a-zA-Z0-9\-/?:().,+#=!%&*<>;{@ "']{1,35}$/,
          "reference contains characters the payment scheme rejects",
        )
        .describe("Reference shown to the recipient (max 18 characters from GBP accounts, 35 from EUR)"),
      spendingCategory: spendingCategory.optional(),
      externalIdentifier: z
        .string()
        .max(100)
        .optional()
        .describe("Idempotency key; generated automatically if omitted"),
    },
    auditDetails: (a) => ({
      destinationPayeeAccountUid: a.destinationPayeeAccountUid,
      amountMinorUnits: a.amountMinorUnits,
      reference: a.reference,
    }),
    async run(args, ctx) {
      const {
        accountUid: acc,
        categoryUid: cat,
        currency,
      } = await ctx.accounts.category(args.accountUid, args.categoryUid);
      if (currency === "GBP" && args.reference.length > 18) {
        throw new Error("References are limited to 18 characters for GBP (Faster Payments). Nothing was done.");
      }
      enforceLimit(ctx, args.amountMinorUnits, currency || "GBP");
      const { payee, account } = await findPayeeAccount(ctx, args.destinationPayeeAccountUid);
      const amount = formatMoney(args.amountMinorUnits, currency || "GBP");
      await requireConfirmation(
        ctx,
        "make_payment",
        `Send ${amount} now\nTo: ${describePayeeAccount(payee, account)}\nReference: "${args.reference}"\nFrom account ${acc}${cat ? ` (category ${cat})` : ""}`,
        args,
      );
      const res = await ctx.client.json({
        method: "PUT",
        path: "/api/v2/payments/local/account/{accountUid}/category/{categoryUid}",
        params: { accountUid: acc, categoryUid: cat },
        json: {
          externalIdentifier: args.externalIdentifier ?? randomUUID(),
          destinationPayeeAccountUid: args.destinationPayeeAccountUid,
          reference: args.reference,
          amount: { currency: currency || "GBP", minorUnits: args.amountMinorUnits },
          spendingCategory: args.spendingCategory,
        },
        signed: true,
      });
      return done(
        `Payment of ${amount} to ${payee.payeeName} instructed. Use get_payment_order / list_payment_order_payments to check its status.`,
        res,
      );
    },
  }),

  defineTool({
    name: "get_payment_order",
    title: "Get payment order",
    description: "Gets a payment order (an instructed payment or standing order) by its paymentOrderUid.",
    tier: "read",
    operations: ["getPaymentOrder"],
    readOnly: true,
    input: { paymentOrderUid: uid("Payment order UID") },
    async run(args, ctx) {
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/payments/local/payment-order/{paymentOrderUid}",
          params: { paymentOrderUid: args.paymentOrderUid },
        }),
      );
    },
  }),

  defineTool({
    name: "list_payment_order_payments",
    title: "Payments for a payment order",
    description:
      "Lists the actual payments made under a payment order (newest first), with status (PENDING, ACCEPTED, REJECTED) and reasons. Use after make_payment to check it went through.",
    tier: "read",
    operations: ["getPaymentOrderPayments"],
    readOnly: true,
    input: {
      paymentOrderUid: uid("Payment order UID"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max payments returned (default 24)"),
      detail: z.enum(["compact", "full"]).optional(),
    },
    async run(args, ctx) {
      const res = await ctx.client.json<{ payments?: OrderPayment[] }>({
        method: "GET",
        path: "/api/v2/payments/local/payment-order/{paymentOrderUid}/payments",
        params: { paymentOrderUid: args.paymentOrderUid },
      });
      const all = [...(res?.payments ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const limited = all.slice(0, args.limit ?? 24);
      return json({
        total: all.length,
        returned: limited.length,
        payments:
          args.detail === "full"
            ? limited
            : limited.map((p) =>
                prune({
                  paymentUid: p.paymentUid,
                  amount: formatMoney(p.amount.minorUnits, p.amount.currency),
                  reference: p.reference,
                  created: p.createdAt,
                  completed: p.completedAt,
                  rejected: p.rejectedAt,
                  status: p.paymentStatusDetails?.paymentStatus,
                  reason:
                    p.paymentStatusDetails?.description !== p.paymentStatusDetails?.paymentStatus
                      ? p.paymentStatusDetails?.description
                      : undefined,
                }),
              ),
      });
    },
  }),

  defineTool({
    name: "list_standing_orders",
    title: "List standing orders",
    description:
      "Lists standing orders paid from the main account (or a space): payee name, amount, reference, schedule and next date. " +
      "Active ones only by default (includeCancelled to see the rest). Orders awaiting review are not included.",
    tier: "read",
    operations: ["listStandingOrders"],
    readOnly: true,
    input: {
      accountUid,
      categoryUid,
      includeCancelled: z.boolean().optional().describe("Include cancelled standing orders (default false)"),
      detail: z.enum(["compact", "full"]).optional(),
    },
    async run(args, ctx) {
      const r = await ctx.accounts.category(args.accountUid, args.categoryUid);
      const res = await ctx.client.json<{ standingOrders?: StandingOrder[] }>({
        method: "GET",
        path: SO_PATH,
        params: r,
      });
      const orders = (res?.standingOrders ?? []).filter((o) => args.includeCancelled || !o.cancelledAt);
      if (args.detail === "full") return json({ count: orders.length, standingOrders: orders });
      const names = new Map<string, string>();
      if (orders.length)
        for (const p of await listPayees(ctx))
          for (const a of p.accounts ?? []) names.set(a.payeeAccountUid, p.payeeName);
      return json({
        count: orders.length,
        standingOrders: orders.map((o) =>
          prune({
            paymentOrderUid: o.paymentOrderUid,
            payee: o.payeeAccountUid ? names.get(o.payeeAccountUid) : undefined,
            payeeAccountUid: o.payeeAccountUid,
            amount: formatMoney(o.amount.minorUnits, o.amount.currency),
            reference: o.reference,
            schedule: describeRecurrence(o.standingOrderRecurrence),
            nextDate: o.cancelledAt ? undefined : o.nextDate,
            cancelled: o.cancelledAt?.slice(0, 10),
            spendingCategory: o.spendingCategory,
          }),
        ),
      });
    },
  }),

  defineTool({
    name: "get_standing_order",
    title: "Get standing order",
    description:
      "Gets one standing order. A null startDate means it is awaiting review; a non-null cancelledAt means it has been cancelled.",
    tier: "read",
    operations: ["getStandingOrder"],
    readOnly: true,
    input: { accountUid, categoryUid, paymentOrderUid: uid("Standing order paymentOrderUid") },
    async run(args, ctx) {
      const r = await ctx.accounts.category(args.accountUid, args.categoryUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: `${SO_PATH}/{paymentOrderUid}`,
          params: { ...r, paymentOrderUid: args.paymentOrderUid },
        }),
      );
    },
  }),

  defineTool({
    name: "list_standing_order_upcoming_payments",
    title: "Standing order upcoming dates",
    description: "Lists the next payment dates of a standing order (1 to 100, default 10).",
    tier: "read",
    operations: ["listNextPaymentDates"],
    readOnly: true,
    input: {
      accountUid,
      categoryUid,
      paymentOrderUid: uid("Standing order paymentOrderUid"),
      count: z.number().int().min(1).max(100).optional(),
    },
    async run(args, ctx) {
      const r = await ctx.accounts.category(args.accountUid, args.categoryUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: `${SO_PATH}/{paymentOrderUid}/upcoming-payments`,
          params: { ...r, paymentOrderUid: args.paymentOrderUid },
          query: { count: args.count },
        }),
      );
    },
  }),

  defineTool({
    name: "create_standing_order",
    title: "Create standing order",
    description:
      "Creates a standing order to an EXISTING saved payee account. Requires request signing and the user's confirmation; subject to the payment limit. Starling may hold it for review (PENDING) for a few hours.",
    tier: "payments",
    operations: ["createStandingOrder"],
    confirm: true,
    input: {
      accountUid,
      categoryUid: categoryUid.describe("Pay from this space/category instead of the main balance (optional)"),
      destinationPayeeAccountUid: uid("payeeAccountUid of the recipient, from list_payees"),
      amountMinorUnits: minorUnits("Amount per payment").refine((v) => v > 0, "Amount must be greater than zero"),
      reference: paymentReference,
      recurrence,
      spendingCategory: spendingCategory.optional(),
      externalIdentifier: z
        .string()
        .max(100)
        .optional()
        .describe("Idempotency key; generated automatically if omitted"),
    },
    async run(args, ctx) {
      const r = await ctx.accounts.category(args.accountUid, args.categoryUid);
      const cur = r.currency || "GBP";
      enforceLimit(ctx, args.amountMinorUnits, cur);
      const { payee, account } = await findPayeeAccount(ctx, args.destinationPayeeAccountUid);
      await requireConfirmation(
        ctx,
        "create_standing_order",
        `Create a standing order of ${formatMoney(args.amountMinorUnits, cur)} ${describeRecurrence(args.recurrence)}\n` +
          `To: ${describePayeeAccount(payee, account)}\nReference: "${args.reference}"`,
        args,
      );
      const res = await ctx.client.json({
        method: "PUT",
        path: SO_PATH,
        params: r,
        json: {
          externalIdentifier: args.externalIdentifier ?? randomUUID(),
          destinationPayeeAccountUid: args.destinationPayeeAccountUid,
          reference: args.reference,
          amount: { currency: cur, minorUnits: args.amountMinorUnits },
          standingOrderRecurrence: args.recurrence,
          spendingCategory: args.spendingCategory,
        },
        signed: true,
      });
      return done("Standing order created.", res);
    },
  }),

  defineTool({
    name: "update_standing_order",
    title: "Update standing order",
    description:
      "Changes a standing order's amount, reference, schedule or spending category. Omitted fields keep their current values. Some changes are not allowed (CANNOT_MAKE_REQUESTED_CHANGE): create a new standing order instead. Requires signing and confirmation.",
    tier: "payments",
    operations: ["updateStandingOrder"],
    confirm: true,
    idempotent: true,
    input: {
      accountUid,
      categoryUid,
      paymentOrderUid: uid("Standing order paymentOrderUid"),
      amountMinorUnits: minorUnits("New amount per payment").optional(),
      reference: paymentReference.optional(),
      recurrence: recurrence.optional(),
      spendingCategory: spendingCategory.optional(),
    },
    async run(args, ctx) {
      const r = await ctx.accounts.category(args.accountUid, args.categoryUid);
      const params = { ...r, paymentOrderUid: args.paymentOrderUid };
      const current = await ctx.client.json<StandingOrder>({
        method: "GET",
        path: `${SO_PATH}/{paymentOrderUid}`,
        params,
      });
      const cur = current.amount.currency;
      const amount = args.amountMinorUnits ?? current.amount.minorUnits;
      enforceLimit(ctx, amount, cur);
      const next = {
        paymentOrderUid: args.paymentOrderUid,
        reference: args.reference ?? current.reference,
        amount: { currency: cur, minorUnits: amount },
        standingOrderRecurrence: args.recurrence ?? current.standingOrderRecurrence,
        spendingCategory: args.spendingCategory ?? current.spendingCategory,
      };
      await requireConfirmation(
        ctx,
        "update_standing_order",
        `Update standing order "${current.reference}":\n` +
          `Amount: ${formatMoney(current.amount.minorUnits, cur)} → ${formatMoney(amount, cur)}\n` +
          `Reference: "${current.reference}" → "${next.reference}"\n` +
          `Schedule: ${describeRecurrence(current.standingOrderRecurrence)} → ${describeRecurrence(next.standingOrderRecurrence)}`,
        args,
      );
      return done(
        "Standing order updated.",
        await ctx.client.json({
          method: "PUT",
          path: `${SO_PATH}/{paymentOrderUid}`,
          params,
          json: next,
          signed: true,
        }),
      );
    },
  }),

  defineTool({
    name: "cancel_standing_order",
    title: "Cancel standing order",
    description:
      "Cancels a standing order so no further payments are made. Fails with CANNOT_CANCEL_PENDING_PAYMENT_ORDER while it is awaiting review. Requires signing and confirmation.",
    tier: "payments",
    operations: ["cancelStandingOrder"],
    confirm: true,
    destructive: true,
    input: { accountUid, categoryUid, paymentOrderUid: uid("Standing order paymentOrderUid") },
    async run(args, ctx) {
      const r = await ctx.accounts.category(args.accountUid, args.categoryUid);
      const params = { ...r, paymentOrderUid: args.paymentOrderUid };
      const current = await ctx.client.json<StandingOrder>({
        method: "GET",
        path: `${SO_PATH}/{paymentOrderUid}`,
        params,
      });
      await requireConfirmation(
        ctx,
        "cancel_standing_order",
        `Cancel the standing order of ${formatMoney(current.amount.minorUnits, current.amount.currency)} ` +
          `${describeRecurrence(current.standingOrderRecurrence)}, reference "${current.reference}"` +
          `${current.nextDate ? ` (next payment ${current.nextDate})` : ""}.`,
        args,
      );
      await ctx.client.json({ method: "DELETE", path: `${SO_PATH}/{paymentOrderUid}`, params, signed: true });
      return done(`Standing order "${current.reference}" cancelled.`);
    },
  }),
];
