import type { StarlingClient } from "./client.js";

export interface Account {
  accountUid: string;
  accountType: string;
  defaultCategory: string;
  currency: string;
  createdAt: string;
  name: string;
}

const TTL_MS = 10 * 60 * 1000;

/**
 * Caches the account list so tools can default accountUid / categoryUid
 * without spending one of the 1,000 daily requests every time.
 */
export class AccountResolver {
  private cache: { accounts: Account[]; at: number } | undefined;

  constructor(
    private readonly client: StarlingClient,
    private readonly defaultAccountUid: string | undefined,
  ) {}

  async list(refresh = false): Promise<Account[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.accounts;
    const res = await this.client.json<{ accounts?: Account[] }>({ method: "GET", path: "/api/v2/accounts" });
    const accounts = res?.accounts ?? [];
    this.cache = { accounts, at: Date.now() };
    return accounts;
  }

  /** Resolves an account, defaulting to the configured or primary one. */
  async account(accountUid?: string): Promise<Account> {
    const accounts = await this.list();
    const wanted = accountUid ?? this.defaultAccountUid;
    if (wanted) {
      const found =
        accounts.find((a) => a.accountUid === wanted) ?? (await this.list(true)).find((a) => a.accountUid === wanted);
      if (found) return found;
      throw new Error(
        `Account ${wanted} is not accessible with this token${accountUid ? "" : " (from STARLING_DEFAULT_ACCOUNT_UID)"}. Call list_accounts to see valid accountUids.`,
      );
    }
    if (accounts.length === 1) return accounts[0]!;
    const primary = accounts.filter((a) => a.accountType === "PRIMARY");
    if (primary.length === 1) return primary[0]!;
    if (accounts.length === 0) throw new Error("This token cannot see any accounts.");
    throw new Error(
      `Several accounts are available; pass accountUid. Accounts: ${accounts
        .map((a) => `${a.name} (${a.currency}, ${a.accountType}) ${a.accountUid}`)
        .join("; ")}`,
    );
  }

  /** Resolves account + category, where the category defaults to the main account balance. */
  async category(
    accountUid?: string,
    categoryUid?: string,
  ): Promise<{ accountUid: string; categoryUid: string; currency: string }> {
    const account = await this.account(accountUid);
    let category = categoryUid ?? account.defaultCategory;
    if (!category) {
      const refreshed = (await this.list(true)).find((a) => a.accountUid === account.accountUid);
      category = refreshed?.defaultCategory ?? "";
    }
    if (!category) throw new Error(`Could not determine the main category for account ${account.accountUid}`);
    return { accountUid: account.accountUid, categoryUid: category, currency: account.currency };
  }
}
