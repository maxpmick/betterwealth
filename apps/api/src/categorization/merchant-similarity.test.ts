import { expect, test } from "bun:test";
import {
  canonicalMerchantKey,
  clusterByMerchantSimilarity,
  jaccardSimilarity,
  merchantTokens,
  ruleMerchantTokens,
  SIMILAR_MERCHANT_THRESHOLD,
} from "./merchant-similarity";

test("merchant tokens drop statement noise, order IDs, and store suffixes", () => {
  expect(merchantTokens("AMAZON MKTPL BS8HH6UF0")).toEqual(new Set(["amazon", "mktpl"]));
  expect(merchantTokens("TST WELCOME TO THE FARM")).toEqual(
    new Set(["welcome", "to", "the", "farm"]),
  );
  expect(merchantTokens("BEREA LASERWASH INC")).toEqual(new Set(["berea", "laserwash"]));
  expect(merchantTokens("365 MARKET FP")).toEqual(new Set(["365", "market", "fp"]));
  expect(merchantTokens("SQ ROCKY RIVER SHOP")).toEqual(new Set(["rocky", "river", "shop"]));
});

test("jaccard similarity scores shared token identity", () => {
  expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b", "c"]))).toBeCloseTo(2 / 3);
  expect(jaccardSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0);
  expect(jaccardSimilarity(new Set(), new Set(["b"]))).toBe(0);
});

test("canonical merchant key is stable across casing and suffix noise", () => {
  expect(canonicalMerchantKey("BEREA BEVERAGE")).toBe(canonicalMerchantKey("Berea Beverage Inc"));
  expect(canonicalMerchantKey("AMAZON MKTPL BS8HH6UF0")).toBe(canonicalMerchantKey("AMAZON MKTPL"));
});

test("rule merchant tokens read text conditions and ignore the rest", () => {
  expect(
    ruleMerchantTokens({
      all: [
        {
          field: "normalizedDescription",
          operator: "contains",
          value: "AMAZON MKTPL",
          caseSensitive: false,
        },
        { field: "direction", operator: "exact", value: "outflow" },
      ],
    }),
  ).toEqual(new Set(["amazon", "mktpl"]));
  expect(
    ruleMerchantTokens({
      field: "merchant",
      operator: "exact",
      value: "Corner Coffee",
      caseSensitive: false,
    }),
  ).toEqual(new Set(["corner", "coffee"]));
  expect(
    ruleMerchantTokens({
      field: "normalizedDescription",
      operator: "regex",
      value: "AMAZON.*",
      caseSensitive: false,
    }),
  ).toEqual(new Set());
  expect(
    ruleMerchantTokens({ field: "amount", operator: "between", minimum: "100", maximum: "200" }),
  ).toEqual(new Set());
});

function candidate(id: string, normalizedDescription: string) {
  return { transaction: { id, normalizedDescription } };
}

test("same-merchant variants cluster together, different merchants stay apart", () => {
  const amazonA = candidate("1", "AMAZON MKTPL BS8HH6UF0");
  const amazonB = candidate("2", "AMAZON MKTPL ZZ99YY88");
  const cvs = candidate("3", "CVS PHARMACY");
  const berea = candidate("4", "BEREA BEVERAGE");
  const bereaInc = candidate("5", "BEREA BEVERAGE INC");
  const clusters = clusterByMerchantSimilarity([amazonA, cvs, amazonB, berea, bereaInc]);
  expect(clusters).toHaveLength(3);
  const clusterOf = (needle: string) =>
    clusters.findIndex((cluster) => cluster.some((row) => row.transaction.id === needle));
  expect(clusterOf("1")).toBe(clusterOf("2"));
  expect(clusterOf("4")).toBe(clusterOf("5"));
  expect(clusterOf("3")).not.toBe(clusterOf("1"));
  expect(clusterOf("3")).not.toBe(clusterOf("4"));
  // Input order is preserved: first-appearance cluster order and row order inside clusters.
  expect(clusters[0]?.map((row) => row.transaction.id)).toEqual(["1", "2"]);
});

test("the threshold separates lookalikes from distinct merchants", () => {
  expect(SIMILAR_MERCHANT_THRESHOLD).toBeGreaterThan(
    jaccardSimilarity(merchantTokens("BEREA BEVERAGE"), merchantTokens("PIER BEVERAGE")),
  );
  expect(
    jaccardSimilarity(merchantTokens("AMAZON MKTPL"), merchantTokens("AMAZON MKTPLACE PMTS")),
  ).toBeLessThan(SIMILAR_MERCHANT_THRESHOLD);
  expect(
    jaccardSimilarity(merchantTokens("365 MARKET FP"), merchantTokens("365 MARKET")),
  ).toBeGreaterThanOrEqual(SIMILAR_MERCHANT_THRESHOLD);
});
