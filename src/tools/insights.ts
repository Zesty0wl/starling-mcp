import { z } from "zod";
import { type FeedItem, fetchFeedBetween, filterFeed, isInternalTransfer, toTimestamp } from "../feed.js";
import { formatMoney } from "../money.js";
import { SPENDING_CATEGORIES } from "../spendingCategories.js";
import { accountUid, categoryUid, dateTime } from "./schemas.js";
import { defineTool, json } from "./types.js";

type Amount = { currency: string; minorUnits: number };

const DAY = 86400_000;
const COUNTED_STATUSES = ["SETTLED", "PENDING"];

function startOfMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const CADENCES = [
  { name: "weekly", days: 7, perYear: 52 },
  { name: "fortnightly", days: 14, perYear: 26 },
  { name: "four-weekly", days: 28, perYear: 13 },
  { name: "monthly", days: 30.4, perYear: 12 },
  { name: "quarterly", days: 91, perYear: 4 },
  { name: "six-monthly", days: 182, perYear: 2 },
  { name: "yearly", days: 365, perYear: 1 },
];

export function classifyCadence(intervalDays: number) {
  let best: (typeof CADENCES)[number] | undefined;
  let bestErr = Number.POSITIVE_INFINITY;
  for (const c of CADENCES) {
    const err = Math.abs(intervalDays - c.days) / c.days;
    if (err < bestErr) {
      best = c;
      bestErr = err;
    }
  }
  return best && bestErr <= 0.15 ? best : undefined;
}

function normaliseName(item: FeedItem): string {
  return (item.counterPartyName ?? item.reference ?? "Unknown").trim().replace(/\s+/g, " ").toUpperCase();
}

export interface RecurringPayment {
  counterParty: string;
  cadence: string;
  occurrences: number;
  medianIntervalDays: number;
  lastPaid: string;
  nextExpected: string;
  likelyActive: boolean;
  lastAmount: string;
  averageAmount: string;
  amountVaries: boolean;
  estimatedAnnualCost: string;
  annualMinorUnits: number;
  sources: string[];
  spendingCategory?: string;
}

/** Finds payments to the same counterparty that repeat on a regular cadence. */
export function detectRecurring(items: FeedItem[], now = Date.now(), minOccurrences = 3): RecurringPayment[] {
  const groups = new Map<string, FeedItem[]>();
  for (const i of items) {
    if (i.direction !== "OUT" || isInternalTransfer(i) || !COUNTED_STATUSES.includes(i.status)) continue;
    const key = `${normaliseName(i)}|${i.amount.currency}`;
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  }

  const out: RecurringPayment[] = [];
  for (const list of groups.values()) {
    if (list.length < minOccurrences) continue;
    list.sort((a, b) => Date.parse(a.transactionTime) - Date.parse(b.transactionTime));
    const times = list.map((i) => Date.parse(i.transactionTime));
    const intervals = times.slice(1).map((t, i) => (t - times[i]!) / DAY);
    const med = median(intervals);
    const cadence = classifyCadence(med);
    if (!cadence) continue;
    const regular = intervals.filter((d) => Math.abs(d - med) / med <= 0.25).length / intervals.length;
    if (regular < 0.6) continue;

    const amounts = list.map((i) => i.amount.minorUnits);
    const currency = list[0]!.amount.currency;
    const avg = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    const last = list[list.length - 1]!;
    const lastTime = times[times.length - 1]!;
    const annual = Math.round(avg * cadence.perYear);
    out.push({
      counterParty: last.counterPartyName ?? normaliseName(last),
      cadence: cadence.name,
      occurrences: list.length,
      medianIntervalDays: Math.round(med * 10) / 10,
      lastPaid: last.transactionTime,
      nextExpected: new Date(lastTime + med * DAY).toISOString().slice(0, 10),
      likelyActive: now - lastTime <= med * 1.5 * DAY,
      lastAmount: formatMoney(last.amount.minorUnits, currency),
      averageAmount: formatMoney(avg, currency),
      amountVaries: Math.max(...amounts) - Math.min(...amounts) > avg * 0.05,
      estimatedAnnualCost: formatMoney(annual, currency),
      annualMinorUnits: annual,
      sources: [...new Set(list.map((i) => i.source ?? "UNKNOWN"))],
      spendingCategory: last.spendingCategory,
    });
  }
  return out.sort((a, b) => b.annualMinorUnits - a.annualMinorUnits);
}

