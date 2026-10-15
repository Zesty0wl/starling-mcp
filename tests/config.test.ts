import { describe, expect, it } from "vitest";
import { loadConfig, tierAllows } from "../src/config.js";

describe("config", () => {
  it("defaults to read-only production with no payment limit", () => {
    const c = loadConfig({});
    expect(c.tier).toBe("read");
    expect(c.baseUrl).toBe("https://api.starlingbank.com");
    expect(c.paymentLimitMinorUnits).toBeUndefined();
    expect(c.confirmation).toBe("auto");
  });

  it("enables tiers cumulatively", () => {
    const write = loadConfig({ STARLING_ENABLE_WRITES: "true" });
    expect(tierAllows(write, "write")).toBe(true);
    expect(tierAllows(write, "payments")).toBe(false);
    const pay = loadConfig({ STARLING_ENABLE_WRITES: "1", STARLING_ENABLE_PAYMENTS: "yes" });
    expect(tierAllows(pay, "payments")).toBe(true);
  });

  it("refuses payments without writes", () => {
    expect(() => loadConfig({ STARLING_ENABLE_PAYMENTS: "true" })).toThrow(/requires STARLING_ENABLE_WRITES/);
  });

  it("validates the payment limit and environment", () => {
    expect(loadConfig({ STARLING_PAYMENT_LIMIT_MINOR_UNITS: "50000" }).paymentLimitMinorUnits).toBe(50000);
    expect(() => loadConfig({ STARLING_PAYMENT_LIMIT_MINOR_UNITS: "12.5" })).toThrow();
    expect(() => loadConfig({ STARLING_ENVIRONMENT: "staging" })).toThrow();
  });

  it("can disable the audit log", () => {
    expect(loadConfig({ STARLING_AUDIT_LOG: "off" }).auditLogPath).toBeUndefined();
  });
});
