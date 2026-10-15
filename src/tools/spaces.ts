import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readUploadFile } from "../files.js";
import { formatMoney } from "../money.js";
import { accountUid, currency, minorUnits, recurrence, uid } from "./schemas.js";
import { defineTool, done, image, json, orNotFound, requireConfirmation, type ToolContext, text } from "./types.js";

const GOAL_PATH = "/api/v2/account/{accountUid}/savings-goals";
const savingsGoalUid = uid("Savings goal (savings space) UID");

async function goalParams(ctx: ToolContext, args: { accountUid?: string; savingsGoalUid: string }) {
  const account = await ctx.accounts.account(args.accountUid);
  return { account, params: { accountUid: account.accountUid, savingsGoalUid: args.savingsGoalUid } };
}

function photoResult(res: { base64EncodedPhoto?: string } | null | undefined, what: string) {
  if (!res?.base64EncodedPhoto) return text(`No photo set for this ${what}.`);
  const b64 = res.base64EncodedPhoto.replace(/^data:[^;]+;base64,/, "");
  const head = Buffer.from(b64.slice(0, 16), "base64");
  const mime = head[0] === 0x89 ? "image/png" : head[0] === 0x47 ? "image/gif" : "image/jpeg";
  return image(b64, mime);
}

const goalFields = {
  name: z.string().min(1).describe("Name of the savings space"),
  currency: currency.optional().describe("Currency; defaults to the account's currency"),
  targetMinorUnits: minorUnits("Savings target").optional(),
  photoPath: z.string().optional().describe("Optional local image to use as the space's photo"),
};

async function goalBody(
  accountCurrency: string,
  args: { name: string; currency?: string; targetMinorUnits?: number; photoPath?: string },
) {
  const cur = args.currency ?? accountCurrency;
  return {
    name: args.name,
    currency: cur,
    target: args.targetMinorUnits !== undefined ? { currency: cur, minorUnits: args.targetMinorUnits } : undefined,
    base64EncodedPhoto: args.photoPath
      ? (await readUploadFile(args.photoPath, false)).data.toString("base64")
      : undefined,
  };
}

