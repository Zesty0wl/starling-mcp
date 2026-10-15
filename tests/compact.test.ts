import { describe, expect, it } from "vitest";
import { consentNote } from "../src/tools/accounts.js";
import { ACCOUNTS_ROUTE, connect, fakeStarling, PAYEE, PAYEE_ACCOUNT, testConfig, textOf } from "./helpers.js";

const PAYEES = {
  "GET /api/v2/payees": () => ({
    json: {
      payees: [
        {
          payeeUid: PAYEE,
          payeeName: "Jane Smith",
          payeeType: "INDIVIDUAL",
          phoneNumber: null,
          accounts: [
            {
              payeeAccountUid: PAYEE_ACCOUNT,
              description: "Current",
              bankIdentifierType: "SORT_CODE",
              bankIdentifier: "608371",
              accountIdentifier: "12345678",
              lastReferences: ["Rent", "Dinner", "Gift", "Old"],
            },
          ],
        },
        { payeeUid: "p2", payeeName: "Gas Co", payeeType: "BUSINESS", accounts: [] },
      ],
    },
  }),
};

describe("compact list output", () => {
  it("returns one compact row per payee account and supports search", async () => {
    const client = await connect(testConfig(), fakeStarling(PAYEES).fetchImpl);
    const all = JSON.parse(textOf(await client.callTool({ name: "list_payees", arguments: {} })));
    expect(all.count).toBe(2);
    expect(all.payees[0]).toEqual({
      name: "Jane Smith",
      type: "INDIVIDUAL",
      payeeUid: PAYEE,
      payeeAccountUid: PAYEE_ACCOUNT,
      label: "Current",
      account: "60-83-71 12345678",
      recentReferences: ["Rent", "Dinner", "Gift"],
    });
    const found = JSON.parse(textOf(await client.callTool({ name: "list_payees", arguments: { search: "rent" } })));
    expect(found.count).toBe(1);
  });

  it("hides cancelled direct debits unless asked", async () => {
    const { fetchImpl } = fakeStarling({
      "GET /api/v2/direct-debit/mandates": () => ({
        json: {
          mandates: [
            {
              uid: "a",
              originatorName: "Water",
              status: "LIVE",
              lastPayment: { lastDate: "2026-09-30", lastAmount: { currency: "GBP", minorUnits: 10055 } },
            },
            { uid: "b", originatorName: "Old Loan", status: "CANCELLED", cancelled: "2023-06-19T23:22:36Z" },
          ],
        },
      }),
    });
    const client = await connect(testConfig(), fetchImpl);
    const live = JSON.parse(textOf(await client.callTool({ name: "list_direct_debit_mandates", arguments: {} })));
    expect(live.mandates).toEqual([
      { mandateUid: "a", originator: "Water", status: "LIVE", lastPaid: "2026-09-30", lastAmount: "£100.55" },
    ]);
    const all = JSON.parse(
      textOf(await client.callTool({ name: "list_direct_debit_mandates", arguments: { includeCancelled: true } })),
    );
    expect(all.count).toBe(2);
  });

  it("lists active standing orders with payee names", async () => {
    const { fetchImpl } = fakeStarling({
      ...ACCOUNTS_ROUTE,
      ...PAYEES,
      "GET /api/v2/payments/local/account/{a}/category/{c}/standing-orders": () => ({
        json: {
          standingOrders: [
            {
              paymentOrderUid: "so1",
              amount: { currency: "GBP", minorUnits: 120000 },
              reference: "House",
              payeeAccountUid: PAYEE_ACCOUNT,
              standingOrderRecurrence: { startDate: "2023-03-25", frequency: "MONTHLY", interval: 1 },
              nextDate: "2026-10-25",
            },
            {
              paymentOrderUid: "so2",
              amount: { currency: "GBP", minorUnits: 10000 },
              reference: "Old",
              standingOrderRecurrence: { startDate: "2022-10-01", frequency: "MONTHLY" },
              cancelledAt: "2023-03-24T18:18:15Z",
            },
          ],
        },
      }),
    });
    const client = await connect(testConfig(), fetchImpl);
    const res = JSON.parse(textOf(await client.callTool({ name: "list_standing_orders", arguments: {} })));
    expect(res.standingOrders).toEqual([
      {
        paymentOrderUid: "so1",
        payee: "Jane Smith",
        payeeAccountUid: PAYEE_ACCOUNT,
        amount: "£1,200.00",
        reference: "House",
        schedule: "monthly from 2023-03-25, until cancelled",
        nextDate: "2026-10-25",
      },
    ]);
  });

  it("reports a missing photo as a message, not an error", async () => {
    const { fetchImpl } = fakeStarling({
      ...ACCOUNTS_ROUTE,
      "GET /api/v2/account/{a}/savings-goals/{g}/photo": () => ({ status: 404, json: {} }),
    });
    const client = await connect(testConfig(), fetchImpl);
    const res = await client.callTool({
      name: "get_savings_goal_photo",
      arguments: { savingsGoalUid: "55555555-5555-4555-8555-555555555555" },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("No photo");
  });

  it("explains consent expiry", () => {
    const now = Date.parse("2026-10-15T00:00:00Z");
    expect(consentNote("2027-01-13T08:31:59Z", now)).toContain("90 days");
    expect(consentNote("2026-10-01T00:00:00Z", now)).toContain("expired");
  });
});