export const insightTools = [
  defineTool({
    name: "get_financial_overview",
    title: "Financial overview",
    description:
      "One-call snapshot of every account: balances (cleared, effective, total including spaces), plus each savings space and spending space with its balance. Uses 1 + 2 requests per account.",
    tier: "read",
    operations: [],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      const accounts = await ctx.accounts.list(true);
      const result = [];
      for (const a of accounts) {
        const params = { accountUid: a.accountUid };
        const [balance, spaces] = await Promise.all([
          ctx.client.json<Record<string, Amount>>({
            method: "GET",
            path: "/api/v2/accounts/{accountUid}/balance",
            params,
          }),
          ctx.client
            .json<{
              savingsGoals?: {
                savingsGoalUid: string;
                name: string;
                totalSaved?: Amount;
                target?: Amount;
                savedPercentage?: number;
                state?: string;
              }[];
              spendingSpaces?: {
                spaceUid: string;
                name: string;
                balance?: Amount;
                spendingSpaceType?: string;
                state?: string;
              }[];
            }>({ method: "GET", path: "/api/v2/account/{accountUid}/spaces", params })
            .catch((e: Error) => ({ error: e.message })),
        ]);
        const fmt = (m?: Amount) => (m ? formatMoney(m.minorUnits, m.currency) : undefined);
        result.push({
          accountUid: a.accountUid,
          name: a.name,
          accountType: a.accountType,
          currency: a.currency,
          defaultCategory: a.defaultCategory,
          balance: {
            effective: fmt(balance?.effectiveBalance),
            cleared: fmt(balance?.clearedBalance),
            pending: fmt(balance?.pendingTransactions),
            totalIncludingSpaces: fmt(balance?.totalEffectiveBalance),
            arrangedOverdraft: fmt(balance?.acceptedOverdraft),
          },
          savingsSpaces:
            "error" in spaces
              ? spaces.error
              : (spaces?.savingsGoals ?? []).map((g) => ({
                  savingsGoalUid: g.savingsGoalUid,
                  name: g.name,
                  saved: fmt(g.totalSaved),
                  target: fmt(g.target),
                  percent: g.savedPercentage,
                  state: g.state,
                })),
          spendingSpaces:
            "error" in spaces
              ? undefined
              : (spaces?.spendingSpaces ?? []).map((s) => ({
                  spaceUid: s.spaceUid,
                  name: s.name,
                  balance: fmt(s.balance),
                  type: s.spendingSpaceType,
                  state: s.state,
                })),
        });
      }
      return json({ asOf: new Date().toISOString(), accounts: result });
    },
  }),

  defineTool({
    name: "summarise_spending",
    title: "Summarise spending",
    description:
      "Analyses transactions locally and totals them by spending category, by counterparty (merchant/payee), or by month (in/out/net). " +
      "Defaults: this calendar month so far, money out only, settled + pending, excluding moves between your own spaces. One API request for ranges up to a year.",
    tier: "read",
    operations: [],
    readOnly: true,
    input: {
      accountUid,
      categoryUid,
      from: dateTime("Start. Default: first day of this month").optional(),
      to: dateTime("End. Default: now").optional(),
      groupBy: z.enum(["spendingCategory", "counterParty", "month"]).optional().describe("Default spendingCategory"),
      direction: z.enum(["IN", "OUT"]).optional().describe("Default OUT (spending); ignored for groupBy=month"),
      includeInternalTransfers: z.boolean().optional().describe("Default false"),
      top: z.number().int().min(1).max(500).optional().describe("Max groups returned (default 30)"),
    },
    async run(args, ctx) {
      const r = await ctx.accounts.category(args.accountUid, args.categoryUid);
      const from = toTimestamp(args.from ?? startOfMonth());
      const to = toTimestamp(args.to ?? new Date().toISOString(), true);
      const { items } = await fetchFeedBetween(ctx.client, r.accountUid, r.categoryUid, from, to);
      const groupBy = args.groupBy ?? "spendingCategory";
      const base = filterFeed(items, {
        statuses: COUNTED_STATUSES,
        includeInternalTransfers: args.includeInternalTransfers ?? false,
      });

      if (groupBy === "month") {
        const months = new Map<string, { in: number; out: number; count: number; currency: string }>();
        for (const i of base) {
          const key = `${i.transactionTime.slice(0, 7)}${i.amount.currency !== r.currency ? ` ${i.amount.currency}` : ""}`;
          const m = months.get(key) ?? { in: 0, out: 0, count: 0, currency: i.amount.currency };
          if (i.direction === "IN") m.in += i.amount.minorUnits;
          else m.out += i.amount.minorUnits;
          m.count++;
          months.set(key, m);
        }
        return json({
          from,
          to,
          months: [...months.entries()].sort().map(([month, m]) => ({
            month,
            moneyIn: formatMoney(m.in, m.currency),
            moneyOut: formatMoney(m.out, m.currency),
            net: formatMoney(m.in - m.out, m.currency),
            transactions: m.count,
          })),
        });
      }

      const direction = args.direction ?? "OUT";
      const matched = base.filter((i) => i.direction === direction);
      const groups = new Map<string, { minor: number; count: number; currency: string }>();
      for (const i of matched) {
        const label = groupBy === "counterParty" ? (i.counterPartyName ?? "Unknown") : (i.spendingCategory ?? "NONE");
        const key = i.amount.currency !== r.currency ? `${label} (${i.amount.currency})` : label;
        const g = groups.get(key) ?? { minor: 0, count: 0, currency: i.amount.currency };
        g.minor += i.amount.minorUnits;
        g.count++;
        groups.set(key, g);
      }
      const total = matched
        .filter((i) => i.amount.currency === r.currency)
        .reduce((s, i) => s + i.amount.minorUnits, 0);
      const sorted = [...groups.entries()].sort((a, b) => b[1].minor - a[1].minor);
      return json({
        from,
        to,
        direction,
        groupBy,
        total: formatMoney(total, r.currency),
        transactions: matched.length,
        groups: sorted.slice(0, args.top ?? 30).map(([key, g]) => ({
          [groupBy]: key,
          total: formatMoney(g.minor, g.currency),
          minorUnits: g.minor,
          transactions: g.count,
          shareOfTotal: g.currency === r.currency && total ? `${((g.minor / total) * 100).toFixed(1)}%` : undefined,
        })),
        otherGroups: Math.max(0, sorted.length - (args.top ?? 30)),
      });
    },
  }),

  defineTool({
    name: "find_recurring_payments",
    title: "Find subscriptions and recurring payments",
    description:
      "Scans outgoing transactions (default: last 12 months) for payments that repeat on a regular cadence: subscriptions, direct debits, standing orders, memberships. " +
      "Returns cadence, last/average amount, next expected date, whether it still looks active, and estimated annual cost, sorted by annual cost.",
    tier: "read",
    operations: [],
    readOnly: true,
    input: {
      accountUid,
      categoryUid,
      from: dateTime("Start. Default: 12 months ago").optional(),
      to: dateTime("End. Default: now").optional(),
      minOccurrences: z.number().int().min(2).max(24).optional().describe("Minimum repeats (default 3)"),
      activeOnly: z.boolean().optional().describe("Only payments that still look active (default false)"),
    },
    async run(args, ctx) {
      const r = await ctx.accounts.category(args.accountUid, args.categoryUid);
      const to = toTimestamp(args.to ?? new Date().toISOString(), true);
      const from = toTimestamp(args.from ?? new Date(Date.parse(to) - 364 * DAY).toISOString());
      const { items } = await fetchFeedBetween(ctx.client, r.accountUid, r.categoryUid, from, to);
      let found = detectRecurring(items, Date.parse(to), args.minOccurrences ?? 3);
      if (args.activeOnly) found = found.filter((f) => f.likelyActive);
      const activeAnnual = found.filter((f) => f.likelyActive).reduce((s, f) => s + f.annualMinorUnits, 0);
      return json({
        from,
        to,
        found: found.length,
        estimatedAnnualCostOfActive: formatMoney(activeAnnual, r.currency || "GBP"),
        recurring: found.map(({ annualMinorUnits: _a, ...rest }) => rest),
      });
    },
  }),

  defineTool({
    name: "list_spending_categories",
    title: "List spending categories",
    description:
      "Lists every spending category value Starling accepts (for filtering and recategorising). Makes no API calls.",
    tier: "read",
    operations: [],
    readOnly: true,
    input: {},
    async run() {
      return json({ spendingCategories: SPENDING_CATEGORIES });
    },
  }),
];
