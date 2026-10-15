import { z } from "zod";
import { extensionFor, readUploadFile, saveDownload } from "../files.js";
import { date, uid } from "./schemas.js";
import { defineTool, done, image, json, orNotFound, requireConfirmation, type ToolContext, text } from "./types.js";

const get = (name: string, title: string, description: string, operation: string, path: string) =>
  defineTool({
    name,
    title,
    description,
    tier: "read",
    operations: [operation],
    readOnly: true,
    input: {},
    async run(_args, ctx) {
      return json(await ctx.client.json({ method: "GET", path }));
    },
  });

async function holderUid(ctx: ToolContext, given?: string): Promise<string> {
  if (given) return given;
  const holder = await ctx.client.json<{ accountHolderUid: string }>({ method: "GET", path: "/api/v2/account-holder" });
  return holder.accountHolderUid;
}

export const accountHolderTools = [
  get(
    "get_account_holder",
    "Account holder",
    "Returns the account holder UID and type (INDIVIDUAL, JOINT, SOLE_TRADER or BUSINESS). The type tells you which details tool applies.",
    "getAccountHolder",
    "/api/v2/account-holder",
  ),
  get(
    "get_account_holder_name",
    "Account holder name",
    "Returns the account holder's name.",
    "getAccountHolderName",
    "/api/v2/account-holder/name",
  ),
  get(
    "get_individual_details",
    "Individual details",
    "Personal account holders: title, name, date of birth, email and phone.",
    "getIndividual",
    "/api/v2/account-holder/individual",
  ),
  get(
    "get_joint_account_details",
    "Joint account details",
    "Joint account holders: details of both people on the account.",
    "getJointAccount",
    "/api/v2/account-holder/joint",
  ),
  get(
    "get_business_details",
    "Business details",
    "Business account holders: company name, type, registration number, VAT number, etc.",
    "getBusiness",
    "/api/v2/account-holder/business",
  ),
  get(
    "get_sole_trader_details",
    "Sole trader details",
    "Sole trader account holders: trading name, business category and subcategory.",
    "getSoleTrader",
    "/api/v2/account-holder/sole-trader",
  ),
  get(
    "get_business_registered_address",
    "Business registered address",
    "Business account holders: the company's registered address.",
    "getRegisteredAddress",
    "/api/v2/account-holder/business/registered-address",
  ),
  get(
    "get_business_correspondence_address",
    "Business correspondence address",
    "Business account holders: correspondence address (falls back to the registered address).",
    "getCorrespondenceAddress",
    "/api/v2/account-holder/business/correspondence-address",
  ),
  get(
    "get_addresses",
    "Addresses",
    "Returns the account holder's current and previous addresses.",
    "getAddresses",
    "/api/v2/addresses",
  ),
  get(
    "get_settle_up_profile",
    "Settle Up profile",
    "Returns the account holder's Settle Up profile (their Starling payment link/handle) if they have one.",
    "getSettleUpProfile",
    "/api/v2/settle-up/profile",
  ),

  defineTool({
    name: "get_profile_image",
    title: "Profile image",
    description: "Returns the account holder's profile image, if one exists. Optionally also saves it to a file.",
    tier: "read",
    operations: ["downloadProfileImage"],
    readOnly: true,
    input: {
      accountHolderUid: uid("Account holder UID (optional; looked up automatically)").optional(),
      saveAs: z.string().optional().describe("Also save to this file name or absolute path"),
    },
    async run(args, ctx) {
      const accountHolderUid = await holderUid(ctx, args.accountHolderUid);
      const img = await orNotFound(
        ctx.client.binary({
          method: "GET",
          path: "/api/v2/account-holder/{accountHolderUid}/profile-image",
          params: { accountHolderUid },
          accept: "image/*",
        }),
      );
      if (!img) return text("No profile image is set.");
      const saved = args.saveAs
        ? await saveDownload(
            ctx.config.downloadDir,
            args.saveAs + (args.saveAs.includes(".") ? "" : extensionFor(img.contentType)),
            img.data,
          )
        : undefined;
      return image(img.data.toString("base64"), img.contentType, saved ? `Saved to ${saved}` : undefined);
    },
  }),

  defineTool({
    name: "update_profile_image",
    title: "Update profile image",
    description: "Replaces the account holder's profile image with a local JPEG/PNG/GIF/WEBP/HEIC file.",
    tier: "write",
    operations: ["updateProfileImage"],
    idempotent: true,
    input: {
      filePath: z.string().describe("Path to the image file"),
      accountHolderUid: uid("Account holder UID (optional; looked up automatically)").optional(),
    },
    async run(args, ctx) {
      const file = await readUploadFile(args.filePath, false);
      const accountHolderUid = await holderUid(ctx, args.accountHolderUid);
      await ctx.client.json({
        method: "PUT",
        path: "/api/v2/account-holder/{accountHolderUid}/profile-image",
        params: { accountHolderUid },
        raw: { data: file.data, contentType: file.contentType },
      });
      return done(`Profile image updated from ${file.name}.`);
    },
  }),

  defineTool({
    name: "delete_profile_image",
    title: "Delete profile image",
    description: "Deletes the account holder's profile image.",
    tier: "write",
    operations: ["deleteProfileImage"],
    destructive: true,
    idempotent: true,
    input: { accountHolderUid: uid("Account holder UID (optional; looked up automatically)").optional() },
    async run(args, ctx) {
      const accountHolderUid = await holderUid(ctx, args.accountHolderUid);
      await ctx.client.json({
        method: "DELETE",
        path: "/api/v2/account-holder/{accountHolderUid}/profile-image",
        params: { accountHolderUid },
      });
      return done("Profile image deleted.");
    },
  }),

  defineTool({
    name: "update_email",
    title: "Update email address",
    description:
      "Changes the individual account holder's email address with Starling. Requires request signing and the user's confirmation.",
    tier: "write",
    operations: ["updateEmail"],
    confirm: true,
    idempotent: true,
    input: { email: z.email().describe("New email address") },
    async run(args, ctx) {
      await requireConfirmation(ctx, "update_email", `Change your Starling email address to: ${args.email}`, args);
      await ctx.client.json({
        method: "PUT",
        path: "/api/v2/account-holder/individual/email",
        json: { email: args.email },
        signed: true,
      });
      return done(`Email address change to ${args.email} submitted.`);
    },
  }),

  defineTool({
    name: "update_address",
    title: "Update current address",
    description:
      "Changes the account holder's current residential address with Starling. Requires request signing and the user's confirmation.",
    tier: "write",
    operations: ["updateCurrentAddress"],
    confirm: true,
    input: {
      line1: z.string().max(255),
      line2: z.string().max(255).optional(),
      line3: z.string().max(255).optional(),
      postTown: z.string().max(255),
      postCode: z.string().max(20),
      countryCode: z.string().length(2).describe("ISO 3166-1 alpha-2; use GB (not UK) for the United Kingdom"),
      udprn: z.string().max(255).optional().describe("Royal Mail UDPRN, if known"),
      umprn: z.string().max(255).optional().describe("Royal Mail UMPRN, if known"),
      from: date("Date you started living at this address"),
    },
    async run(args, ctx) {
      const { confirmationCode: _c, ...address } = args as typeof args & { confirmationCode?: string };
      const lines = [
        address.line1,
        address.line2,
        address.line3,
        address.postTown,
        address.postCode,
        address.countryCode,
      ]
        .filter(Boolean)
        .join(", ");
      await requireConfirmation(
        ctx,
        "update_address",
        `Change your Starling address to: ${lines} (from ${address.from})`,
        args,
      );
      await ctx.client.json({ method: "POST", path: "/api/v2/addresses", json: address, signed: true });
      return done("Address change submitted.");
    },
  }),

  defineTool({
    name: "logout_all_tokens",
    title: "Revoke all access tokens",
    description:
      "Logs the individual out by disabling ALL of their active API access tokens, including the one this server uses. After this, the server stops working until a new token is stored. Use if a token may be compromised.",
    tier: "write",
    operations: ["logoutIndividual"],
    confirm: true,
    destructive: true,
    input: {},
    async run(args, ctx) {
      await requireConfirmation(
        ctx,
        "logout_all_tokens",
        "Disable ALL active Starling API access tokens for this person, including the one this server uses.",
        args,
      );
      await ctx.client.json({ method: "PUT", path: "/api/v2/identity/logout" });
      return done("All access tokens have been disabled. Store a new token with `starling-mcp token set` to continue.");
    },
  }),
];
