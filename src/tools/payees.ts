import { z } from "zod";
import { saveDownload } from "../files.js";
import { date, payeeAccount, uid } from "./schemas.js";
import { defineTool, done, image, json, requireConfirmation, type ToolContext } from "./types.js";

export interface PayeeAccount {
  payeeAccountUid: string;
  description?: string;
  defaultAccount?: boolean;
  countryCode?: string;
  accountIdentifier?: string;
  bankIdentifier?: string;
  bankIdentifierType?: string;
}

export interface Payee {
  payeeUid: string;
  payeeName: string;
  payeeType?: string;
  accounts?: PayeeAccount[];
}

export async function listPayees(ctx: ToolContext): Promise<Payee[]> {
  const res = await ctx.client.json<{ payees?: Payee[] }>({ method: "GET", path: "/api/v2/payees" });
  return res?.payees ?? [];
}

/** Finds the payee that owns a payee account, so confirmations can name who is being paid. */
export async function findPayeeAccount(
  ctx: ToolContext,
  payeeAccountUid: string,
): Promise<{ payee: Payee; account: PayeeAccount }> {
  for (const payee of await listPayees(ctx)) {
    const account = payee.accounts?.find((a) => a.payeeAccountUid === payeeAccountUid);
    if (account) return { payee, account };
  }
  throw new Error(
    `No existing payee account ${payeeAccountUid}. Payments can only go to existing payees; use list_payees to find the payeeAccountUid.`,
  );
}

export function describePayeeAccount(payee: { payeeName: string }, a: Partial<PayeeAccount>): string {
  const id =
    a.bankIdentifierType === "SORT_CODE" && a.bankIdentifier
      ? `sort code ${a.bankIdentifier.replace(/^(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3")}, account ${a.accountIdentifier}`
      : `${a.bankIdentifierType ?? "bank"} ${a.bankIdentifier ?? "?"}, account ${a.accountIdentifier ?? "?"}`;
  return `${payee.payeeName} (${id}${a.description ? `, "${a.description}"` : ""})`;
}

const payeeFields = {
  payeeName: z.string().min(1).max(255).describe("Name as it should appear, e.g. the account holder's name"),
  payeeType: z.enum(["INDIVIDUAL", "BUSINESS"]),
  phoneNumber: z.string().max(20).optional(),
  firstName: z.string().min(1).max(255).optional(),
  middleName: z.string().min(1).max(255).optional(),
  lastName: z.string().min(1).max(255).optional(),
  businessName: z.string().min(1).max(255).optional(),
  dateOfBirth: date("Payee date of birth").optional(),
};