export const spaceTools = [
  defineTool({
    name: "list_spaces",
    title: "List spaces",
    description:
      "Lists all active spaces on an account: savings spaces (savings goals: name, total saved, target, %) and spending spaces (e.g. bills pots, Connected and Kite card spaces, with balance). A space UID can be used as categoryUid for transactions and payments.",
    tier: "read",
    operations: ["getSpaces"],
    readOnly: true,
    input: { accountUid },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/account/{accountUid}/spaces",
          params: { accountUid: account.accountUid },
        }),
      );
    },
  }),

  defineTool({
    name: "get_spending_space",
    title: "Get spending space",
    description: "Gets one spending space (balance, type, linked card).",
    tier: "read",
    operations: ["getSpendingSpace"],
    readOnly: true,
    input: { accountUid, spaceUid: uid("Spending space UID") },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/account/{accountUid}/spaces/spending/{spaceUid}",
          params: { accountUid: account.accountUid, spaceUid: args.spaceUid },
        }),
      );
    },
  }),

  defineTool({
    name: "get_space_photo",
    title: "Space photo",
    description: "Returns the photo of a space (savings or spending).",
    tier: "read",
    operations: ["getSpacePhoto"],
    readOnly: true,
    input: { accountUid, spaceUid: uid("Space UID") },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      const res = await orNotFound(
        ctx.client.json<{ base64EncodedPhoto?: string }>({
          method: "GET",
          path: "/api/v2/account/{accountUid}/spaces/{spaceUid}/photo",
          params: { accountUid: account.accountUid, spaceUid: args.spaceUid },
        }),
      );
      return photoResult(res, "space");
    },
  }),

  defineTool({
    name: "list_savings_goals",
    title: "List savings goals",
    description: "Lists savings goals (savings spaces) with total saved, target and percentage.",
    tier: "read",
    operations: ["getSavingsGoals"],
    readOnly: true,
    input: { accountUid },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({ method: "GET", path: GOAL_PATH, params: { accountUid: account.accountUid } }),
      );
    },
  }),

  defineTool({
    name: "get_savings_goal",
    title: "Get savings goal",
    description: "Gets one savings goal.",
    tier: "read",
    operations: ["getSavingsGoal"],
    readOnly: true,
    input: { accountUid, savingsGoalUid },
    async run(args, ctx) {
      const { params } = await goalParams(ctx, args);
      return json(await ctx.client.json({ method: "GET", path: `${GOAL_PATH}/{savingsGoalUid}`, params }));
    },
  }),

  defineTool({
    name: "get_savings_goal_photo",
    title: "Savings goal photo",
    description: "Returns the photo of a savings goal.",
    tier: "read",
    operations: ["getSavingsGoalPhoto"],
    readOnly: true,
    input: { accountUid, savingsGoalUid },
    async run(args, ctx) {
      const { params } = await goalParams(ctx, args);
      const res = await orNotFound(
        ctx.client.json<{ base64EncodedPhoto?: string }>({
          method: "GET",
          path: `${GOAL_PATH}/{savingsGoalUid}/photo`,
          params,
        }),
      );
      return photoResult(res, "savings goal");
    },
  }),

  defineTool({
    name: "create_savings_goal",
    title: "Create savings goal",
    description: "Creates a new savings space, optionally with a target and photo.",
    tier: "write",
    operations: ["createSavingsGoal"],
    input: { accountUid, ...goalFields },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({
          method: "PUT",
          path: GOAL_PATH,
          params: { accountUid: account.accountUid },
          json: await goalBody(account.currency, args),
        }),
      );
    },
  }),

  defineTool({
    name: "update_savings_goal",
    title: "Update savings goal",
    description: "Renames a savings space or changes its target / photo. Pass the name even if unchanged.",
    tier: "write",
    operations: ["updateSavingsGoal"],
    idempotent: true,
    input: { accountUid, savingsGoalUid, ...goalFields },
    async run(args, ctx) {
      const { account, params } = await goalParams(ctx, args);
      return json(
        await ctx.client.json({
          method: "PUT",
          path: `${GOAL_PATH}/{savingsGoalUid}`,
          params,
          json: await goalBody(account.currency, args),
        }),
      );
    },
  }),

  defineTool({
    name: "delete_savings_goal",
    title: "Delete savings goal",
    description:
      "Deletes a savings space. Any money in it is returned to the main balance by Starling. Requires the user's confirmation.",
    tier: "write",
    operations: ["deleteSavingsGoal"],
    confirm: true,
    destructive: true,
    input: { accountUid, savingsGoalUid },
    async run(args, ctx) {
      const { params } = await goalParams(ctx, args);
      const goal = await ctx.client.json<{ name: string; totalSaved?: { currency: string; minorUnits: number } }>({
        method: "GET",
        path: `${GOAL_PATH}/{savingsGoalUid}`,
        params,
      });
      const saved = goal.totalSaved ? formatMoney(goal.totalSaved.minorUnits, goal.totalSaved.currency) : "unknown";
      await requireConfirmation(
        ctx,
        "delete_savings_goal",
        `Delete the savings space "${goal.name}" (currently holding ${saved}).`,
        args,
      );
      await ctx.client.json({ method: "DELETE", path: `${GOAL_PATH}/{savingsGoalUid}`, params });
      return done(`Savings space "${goal.name}" deleted.`);
    },
  }),

  defineTool({
    name: "transfer_to_savings_goal",
    title: "Move money into a savings space",
    description:
      "Moves money from the main balance into one of your own savings spaces. Money stays in your account and can be withdrawn again.",
    tier: "write",
    operations: ["addMoney"],
    input: {
      accountUid,
      savingsGoalUid,
      amountMinorUnits: minorUnits("Amount").refine((v) => v > 0, "Amount must be greater than zero"),
      reference: z.string().max(100).optional(),
      transferUid: uid("Idempotency key; generated automatically if omitted").optional(),
    },
    async run(args, ctx) {
      const { account, params } = await goalParams(ctx, args);
      const transferUid = args.transferUid ?? randomUUID();
      const res = await ctx.client.json({
        method: "PUT",
        path: `${GOAL_PATH}/{savingsGoalUid}/add-money/{transferUid}`,
        params: { ...params, transferUid },
        json: { amount: { currency: account.currency, minorUnits: args.amountMinorUnits }, reference: args.reference },
      });
      return done(`Moved ${formatMoney(args.amountMinorUnits, account.currency)} into the savings space.`, res);
    },
  }),

  defineTool({
    name: "withdraw_from_savings_goal",
    title: "Move money out of a savings space",
    description: "Moves money from one of your savings spaces back to the main balance.",
    tier: "write",
    operations: ["withdrawMoney"],
    input: {
      accountUid,
      savingsGoalUid,
      amountMinorUnits: minorUnits("Amount").refine((v) => v > 0, "Amount must be greater than zero"),
      reference: z.string().max(100).optional(),
      transferUid: uid("Idempotency key; generated automatically if omitted").optional(),
    },
    async run(args, ctx) {
      const { account, params } = await goalParams(ctx, args);
      const transferUid = args.transferUid ?? randomUUID();
      const res = await ctx.client.json({
        method: "PUT",
        path: `${GOAL_PATH}/{savingsGoalUid}/withdraw-money/{transferUid}`,
        params: { ...params, transferUid },
        json: { amount: { currency: account.currency, minorUnits: args.amountMinorUnits }, reference: args.reference },
      });
      return done(`Moved ${formatMoney(args.amountMinorUnits, account.currency)} back to the main balance.`, res);
    },
  }),

  defineTool({
    name: "get_savings_goal_recurring_transfer",
    title: "Savings recurring transfer",
    description: "Gets the recurring transfer (automatic top-up) into a savings space, if one is set.",
    tier: "read",
    operations: ["getRecurringTransfer"],
    readOnly: true,
    input: { accountUid, savingsGoalUid },
    async run(args, ctx) {
      const { params } = await goalParams(ctx, args);
      return json(
        await ctx.client.json({ method: "GET", path: `${GOAL_PATH}/{savingsGoalUid}/recurring-transfer`, params }),
      );
    },
  }),

  defineTool({
    name: "set_savings_goal_recurring_transfer",
    title: "Set savings recurring transfer",
    description:
      "Creates or replaces an automatic recurring transfer from the main balance into a savings space (e.g. £50 every month, or weekly on chosen days).",
    tier: "write",
    operations: ["createOrUpdateRecurringTransfer"],
    idempotent: true,
    input: {
      accountUid,
      savingsGoalUid,
      amountMinorUnits: minorUnits("Amount per transfer").refine((v) => v > 0, "Amount must be greater than zero"),
      recurrence: recurrence.extend({
        days: z
          .array(z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]))
          .optional()
          .describe("For WEEKLY: which days of the week"),
      }),
      topUp: z.boolean().optional().describe("Top up to the amount rather than adding it"),
      reference: z.string().max(100).optional(),
    },
    async run(args, ctx) {
      const { account, params } = await goalParams(ctx, args);
      return json(
        await ctx.client.json({
          method: "PUT",
          path: `${GOAL_PATH}/{savingsGoalUid}/recurring-transfer`,
          params,
          json: {
            recurrenceRule: args.recurrence,
            amount: { currency: account.currency, minorUnits: args.amountMinorUnits },
            topUp: args.topUp,
            reference: args.reference,
          },
        }),
      );
    },
  }),

  defineTool({
    name: "delete_savings_goal_recurring_transfer",
    title: "Stop savings recurring transfer",
    description: "Stops the automatic recurring transfer into a savings space.",
    tier: "write",
    operations: ["deleteRecurringTransfer"],
    destructive: true,
    idempotent: true,
    input: { accountUid, savingsGoalUid },
    async run(args, ctx) {
      const { params } = await goalParams(ctx, args);
      await ctx.client.json({ method: "DELETE", path: `${GOAL_PATH}/{savingsGoalUid}/recurring-transfer`, params });
      return done("Recurring transfer stopped.");
    },
  }),

  defineTool({
    name: "get_round_up",
    title: "Round-up settings",
    description: "Shows whether round-ups are active, which savings space they go to, and the multiplier.",
    tier: "read",
    operations: ["fetchRoundUpGoal"],
    readOnly: true,
    input: { accountUid },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      return json(
        await ctx.client.json({
          method: "GET",
          path: "/api/v2/feed/account/{accountUid}/round-up",
          params: { accountUid: account.accountUid },
        }),
      );
    },
  }),

  defineTool({
    name: "enable_round_up",
    title: "Enable round-ups",
    description:
      "Turns on round-ups: each card payment is rounded up to the next pound and the difference (times the multiplier, 1-10) is moved into a savings space.",
    tier: "write",
    operations: ["activateRoundUpGoal"],
    idempotent: true,
    input: {
      accountUid,
      savingsGoalUid: uid("Savings space to send round-ups to"),
      multiplier: z.number().int().min(1).max(10).optional().describe("1 to 10 (default 1)"),
    },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      await ctx.client.json({
        method: "PUT",
        path: "/api/v2/feed/account/{accountUid}/round-up",
        params: { accountUid: account.accountUid },
        json: { roundUpGoalUid: args.savingsGoalUid, roundUpMultiplier: args.multiplier ?? 1 },
      });
      return done(`Round-ups enabled (x${args.multiplier ?? 1}).`);
    },
  }),

  defineTool({
    name: "disable_round_up",
    title: "Disable round-ups",
    description: "Turns off round-ups for the account.",
    tier: "write",
    operations: ["stopRoundUpGoal"],
    destructive: true,
    idempotent: true,
    input: { accountUid },
    async run(args, ctx) {
      const account = await ctx.accounts.account(args.accountUid);
      await ctx.client.json({
        method: "DELETE",
        path: "/api/v2/feed/account/{accountUid}/round-up",
        params: { accountUid: account.accountUid },
      });
      return done("Round-ups disabled.");
    },
  }),
];
