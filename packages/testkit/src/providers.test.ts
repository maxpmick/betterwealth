import { describe, expect, test } from "bun:test";

import { parseMajorToMinor, validateSafeRegex } from "@betterwealth/shared";

import { OPENROUTER_VALID_SUGGESTION, openRouterFixtures } from "./openrouter.ts";
import { simpleFinFixtures, simpleFinMalformedDecimalFixture } from "./simplefin.ts";

describe("SimpleFIN provider fixtures", () => {
  test("v1 and v2 balances and transactions use exact decimal strings", () => {
    for (const fixture of [simpleFinFixtures.v1, simpleFinFixtures.v2]) {
      for (const account of fixture.accounts) {
        expect(() => parseMajorToMinor(account.balance, account.currency)).not.toThrow();
        for (const transaction of account.transactions ?? []) {
          expect(() => parseMajorToMinor(transaction.amount, account.currency)).not.toThrow();
        }
      }
    }
  });

  test("represents duplicate transaction IDs safely with account-scoped identity", () => {
    const transactions = simpleFinFixtures.duplicateAcrossAccounts.accounts.flatMap((account) =>
      (account.transactions ?? []).map((transaction) => ({
        accountId: account.id,
        transactionId: transaction.id,
      })),
    );
    expect(transactions[0]!.transactionId).toBe(transactions[1]!.transactionId);
    expect(
      new Set(transactions.map((item) => `${item.accountId}:${item.transactionId}`)).size,
    ).toBe(2);
  });

  test("includes pending-to-posted linkage and malformed fail-closed cases", () => {
    expect(simpleFinFixtures.pendingRevision.pending.pending).toBeTrue();
    expect(simpleFinFixtures.pendingRevision.posted.extra.pending_transaction_id).toBe(
      simpleFinFixtures.pendingRevision.pending.id,
    );
    expect(() =>
      parseMajorToMinor(simpleFinMalformedDecimalFixture.accounts[0]!.balance, "USD"),
    ).toThrow();
    expect(() =>
      parseMajorToMinor(
        simpleFinMalformedDecimalFixture.accounts[0]!.transactions![0]!.amount,
        "USD",
      ),
    ).toThrow();
  });

  test("contains sanitized non-success and timeout scenarios", () => {
    expect(simpleFinFixtures.errors.paymentRequired.status).toBe(402);
    expect(simpleFinFixtures.errors.forbidden.status).toBe(403);
    expect(simpleFinFixtures.errors.rateLimited.status).toBe(429);
    expect(simpleFinFixtures.errors.serverError.status).toBe(503);
    expect(simpleFinFixtures.errors.timeout.kind).toBe("timeout");
    expect(JSON.stringify(simpleFinFixtures)).not.toContain("password");
  });
});

describe("OpenRouter provider fixtures", () => {
  test("returns valid strict JSON with only an allowed category", () => {
    const content = openRouterFixtures.valid.choices[0]!.message.content;
    expect(JSON.parse(content)).toEqual(OPENROUTER_VALID_SUGGESTION);
    expect(openRouterFixtures.request.response_format.type).toBe("json_schema");
    expect(openRouterFixtures.request.response_format.json_schema.strict).toBeTrue();
  });

  test("covers invalid JSON, unknown IDs, and unsafe broad rules", () => {
    expect(() => JSON.parse(openRouterFixtures.invalidJson.choices[0]!.message.content)).toThrow();
    const unknown = JSON.parse(openRouterFixtures.unknownId.choices[0]!.message.content) as {
      categoryId: string;
    };
    const requestInput = JSON.parse(openRouterFixtures.request.messages[1]!.content) as {
      allowedCategories: readonly { id: string }[];
    };
    expect(
      requestInput.allowedCategories.some((category) => category.id === unknown.categoryId),
    ).toBeFalse();
    const broad = JSON.parse(openRouterFixtures.overbroadRule.choices[0]!.message.content) as {
      proposedRule: { condition: { value: string } };
    };
    expect(validateSafeRegex(broad.proposedRule.condition.value).safe).toBeFalse();
  });

  test("keeps injection-shaped text inside minimized untrusted data", () => {
    const input = JSON.parse(
      openRouterFixtures.injectionShapedInput.messages[1]!.content,
    ) as Record<string, unknown>;
    expect(String(input.normalizedDescription)).toContain("IGNORE ALL INSTRUCTIONS");
    expect(input).not.toHaveProperty("email");
    expect(input).not.toHaveProperty("accountNumber");
    expect(input).not.toHaveProperty("accessUrl");
    expect(input).not.toHaveProperty("apiKey");
  });

  test("covers graceful fallback errors", () => {
    expect(openRouterFixtures.errors.rateLimited.status).toBe(429);
    expect(openRouterFixtures.errors.unsupportedStructuredOutput.status).toBe(400);
    expect(openRouterFixtures.errors.providerFailure.status).toBe(502);
    expect(openRouterFixtures.errors.timeout.kind).toBe("timeout");
  });
});
