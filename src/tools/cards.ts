import { z } from "zod";
import { currency, uid } from "./schemas.js";
import { defineTool, done, json } from "./types.js";

const CONTROLS = {
  card_enabled: { operation: "enableCard", path: "enabled", label: "card (unlocked)" },
  atm: { operation: "enableAtm", path: "atm-enabled", label: "ATM withdrawals" },
  online: { operation: "enableOnlinePayments", path: "online-enabled", label: "online payments" },
  pos: { operation: "enablePos", path: "pos-enabled", label: "in-person payments (contactless and chip & PIN)" },
  mobile_wallet: { operation: "enableMobileWallet", path: "mobile-wallet-enabled", label: "mobile wallet payments" },
  gambling: { operation: "enableGamblingPayments", path: "gambling-enabled", label: "gambling payments" },
  mag_stripe: { operation: "enableMagStripePayment", path: "mag-stripe-enabled", label: "magnetic stripe payments" },
} as const;

type Control = keyof typeof CONTROLS;

export const cardTools = [
  defineTool({
    name: "list_cards",
    title: "List cards",
    description:
      "Lists the account holder's cards with their controls: enabled (not locked), ATM, online, POS (contactless/chip & PIN), mobile wallet, gambling, mag stripe, currency flags, last 4 digits and activation/cancellation state.",
    tier: "read",
    operations: ["listCards"],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json(await ctx.client.json({ method: "GET", path: "/api/v2/cards" }));
    },
  }),

  defineTool({
    name: "set_card_control",
    title: "Set card control",
    description:
      "Turns a card control on or off. control: card_enabled (false = lock the card, true = unlock), atm, online, pos (contactless and chip & PIN), mobile_wallet, gambling, mag_stripe. Starling may delay re-enabling gambling.",
    tier: "write",
    operations: Object.values(CONTROLS).map((c) => c.operation),
    idempotent: true,
    input: {
      cardUid: uid("Card UID from list_cards"),
      control: z.enum(Object.keys(CONTROLS) as [Control, ...Control[]]),
      enabled: z.boolean(),
    },
    async run(args, ctx) {
      const c = CONTROLS[args.control];
      await ctx.client.json({
        method: "PUT",
        path: `/api/v2/cards/{cardUid}/controls/${c.path}`,
        params: { cardUid: args.cardUid },
        json: { enabled: args.enabled },
      });
      return done(`${args.enabled ? "Enabled" : "Disabled"} ${c.label} on card ${args.cardUid}.`);
    },
  }),

  defineTool({
    name: "set_card_currency_switch",
    title: "Set card currency switch",
    description: "Enables or disables card payments in a specific currency (the card's currency switch control).",
    tier: "write",
    operations: ["enableCurrencySwitch"],
    idempotent: true,
    input: { cardUid: uid("Card UID from list_cards"), currency, enabled: z.boolean() },
    async run(args, ctx) {
      await ctx.client.json({
        method: "PUT",
        path: "/api/v2/cards/{cardUid}/controls/currency-switch",
        params: { cardUid: args.cardUid },
        json: { enabled: args.enabled, currency: args.currency },
      });
      return done(`${args.enabled ? "Enabled" : "Disabled"} ${args.currency} payments on card ${args.cardUid}.`);
    },
  }),
];
