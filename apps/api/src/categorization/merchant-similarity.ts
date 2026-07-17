import type { RuleCondition } from "@betterwealth/shared";
import { normalizeDescription } from "../sync/reconcile";

/**
 * Merchant-name similarity used to keep one merchant on one rule. Candidates that look like the
 * same merchant (Jaccard >= threshold) are processed strictly sequentially so the first minted
 * rule resolves the rest deterministically; only clearly different merchants may run in
 * parallel. Rule minting applies the same test again before inserting, so a merchant can never
 * end up with two rules.
 */
export const SIMILAR_MERCHANT_THRESHOLD = 0.5;

// Statement-descriptor noise that says nothing about merchant identity.
const MERCHANT_STOP_TOKENS = new Set(["tst", "sq", "inc", "llc", "co", "corp", "ltd"]);

function isOrderIdToken(token: string): boolean {
  return token.length >= 6 && /[a-z]/.test(token) && /\d/.test(token);
}

/** Lowercased, descriptor-noise-free token set for a merchant name or statement description. */
export function merchantTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of normalizeDescription(value).toLowerCase().split(" ")) {
    if (raw.length < 2) continue;
    if (MERCHANT_STOP_TOKENS.has(raw)) continue;
    if (isOrderIdToken(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

export function jaccardSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

/** Stable, comparable merchant key, e.g. "BEREA BEVERAGE INC" -> "beverage berea". */
export function canonicalMerchantKey(value: string): string {
  return [...merchantTokens(value)].sort().join(" ");
}

/**
 * Extracts the merchant-identifying token set from a rule's condition: the union of tokens from
 * every merchant / description text condition it carries. Returns an empty set for rules that
 * match on other fields only.
 */
export function ruleMerchantTokens(condition: RuleCondition): Set<string> {
  const tokens = new Set<string>();
  const visit = (node: RuleCondition): void => {
    if ("all" in node) {
      for (const child of node.all) visit(child);
      return;
    }
    if ("any" in node) {
      for (const child of node.any) visit(child);
      return;
    }
    if ("not" in node) {
      visit(node.not);
      return;
    }
    if ("field" in node && "value" in node && typeof node.value === "string") {
      if (node.field === "merchant" || node.field === "normalizedDescription") {
        if ("operator" in node && ["exact", "contains", "startsWith"].includes(node.operator)) {
          for (const token of merchantTokens(node.value)) tokens.add(token);
        }
      }
    }
  };
  visit(condition);
  return tokens;
}

export type MerchantClusterable = {
  transaction: { id: string; normalizedDescription: string };
};

/**
 * Groups candidates so that likely-same-merchant descriptions (order IDs and descriptor noise
 * stripped) share a cluster. Clusters preserve input order (first appearance), and rows inside
 * a cluster keep their input order, so sequential per-cluster processing is deterministic.
 */
export function clusterByMerchantSimilarity<T extends MerchantClusterable>(
  rows: readonly T[],
  threshold: number = SIMILAR_MERCHANT_THRESHOLD,
): T[][] {
  const tokenSets = rows.map((row) => merchantTokens(row.transaction.normalizedDescription));
  const parent = rows.map((_, index) => index);
  const find = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      const parentOfCurrent = parent[current];
      if (parentOfCurrent === undefined) break;
      // Indices always stay within `parent`; the fallback only satisfies the type checker.
      const grandparent = parent[parentOfCurrent] ?? parentOfCurrent;
      parent[current] = grandparent;
      current = grandparent;
    }
    return current;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  };
  const byCanonicalKey = new Map<string, number>();
  tokenSets.forEach((tokenSet, index) => {
    const key = [...tokenSet].sort().join(" ");
    const existing = byCanonicalKey.get(key);
    if (existing === undefined) byCanonicalKey.set(key, index);
    else union(existing, index);
  });
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      if (find(left) === find(right)) continue;
      const leftTokens = tokenSets[left];
      const rightTokens = tokenSets[right];
      if (leftTokens === undefined || rightTokens === undefined) continue;
      if (jaccardSimilarity(leftTokens, rightTokens) >= threshold) {
        union(left, right);
      }
    }
  }
  const clusters = new Map<number, T[]>();
  rows.forEach((row, index) => {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), row]);
  });
  return [...clusters.values()];
}