export const payeeTools = [
  defineTool({
    name: "list_payees",
    title: "List payees",
    description:
      "Lists saved payees and their accounts (payeeAccountUid, sort code / account number, recent references). Payments and standing orders are made to a payeeAccountUid from here.",
    tier: "read",
    operations: ["getPayees"],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json({ payees: await listPayees(ctx) });
    },
  }),

  defineTool({
    name: "get_payee",
    title: "Get payee",
    description: "Gets one saved payee and its accounts.",
    tier: "read",
    operations: ["getPayee"],
    readOnly: true,
    input: { payeeUid: uid("Payee UID") },
    async run(args, ctx) {
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/payees/{payeeUid}",
          params: { payeeUid: args.payeeUid },
        }),
      );
    },
  }),

  defineTool({
    name: "get_payee_image",
    title: "Payee image",
    description: "Returns the payee's image (PNG), if one exists.",
    tier: "read",
    operations: ["servePayeeImageFile"],
    readOnly: true,
    input: { payeeUid: uid("Payee UID"), saveAs: z.string().optional().describe("Also save to this file") },
    async run(args, ctx) {
      const img = await ctx.client.binary({
        method: "GET",
        path: "/api/v2/payees/{payeeUid}/image",
        params: { payeeUid: args.payeeUid },
        accept: "image/png",
      });
      const saved = args.saveAs ? await saveDownload(ctx.config.downloadDir, args.saveAs, img.data) : undefined;
      return image(img.data.toString("base64"), img.contentType, saved ? `Saved to ${saved}` : undefined);
    },
  }),

  defineTool({
    name: "list_payee_payments",
    title: "Payments to a payee",
    description: "Lists the history of payments made to a payee account since a date.",
    tier: "read",
    operations: ["listPaymentsForPayeeAccount"],
    readOnly: true,
    input: {
      payeeUid: uid("Payee UID"),
      payeeAccountUid: uid("Payee account UID"),
      since: date("Start date"),
    },
    async run(args, ctx) {
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/payees/{payeeUid}/account/{accountUid}/payments",
          params: { payeeUid: args.payeeUid, accountUid: args.payeeAccountUid },
          query: { since: args.since },
        }),
      );
    },
  }),

  defineTool({
    name: "list_payee_scheduled_payments",
    title: "Scheduled payments to a payee",
    description: "Lists scheduled (future-dated and recurring) payments to a payee account.",
    tier: "read",
    operations: ["listPaymentOrdersForAccount"],
    readOnly: true,
    input: { payeeUid: uid("Payee UID"), payeeAccountUid: uid("Payee account UID") },
    async run(args, ctx) {
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/payees/{payeeUid}/account/{accountUid}/scheduled-payments",
          params: { payeeUid: args.payeeUid, accountUid: args.payeeAccountUid },
        }),
      );
    },
  }),

  defineTool({
    name: "create_payee",
    title: "Create payee",
    description:
      "Saves a new payee with one or more bank accounts. Starling runs Confirmation of Payee on UK accounts. Requires the user's confirmation. Once created, payments can be sent to it. Starling does not allow payee:create on the same personal token as payment scopes (pay-local:create, standing-order:create), so with a payments token this fails with 403: add the payee in the Starling app instead, or use a separate payee-only token.",
    tier: "payments",
    operations: ["createPayee"],
    confirm: true,
    input: { ...payeeFields, accounts: z.array(payeeAccount).min(1) },
    async run(args, ctx) {
      const { confirmationCode: _c, ...body } = args as typeof args & { confirmationCode?: string };
      await requireConfirmation(
        ctx,
        "create_payee",
        `Create a new ${args.payeeType.toLowerCase()} payee:\n` +
          args.accounts.map((a) => `• ${describePayeeAccount(args, a)}`).join("\n"),
        args,
      );
      return json(await ctx.client.json({ method: "PUT", path: "/api/v2/payees", json: body }));
    },
  }),

  defineTool({
    name: "update_payee",
    title: "Update payee",
    description:
      "Updates a payee's details (name, type, contact details). The full payee is replaced, so pass all fields to keep. Requires the user's confirmation.",
    tier: "payments",
    operations: ["updatePayee"],
    confirm: true,
    idempotent: true,
    input: {
      payeeUid: uid("Payee UID"),
      ...payeeFields,
      accounts: z.array(payeeAccount).optional().describe("Accounts to include in the update, if any"),
    },
    async run(args, ctx) {
      const { confirmationCode: _c, payeeUid, ...body } = args as typeof args & { confirmationCode?: string };
      await requireConfirmation(
        ctx,
        "update_payee",
        `Update payee ${payeeUid} to name "${args.payeeName}" (${args.payeeType}).`,
        args,
      );
      return json(
        await ctx.client.json({ method: "PUT", path: "/api/v2/payees/{payeeUid}", params: { payeeUid }, json: body }),
      );
    },
  }),

  defineTool({
    name: "add_payee_account",
    title: "Add payee account",
    description:
      "Adds another bank account to an existing payee. Requires the user's confirmation. Starling does not allow payee:create on the same personal token as payment scopes (pay-local:create, standing-order:create), so with a payments token this fails with 403: add the payee in the Starling app instead, or use a separate payee-only token.",
    tier: "payments",
    operations: ["createPayeeAccount"],
    confirm: true,
    input: { payeeUid: uid("Payee UID"), account: payeeAccount },
    async run(args, ctx) {
      const payee = await ctx.client.json<Payee>({
        method: "GET",
        path: "/api/v2/payees/{payeeUid}",
        params: { payeeUid: args.payeeUid },
      });
      await requireConfirmation(
        ctx,
        "add_payee_account",
        `Add a new account to payee: ${describePayeeAccount(payee, args.account)}`,
        args,
      );
      return json(
        await ctx.client.json({
          method: "PUT",
          path: "/api/v2/payees/{payeeUid}/account",
          params: { payeeUid: args.payeeUid },
          json: args.account,
        }),
      );
    },
  }),

  defineTool({
    name: "delete_payee",
    title: "Delete payee",
    description: "Deletes a saved payee and all its accounts. Requires the user's confirmation.",
    tier: "payments",
    operations: ["deletePayee"],
    confirm: true,
    destructive: true,
    input: { payeeUid: uid("Payee UID") },
    async run(args, ctx) {
      const payee = await ctx.client.json<Payee>({
        method: "GET",
        path: "/api/v2/payees/{payeeUid}",
        params: { payeeUid: args.payeeUid },
      });
      await requireConfirmation(
        ctx,
        "delete_payee",
        `Delete payee "${payee.payeeName}" and its ${payee.accounts?.length ?? 0} account(s).`,
        args,
      );
      await ctx.client.json({
        method: "DELETE",
        path: "/api/v2/payees/{payeeUid}",
        params: { payeeUid: args.payeeUid },
      });
      return done(`Payee "${payee.payeeName}" deleted.`);
    },
  }),

  defineTool({
    name: "delete_payee_account",
    title: "Delete payee account",
    description: "Removes one bank account from a payee. Requires the user's confirmation.",
    tier: "payments",
    operations: ["deletePayeeAccount"],
    confirm: true,
    destructive: true,
    input: { payeeUid: uid("Payee UID"), payeeAccountUid: uid("Payee account UID") },
    async run(args, ctx) {
      const { payee, account } = await findPayeeAccount(ctx, args.payeeAccountUid);
      await requireConfirmation(
        ctx,
        "delete_payee_account",
        `Remove account ${describePayeeAccount(payee, account)} from payee "${payee.payeeName}".`,
        args,
      );
      await ctx.client.json({
        method: "DELETE",
        path: "/api/v2/payees/{payeeUid}/account/{accountUid}",
        params: { payeeUid: args.payeeUid, accountUid: args.payeeAccountUid },
      });
      return done("Payee account removed.");
    },
  }),
];
