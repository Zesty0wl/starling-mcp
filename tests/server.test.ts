import { createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT,
  ACCOUNTS_ROUTE,
  CATEGORY,
  connect,
  fakeStarling,
  PAYEE,
  PAYEE_ACCOUNT,
  rsaSigner,
  testConfig,
  textOf,
} from "./helpers.js";

const PAYEES_ROUTE = {
  "GET /api/v2/payees": () => ({
    json: {
      payees: [
        {
          payeeUid: PAYEE,
          payeeName: "Jane Smith",
          payeeType: "INDIVIDUAL",
          accounts: [
            {
              payeeAccountUid: PAYEE_ACCOUNT,
              description: "Current",
              bankIdentifierType: "SORT_CODE",
              bankIdentifier: "608371",
              accountIdentifier: "12345678",
            },
          ],
        },
      ],
    },
  }),
};

const PAYMENT_PATH = "PUT /api/v2/payments/local/account/{a}/category/{c}";

describe("MCP server", () => {
  it("registers only read-only tools by default", async () => {
    const client = await connect(testConfig(), fakeStarling({}).fetchImpl);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(40);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("make_payment");
  });

  it("adds write tools, then payment tools, as tiers are enabled", async () => {
    const write = await connect(testConfig({ STARLING_ENABLE_WRITES: "true" }), fakeStarling({}).fetchImpl);
    const writeNames = (await write.listTools()).tools.map((t) => t.name);
    expect(writeNames).toContain("set_transaction_note");
    expect(writeNames).not.toContain("make_payment");

    const pay = await connect(
      testConfig({ STARLING_ENABLE_WRITES: "true", STARLING_ENABLE_PAYMENTS: "true" }),
      fakeStarling({}).fetchImpl,
    );
    const tools = (await pay.listTools()).tools;
    const mp = tools.find((t) => t.name === "make_payment")!;
    expect(mp.annotations?.destructiveHint).toBe(true);
    expect(Object.keys(mp.inputSchema.properties ?? {})).toContain("confirmationCode");
  });

  it("defaults the account and formats the balance", async () => {
    const { fetchImpl } = fakeStarling({
      ...ACCOUNTS_ROUTE,
      "GET /api/v2/accounts/{a}/balance": () => ({
        json: { effectiveBalance: { currency: "GBP", minorUnits: 123456 } },
      }),
    });
    const client = await connect(testConfig(), fetchImpl);
    const res = await client.callTool({ name: "get_account_balance", arguments: {} });
    expect(textOf(res)).toContain("£1,234.56");
  });

  it("returns API errors as tool errors without leaking the token", async () => {
    const { fetchImpl } = fakeStarling({
      "GET /api/v2/cards": () => ({ status: 403, json: { errors: [{ message: "nope" }] } }),
    });
    const client = await connect(testConfig(), fetchImpl);
    const res = await client.callTool({ name: "list_cards", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("HTTP 403");
    expect(textOf(res)).not.toContain("test-token");
  });

  describe("make_payment (token confirmation)", () => {
    const config = () =>
      testConfig({
        STARLING_ENABLE_WRITES: "true",
        STARLING_ENABLE_PAYMENTS: "true",
        STARLING_CONFIRMATION: "token",
        STARLING_PAYMENT_LIMIT_MINOR_UNITS: "10000",
      });
    const args = { destinationPayeeAccountUid: PAYEE_ACCOUNT, amountMinorUnits: 2500, reference: "Dinner" };

    it("previews first, then pays only with the matching code, signing the request", async () => {
      const { signer, publicKey } = rsaSigner();
      const { fetchImpl, calls } = fakeStarling({
        ...ACCOUNTS_ROUTE,
        ...PAYEES_ROUTE,
        [PAYMENT_PATH]: () => ({ json: { paymentOrderUid: "po-1" } }),
      });
      const client = await connect(config(), fetchImpl, signer);

      const preview = textOf(await client.callTool({ name: "make_payment", arguments: args }));
      expect(preview).toContain("CONFIRMATION REQUIRED");
      expect(preview).toContain("£25.00");
      expect(preview).toContain("Jane Smith (sort code 60-83-71, account 12345678");
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
      const code = /confirmationCode "(\d{6})"/.exec(preview)![1]!;

      const changed = await client.callTool({
        name: "make_payment",
        arguments: { ...args, amountMinorUnits: 9999, confirmationCode: code },
      });
      expect(changed.isError).toBe(true);
      expect(calls.some((c) => c.method === "PUT")).toBe(false);

      // The mismatched attempt burned the code, so a fresh preview is needed.
      const preview2 = textOf(await client.callTool({ name: "make_payment", arguments: args }));
      const code2 = /confirmationCode "(\d{6})"/.exec(preview2)![1]!;
      const paid = await client.callTool({ name: "make_payment", arguments: { ...args, confirmationCode: code2 } });
      expect(paid.isError).toBeFalsy();
      expect(textOf(paid)).toContain("po-1");

      const put = calls.find((c) => c.method === "PUT")!;
      expect(put.url.pathname).toBe(`/api/v2/payments/local/account/${ACCOUNT}/category/${CATEGORY}`);
      const body = JSON.parse(put.body!);
      expect(body).toMatchObject({
        destinationPayeeAccountUid: PAYEE_ACCOUNT,
        reference: "Dinner",
        amount: { currency: "GBP", minorUnits: 2500 },
      });
      expect(body.externalIdentifier).toMatch(/^[0-9a-f-]{36}$/);
      const sig = /signature="([^"]+)"/.exec(put.headers.Authorization!)![1]!;
      const content = `(request-target): put ${put.url.pathname}\nDate: ${put.headers.Date}\nDigest: ${put.headers.Digest}`;
      expect(createVerify("SHA512").update(content).verify(publicKey, sig, "base64")).toBe(true);

      const replay = await client.callTool({ name: "make_payment", arguments: { ...args, confirmationCode: code2 } });
      expect(replay.isError).toBe(true);
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });

    it("enforces the payment limit before asking for confirmation", async () => {
      const { fetchImpl } = fakeStarling({ ...ACCOUNTS_ROUTE, ...PAYEES_ROUTE });
      const client = await connect(config(), fetchImpl, rsaSigner().signer);
      const res = await client.callTool({ name: "make_payment", arguments: { ...args, amountMinorUnits: 10001 } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("payment limit");
    });

    it("refuses payees that do not exist", async () => {
      const { fetchImpl } = fakeStarling({ ...ACCOUNTS_ROUTE, ...PAYEES_ROUTE });
      const client = await connect(config(), fetchImpl, rsaSigner().signer);
      const res = await client.callTool({
        name: "make_payment",
        arguments: { ...args, destinationPayeeAccountUid: "99999999-9999-4999-8999-999999999999" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("existing payee");
    });

    it("rejects references longer than 18 characters on GBP accounts", async () => {
      const { fetchImpl } = fakeStarling({ ...ACCOUNTS_ROUTE, ...PAYEES_ROUTE });
      const client = await connect(config(), fetchImpl, rsaSigner().signer);
      const res = await client.callTool({
        name: "make_payment",
        arguments: { ...args, reference: "This is far too long a ref" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("18 characters");
    });
  });
  describe("elicitation confirmation", () => {
    const config = () => testConfig({ STARLING_ENABLE_WRITES: "true", STARLING_ENABLE_PAYMENTS: "true" });
    const args = { destinationPayeeAccountUid: PAYEE_ACCOUNT, amountMinorUnits: 1500, reference: "Gift" };
    const routes = () =>
      fakeStarling({
        ...ACCOUNTS_ROUTE,
        ...PAYEES_ROUTE,
        [PAYMENT_PATH]: () => ({ json: { paymentOrderUid: "po-2" } }),
      });

    it("asks the user directly and pays when they approve", async () => {
      const { fetchImpl, calls } = routes();
      const prompts: string[] = [];
      const client = await connect(config(), fetchImpl, rsaSigner().signer, (m) => {
        prompts.push(m);
        return { action: "accept", content: { confirm: true } };
      });
      const res = await client.callTool({ name: "make_payment", arguments: args });
      expect(res.isError).toBeFalsy();
      expect(prompts[0]).toContain("£15.00");
      expect(prompts[0]).toContain("Jane Smith");
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });

    it("does nothing when the user declines, and ignores model-supplied codes", async () => {
      const { fetchImpl, calls } = routes();
      const client = await connect(config(), fetchImpl, rsaSigner().signer, () => ({ action: "decline" }));
      const res = await client.callTool({ name: "make_payment", arguments: { ...args, confirmationCode: "123456" } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("did not approve");
      expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });
  });
});
