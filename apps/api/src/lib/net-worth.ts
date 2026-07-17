const RETIREMENT_ACCOUNT_PATTERN = /retire|roth|401.?k|403.?b|457|ira|pension/i;

export interface NetWorthAccountLike {
  group: string;
  name: string;
  officialName?: string | null;
  type: string;
  subtype?: string | null;
  includeInNetWorth: boolean;
  isLiability: boolean;
  status: "active" | "closed" | "hidden" | "stale";
}

export interface NetWorthAssetLike {
  liquidityClass: string;
  isActive: boolean;
}

export function signedNetWorthBalance(amount: bigint, isLiability: boolean): bigint {
  if (!isLiability) return amount;
  return amount > 0n ? -amount : amount;
}

export function isRetirementAccount(account: NetWorthAccountLike): boolean {
  return (
    account.group === "investment" &&
    RETIREMENT_ACCOUNT_PATTERN.test(
      `${account.name} ${account.officialName ?? ""} ${account.type} ${account.subtype ?? ""}`,
    )
  );
}

export function isNetWorthAccountIncluded(account: NetWorthAccountLike): boolean {
  return account.includeInNetWorth && account.status !== "hidden" && account.status !== "closed";
}

/**
 * Returns the account's contribution to liquid net worth. This is the single
 * definition shared by planning personalization and both report surfaces.
 */
export function liquidAccountContribution(account: NetWorthAccountLike, balance: bigint): bigint {
  if (!isNetWorthAccountIncluded(account)) return 0n;
  const signed = signedNetWorthBalance(balance, account.isLiability);
  if (account.isLiability) return account.group === "credit" ? signed : 0n;
  if (!["cash", "investment", "crypto"].includes(account.group)) return 0n;
  return isRetirementAccount(account) ? 0n : signed;
}

export function liquidAssetContribution(asset: NetWorthAssetLike, value: bigint): bigint {
  return asset.isActive && asset.liquidityClass === "liquid" ? value : 0n;
}
