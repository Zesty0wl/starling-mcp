import { z } from "zod";
import { SPENDING_CATEGORIES } from "../spendingCategories.js";

const UID_RE = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/;

export const uid = (what: string) => z.string().regex(UID_RE, `${what} must be a UUID`).describe(what);

export const accountUid = uid(
  "Account UID. Optional: defaults to STARLING_DEFAULT_ACCOUNT_UID, the only account, or the PRIMARY account",
).optional();

export const categoryUid = uid(
  "Category UID: the main account's defaultCategory, or a space / savings goal UID. Optional: defaults to the main account",
).optional();

export const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "currency must be an ISO-4217 code like GBP")
  .describe("ISO-4217 currency code, e.g. GBP");

export const minorUnits = (what: string) =>
  z.number().int().nonnegative().describe(`${what} in minor units (pence for GBP: 1050 = £10.50)`);

export const date = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
    .describe(`${what} (YYYY-MM-DD)`);

export const dateTime = (what: string) =>
  z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO-8601 date or date-time")
    .describe(`${what} (ISO-8601, e.g. 2026-01-31 or 2026-01-31T18:00:00Z)`);

/** Validated locally but kept as a plain string in the JSON schema to save context. */
export const spendingCategory = z
  .string()
  .refine((v) => (SPENDING_CATEGORIES as readonly string[]).includes(v), {
    message: "Unknown spending category; call list_spending_categories for valid values",
  })
  .describe("Spending category, e.g. GROCERIES, EATING_OUT, BILLS_AND_SERVICES (see list_spending_categories)");

export const bankIdentifierType = z.enum(["SORT_CODE", "SWIFT", "IBAN", "ABA", "ABA_WIRE", "ABA_ACH", "BSB"]);

export const payeeAccount = z.object({
  description: z.string().min(1).max(255).describe("Label for this account, e.g. 'Current account'"),
  defaultAccount: z.boolean().describe("Whether this is the payee's default account"),
  countryCode: z.string().length(2).describe("ISO 3166-1 alpha-2 country code, e.g. GB"),
  accountIdentifier: z.string().max(34).describe("Account number (8 digits for UK) or IBAN"),
  bankIdentifier: z.string().max(34).describe("Sort code (6 digits, no dashes, for UK) or BIC"),
  bankIdentifierType: bankIdentifierType.describe("SORT_CODE for UK accounts"),
  secondaryIdentifier: z.string().optional().describe("Secondary reference data (e.g. building society roll number)"),
});

export const recurrence = z.object({
  startDate: date("Date of the first payment"),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
  interval: z.number().int().min(1).max(20).optional().describe("Every N periods, e.g. 2 with WEEKLY = fortnightly"),
  count: z.number().int().min(1).max(100).optional().describe("Stop after this many payments"),
  untilDate: date("Stop after this date").optional(),
});

export const paymentReference = z
  .string()
  .min(1)
  .max(18)
  .regex(
    /^[a-zA-Z0-9\-/?:().,+#=!%&*<>;{@ "']{1,18}$/,
    "reference may only contain letters, digits, spaces and -/?:().,+#=!%&*<>;{@\"'",
  )
  .describe("Payment reference shown to the recipient (max 18 characters for UK Faster Payments)");

export const confirmationCode = z
  .string()
  .optional()
  .describe("One-time code from a previous preview call; only send after the user has explicitly approved");
