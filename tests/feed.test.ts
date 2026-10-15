import { describe, expect, it } from "vitest";
import { StarlingClient } from "../src/client.js";
import { compactFeedItem, type FeedItem, fetchFeedBetween, filterFeed, toTimestamp, totals } from "../src/feed.js";
import { classifyCadence, detectRecurring } from "../src/tools/insights.js";
import { ACCOUNT, CATEGORY, fakeStarling, testConfig } from "./helpers.js";

let seq = 0;
function item(partial: Partial<FeedItem> & { minor: number; time: string }): FeedItem {
  const { minor, time, ...rest } = partial;
  return {
    feedItemUid: `f${seq++}`,
    categoryUid: CATEGORY,
    amount: { currency: "GBP", minorUnits: minor },
    direction: "OUT",
    transactionTime: time,
    status: "SETTLED",
    counterPartyType: "MERCHANT",
    counterPartyName: "Shop",
    ...rest,
  };
}

describe("feed helpers", () => {
  it("expands plain dates to the start or end of the day", () => {
    expect(toTimestamp("2026-01-31")).toBe("2026-01-31T00:00:00.000Z");
    expect(toTimestamp("2026-01-31", true)).toBe("2026-01-31T23:59:59.999Z");
    expect(toTimestamp("2026-01-31T10:00:00+01:00")).toBe("2026-01-31T09:00:00.000Z");
    expect(() => toTimestamp("yesterday")).toThrow();
  });

  it("compacts items with signed, formatted amounts and drops empty fields", () => {
    const c = compactFeedItem(item({ minor: 1234, time: "2026-01-01T10:00:00Z", reference: "" }));
    expect(c.amount).toBe("-£12.34");
    expect(c.minorUnits).toBe(-1234);
    expect("reference" in c).toBe(false);
  });

  it("filters by direction, text, amount and internal transfers", () => {
    const items = [
      item({ minor: 500, time: "2026-01-01T00:00:00Z", counterPartyName: "Tesco" }),
      item({ minor: 5000, time: "2026-01-02T00:00:00Z", counterPartyName: "Landlord", reference: "RENT" }),
      item({ minor: 100000, time: "2026-01-03T00:00:00Z", direction: "IN", counterPartyName: "Employer" }),
      item({ minor: 2000, time: "2026-01-04T00:00:00Z", counterPartyType: "CATEGORY", counterPartyName: "Holiday" }),
    ];
    expect(filterFeed(items, { direction: "IN" })).toHaveLength(1);
    expect(filterFeed(items, { search: "rent" })).toHaveLength(1);
    expect(filterFeed(items, { minAmountMinorUnits: 1000, maxAmountMinorUnits: 10000 })).toHaveLength(2);
    expect(filterFeed(items, { includeInternalTransfers: false })).toHaveLength(3);
    expect(totals(items).GBP).toEqual({ in: 100000, out: 7500, net: 92500, count: 4 });
  });

  it("uses one transactions-between call for ranges up to a year", async () => {
    const { fetchImpl, calls } = fakeStarling({
      "GET /api/v2/feed/account/{a}/category/{c}/transactions-between": () => ({ json: { feedItems: [] } }),
    });
    const client = new StarlingClient(testConfig(), "t", undefined, fetchImpl);
    const res = await fetchFeedBetween(client, ACCOUNT, CATEGORY, "2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z");
    expect(res.requests).toBe(1);
    expect(calls[0]!.url.searchParams.get("minTransactionTimestamp")).toBe("2026-01-01T00:00:00Z");
  });

  it("pages through the paginated endpoint for ranges over a year, following only the cursor", async () => {
    const { fetchImpl, calls } = fakeStarling({
      "GET /api/v2/feed/account/{a}/category/{c}/paginated-transactions": (req) =>
        req.url.searchParams.get("cursor")
          ? {
              json: { feedItems: [item({ minor: 2, time: "2024-01-01T00:00:00Z" })], links: { self: "s", first: "f" } },
            }
          : {
              json: {
                feedItems: [item({ minor: 1, time: "2025-06-01T00:00:00Z" })],
                links: { self: "s", first: "f", next: "https://evil.example/x?cursor=abc&pageToFetch=NEXT" },
              },
            },
    });
    const client = new StarlingClient(testConfig(), "t", undefined, fetchImpl);
    const res = await fetchFeedBetween(client, ACCOUNT, CATEGORY, "2023-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    expect(res.items).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.origin).toBe("https://api.starlingbank.com");
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("abc");
  });
});

describe("recurring payment detection", () => {
  it("classifies common cadences", () => {
    expect(classifyCadence(7.2)?.name).toBe("weekly");
    expect(classifyCadence(31)?.name).toBe("monthly");
    expect(classifyCadence(364)?.name).toBe("yearly");
    expect(classifyCadence(50)).toBeUndefined();
  });

  it("finds a monthly subscription and ignores one-off spending", () => {
    const items: FeedItem[] = [];
    for (let m = 1; m <= 6; m++) {
      items.push(
        item({
          minor: 1099,
          time: `2026-0${m}-05T08:00:00Z`,
          counterPartyName: "Netflix",
          source: "MASTER_CARD",
        }),
      );
    }
    items.push(item({ minor: 4000, time: "2026-02-10T00:00:00Z", counterPartyName: "Restaurant" }));
    items.push(item({ minor: 4000, time: "2026-04-22T00:00:00Z", counterPartyName: "Restaurant" }));
    const found = detectRecurring(items, Date.parse("2026-06-20T00:00:00Z"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      counterParty: "Netflix",
      cadence: "monthly",
      occurrences: 6,
      likelyActive: true,
      lastAmount: "£10.99",
      estimatedAnnualCost: "£131.88",
    });
  });
});
