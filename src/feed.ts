import type { StarlingClient } from "./client.js";
import { formatAmount, type Money } from "./money.js";

export interface FeedItem {
  feedItemUid: string;
  categoryUid: string;
  amount: Money;
  sourceAmount?: Money;
  direction: "IN" | "OUT";
  updatedAt?: string;
  transactionTime: string;
  settlementTime?: string;
  source?: string;
  sourceSubType?: string;
  status: string;
  counterPartyType?: string;
  counterPartyUid?: string;
  counterPartyName?: string;
  counterPartySubEntityName?: string;
  reference?: string;
  country?: string;
  spendingCategory?: string;
  userNote?: string;
  roundUp?: { goalCategoryUid: string; amount: Money };
  hasAttachment?: boolean;
  hasReceipt?: boolean;
  [key: string]: unknown;
}

export interface CompactFeedItem {
  feedItemUid: string;
  categoryUid: string;
  time: string;
  settled?: string;
  status: string;
  amount: string | undefined;
  minorUnits: number;
  currency: string;
  direction: "IN" | "OUT";
  counterParty?: string;
  counterPartyType?: string;
  reference?: string;
  spendingCategory?: string;
  source?: string;
  note?: string;
  foreignAmount?: string;
  roundUp?: string;
  hasReceipt?: boolean;
  hasAttachment?: boolean;
}

/** Drops nulls and rarely useful fields so large feeds fit in the model's context. */
export function compactFeedItem(item: FeedItem): CompactFeedItem {
  const foreign =
    item.sourceAmount && item.sourceAmount.currency !== item.amount?.currency
      ? formatAmount(item.sourceAmount, item.direction)
      : undefined;
  const out: CompactFeedItem = {
    feedItemUid: item.feedItemUid,
    categoryUid: item.categoryUid,
    time: item.transactionTime,
    settled: item.settlementTime,
    status: item.status,
    amount: formatAmount(item.amount, item.direction),
    minorUnits: item.direction === "OUT" ? -item.amount.minorUnits : item.amount.minorUnits,
    currency: item.amount.currency,
    direction: item.direction,
    counterParty: item.counterPartyName,
    counterPartyType: item.counterPartyType,
    reference: item.reference,
    spendingCategory: item.spendingCategory,
    source: item.source,
    note: item.userNote,
    foreignAmount: foreign,
    roundUp: item.roundUp?.amount ? formatAmount(item.roundUp.amount, "OUT") : undefined,
    hasReceipt: item.hasReceipt || undefined,
    hasAttachment: item.hasAttachment || undefined,
  };
  for (const k of Object.keys(out) as (keyof CompactFeedItem)[]) {
    if (out[k] === undefined || out[k] === null || out[k] === "") delete out[k];
  }
  return out;
}

/** Accepts YYYY-MM-DD or a full timestamp; date-only `to` values mean the end of that day (UTC). */
export function toTimestamp(value: string, endOfDay = false): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${value}`);
  return new Date(t).toISOString();
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 50;

/**
 * Fetches all feed items for a category between two timestamps. Uses the
 * single-call endpoint for ranges up to a year (one request) and the
 * paginated endpoint beyond that.
 */
export async function fetchFeedBetween(
  client: StarlingClient,
  accountUid: string,
  categoryUid: string,
  from: string,
  to: string,
): Promise<{ items: FeedItem[]; requests: number; truncated: boolean }> {
  const span = Date.parse(to) - Date.parse(from);
  if (span < 0) throw new Error("'from' must be before 'to'");
  const params = { accountUid, categoryUid };

  if (span <= YEAR_MS) {
    const res = await client.json<{ feedItems?: FeedItem[] }>({
      method: "GET",
      path: "/api/v2/feed/account/{accountUid}/category/{categoryUid}/transactions-between",
      params,
      query: { minTransactionTimestamp: from, maxTransactionTimestamp: to },
    });
    return { items: res?.feedItems ?? [], requests: 1, truncated: false };
  }

  const items: FeedItem[] = [];
  let cursor: string | undefined;
  let pageToFetch: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.json<{ feedItems?: FeedItem[]; links?: { next?: string } }>({
      method: "GET",
      path: "/api/v2/feed/account/{accountUid}/category/{categoryUid}/paginated-transactions",
      params,
      query: { minTransactionTimestamp: from, maxTransactionTimestamp: to, cursor, pageToFetch },
    });
    items.push(...(res?.feedItems ?? []));
    const next = res?.links?.next;
    if (!next || !res?.feedItems?.length) return { items, requests: page + 1, truncated: false };
    // Only the cursor is taken from the link; the request itself is always built against Starling's API host.
    const nextUrl = new URL(next, "https://placeholder.invalid");
    cursor = nextUrl.searchParams.get("cursor") ?? undefined;
    pageToFetch = nextUrl.searchParams.get("pageToFetch") ?? "NEXT";
    if (!cursor) return { items, requests: page + 1, truncated: false };
  }
  return { items, requests: MAX_PAGES, truncated: true };
}

export interface FeedFilter {
  direction?: "IN" | "OUT";
  statuses?: string[];
  spendingCategories?: string[];
  search?: string;
  minAmountMinorUnits?: number;
  maxAmountMinorUnits?: number;
  includeInternalTransfers?: boolean;
}

/** Transfers between the main account and the user's own spaces / savings goals. */
export function isInternalTransfer(item: FeedItem): boolean {
  return item.counterPartyType === "CATEGORY" || item.source === "INTERNAL_TRANSFER";
}

export function filterFeed(items: FeedItem[], f: FeedFilter): FeedItem[] {
  const search = f.search?.toLowerCase();
  return items.filter((i) => {
    if (f.direction && i.direction !== f.direction) return false;
    if (f.statuses?.length && !f.statuses.includes(i.status)) return false;
    if (f.spendingCategories?.length && !f.spendingCategories.includes(i.spendingCategory ?? "")) return false;
    if (f.includeInternalTransfers === false && isInternalTransfer(i)) return false;
    const amount = i.amount?.minorUnits ?? 0;
    if (f.minAmountMinorUnits !== undefined && amount < f.minAmountMinorUnits) return false;
    if (f.maxAmountMinorUnits !== undefined && amount > f.maxAmountMinorUnits) return false;
    if (search) {
      const hay = [i.counterPartyName, i.reference, i.userNote, i.counterPartySubEntityName]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

export function sortNewestFirst(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => Date.parse(b.transactionTime) - Date.parse(a.transactionTime));
}

/** Signed totals per currency: money in, money out, net. */
export function totals(items: FeedItem[]): Record<string, { in: number; out: number; net: number; count: number }> {
  const out: Record<string, { in: number; out: number; net: number; count: number }> = {};
  for (const i of items) {
    if (!i.amount) continue;
    const t = out[i.amount.currency] ?? { in: 0, out: 0, net: 0, count: 0 };
    out[i.amount.currency] = t;
    if (i.direction === "IN") t.in += i.amount.minorUnits;
    else t.out += i.amount.minorUnits;
    t.net = t.in - t.out;
    t.count++;
  }
  return out;
}
