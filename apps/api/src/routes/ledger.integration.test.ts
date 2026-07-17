import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accounts,
  auditEvents,
  refundLinks,
  transactions,
  transfers,
} from "@betterwealth/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { BetterWealthApplication } from "../app";
import { createApp } from "../app";
import { loadConfig } from "../config";

function testConfig(databasePath: string) {
  return loadConfig({
    APP_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "3001",
    WEB_ORIGIN: "http://localhost:5173",
    DATABASE_URL: databasePath,
    ENCRYPTION_KEY: "b".repeat(64),
    COOKIE_SECURE: "false",
    REGISTRATION_MODE: "open",
    SESSION_IDLE_DAYS: "14",
    SESSION_ABSOLUTE_DAYS: "30",
    SYNC_INTERVAL_MINUTES: "360",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    BOOTSTRAP_OPENROUTER_MODEL: "test/model",
    LOG_LEVEL: "error",
  });
}

function cookieJar(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";", 1);
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) result[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return result;
}

function cookieHeader(jar: Record<string, string>) {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

describe("transaction ledger operations", () => {
  let directory: string;
  let application: BetterWealthApplication;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-ledger-"));
    application = createApp(testConfig(join(directory, "test.sqlite")));
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("splits exactly, confirms transfers, links refunds, and scopes every aggregate", async () => {
    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "ledger@example.com",
        password: "LedgerStrong!2026",
        householdName: "Ledger test",
      }),
    });
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "ledger@example.com", password: "LedgerStrong!2026" }),
    });
    const auth = (await login.json()) as { csrfToken: string };
    const cookies = cookieJar(login);

    const request = (path: string, init: RequestInit = {}) =>
      application.app.request(`/api/v1${path}`, {
        ...init,
        headers: {
          cookie: cookieHeader(cookies),
          origin: "http://localhost:5173",
          "content-type": "application/json",
          "x-csrf-token": auth.csrfToken,
          ...init.headers,
        },
      });
    const create = async (path: string, body: unknown) => {
      const response = await request(path, { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };

    const oversizedBalance = await request("/accounts", {
      method: "POST",
      body: JSON.stringify({
        name: "Impossible balance",
        group: "cash",
        balanceMinorUnits: "9223372036854775808",
      }),
    });
    expect(oversizedBalance.status).toBe(422);
    expect(await oversizedBalance.json()).toMatchObject({
      error: { code: "validation_failed" },
    });

    const checking = await create("/accounts", {
      name: "Checking",
      group: "cash",
      balanceMinorUnits: "100000",
    });
    const savings = await create("/accounts", {
      name: "Savings",
      group: "cash",
      balanceMinorUnits: "50000",
    });
    const balanceHistory = await request(`/accounts/${checking.id}/balances`);
    expect(balanceHistory.status).toBe(200);
    expect(await balanceHistory.json()).toMatchObject({
      account: { id: checking.id, name: "Checking", currency: "USD" },
      data: [
        {
          current: { minorUnits: "100000", currency: "USD" },
          ledger: { minorUnits: "100000", currency: "USD" },
          reconciled: true,
        },
      ],
      summary: {
        current: { minorUnits: "100000", currency: "USD" },
        change: { minorUnits: "0", currency: "USD" },
        reconciled: true,
      },
    });
    const updatedBalance = await request(`/accounts/${checking.id}`, {
      method: "PATCH",
      body: JSON.stringify({ balanceMinorUnits: "-1250" }),
    });
    expect(updatedBalance.status).toBe(200);
    const appendedHistory = await request(`/accounts/${checking.id}/balances`);
    const appendedHistoryBody = (await appendedHistory.json()) as {
      data: unknown[];
      summary: { current: { minorUnits: string }; change: { minorUnits: string } };
    };
    expect(appendedHistoryBody.data).toHaveLength(2);
    expect(appendedHistoryBody.summary.current.minorUnits).toBe("-1250");
    expect(appendedHistoryBody.summary.change.minorUnits).toBe("-101250");

    await application.db
      .update(accounts)
      .set({ isManual: false })
      .where(eq(accounts.id, checking.id));
    const providerBalanceOverwrite = await request(`/accounts/${checking.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Silently changed", balanceMinorUnits: "999999" }),
    });
    expect(providerBalanceOverwrite.status).toBe(409);
    expect(await providerBalanceOverwrite.json()).toMatchObject({
      error: { code: "provider_balance_read_only" },
    });
    const accountsAfterRejectedOverwrite = (await (await request("/accounts")).json()) as {
      data: Array<{ id: string; name: string; balance: { minorUnits: string } }>;
    };
    expect(accountsAfterRejectedOverwrite.data.find(({ id }) => id === checking.id)).toMatchObject({
      name: "Checking",
      balance: { minorUnits: "-1250" },
    });
    await application.db
      .update(accounts)
      .set({ providerMetadata: { providerAccountType: "checking" } })
      .where(eq(accounts.id, checking.id));
    const providerClassificationOverride = await request(`/accounts/${checking.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Daily checking",
        group: "cash",
        type: "depository",
        subtype: "checking",
        status: "hidden",
      }),
    });
    expect(providerClassificationOverride.status).toBe(200);
    expect(
      await application.db
        .select({
          group: accounts.group,
          name: accounts.name,
          type: accounts.type,
          subtype: accounts.subtype,
          status: accounts.status,
          providerMetadata: accounts.providerMetadata,
        })
        .from(accounts)
        .where(eq(accounts.id, checking.id))
        .get(),
    ).toEqual({
      group: "cash",
      name: "Daily checking",
      type: "depository",
      subtype: "checking",
      status: "hidden",
      providerMetadata: {
        providerAccountType: "checking",
        classificationOverride: true,
        nameOverride: true,
        providerName: "Checking",
        statusOverride: true,
      },
    });
    const groceries = await create("/categories", { name: "Groceries", kind: "expense" });
    const home = await create("/categories", { name: "Home", kind: "expense" });
    const wrongCurrency = await request("/transactions", {
      method: "POST",
      body: JSON.stringify({
        accountId: checking.id,
        amountMinorUnits: "-1000",
        currency: "EUR",
        effectiveDate: "2026-07-16T12:00:00.000Z",
        description: "Wrong currency",
      }),
    });
    expect(wrongCurrency.status).toBe(422);
    expect(await wrongCurrency.json()).toMatchObject({
      error: { code: "invalid_ledger_operation" },
    });
    const missingCategory = await request("/transactions", {
      method: "POST",
      body: JSON.stringify({
        accountId: checking.id,
        amountMinorUnits: "-1000",
        currency: "USD",
        effectiveDate: "2026-07-16T12:00:00.000Z",
        description: "Missing category",
        categoryId: "not-a-household-category",
      }),
    });
    expect(missingCategory.status).toBe(404);
    const transaction = (
      accountId: string,
      amountMinorUnits: string,
      description: string,
      categoryId?: string,
    ) =>
      create("/transactions", {
        accountId,
        amountMinorUnits,
        currency: "USD",
        effectiveDate: "2026-07-16T12:00:00.000Z",
        description,
        categoryId,
      });

    const purchase = await transaction(
      checking.id,
      "-10000",
      "Grocery and home order",
      groceries.id,
    );
    const refund = await transaction(checking.id, "2500", "Grocery order refund");
    const outflow = await transaction(checking.id, "-50000", "Transfer to savings");
    const inflow = await transaction(savings.id, "50000", "Transfer from checking");
    const checkingRow = await application.db
      .select({ householdId: accounts.householdId })
      .from(accounts)
      .where(eq(accounts.id, checking.id))
      .get();
    if (!checkingRow) throw new Error("Checking account is missing");
    const refundSuggestionId = "refund-suggestion";
    await application.db.insert(refundLinks).values({
      id: refundSuggestionId,
      householdId: checkingRow.householdId,
      refundTransactionId: refund.id,
      purchaseTransactionId: purchase.id,
      amount: 2_500n,
      confidenceBps: 9_500,
      status: "suggested",
    });
    const transferSuggestionId = "transfer-suggestion";
    await application.db.insert(transfers).values({
      id: transferSuggestionId,
      householdId: checkingRow.householdId,
      outflowTransactionId: outflow.id,
      inflowTransactionId: inflow.id,
      confidenceBps: 9_800,
      status: "suggested",
      matchedBy: "fingerprint",
    });
    expect(
      await application.db
        .select({ isTransfer: transactions.isTransfer, isExcluded: transactions.isExcluded })
        .from(transactions)
        .where(inArray(transactions.id, [outflow.id, inflow.id])),
    ).toEqual([
      { isTransfer: false, isExcluded: false },
      { isTransfer: false, isExcluded: false },
    ]);

    const linked = await request("/refund-links", {
      method: "POST",
      body: JSON.stringify({
        refundTransactionId: refund.id,
        purchaseTransactionId: purchase.id,
      }),
    });
    expect(linked.status).toBe(201);
    const linkedBody = (await linked.json()) as { id: string; status: string };
    expect(linkedBody.id).toBe(refundSuggestionId);
    expect(linkedBody).toMatchObject({
      status: "confirmed",
      amount: { minorUnits: "2500", currency: "USD" },
    });
    const refundDetail = await request(`/transactions/${refund.id}`);
    expect(await refundDetail.json()).toMatchObject({
      categoryName: "Groceries",
      isIncome: false,
      refundLinks: [{ purchaseTransactionId: purchase.id, status: "confirmed" }],
    });

    const split = await request(`/transactions/${purchase.id}/splits`, {
      method: "PUT",
      body: JSON.stringify({
        splits: [
          { amountMinorUnits: "-6000", categoryId: groceries.id, memo: "Food" },
          { amountMinorUnits: "-4000", categoryId: home.id, memo: "Supplies" },
        ],
      }),
    });
    expect(split.status).toBe(200);
    const splitBody = (await split.json()) as {
      data: Array<{ amount: { minorUnits: string } }>;
    };
    expect(splitBody.data.map(({ amount }) => amount.minorUnits)).toEqual(["-6000", "-4000"]);

    const invalidSplit = await request(`/transactions/${purchase.id}/splits`, {
      method: "PUT",
      body: JSON.stringify({
        splits: [
          { amountMinorUnits: "-6000", categoryId: groceries.id },
          { amountMinorUnits: "-3000", categoryId: home.id },
        ],
      }),
    });
    expect(invalidSplit.status).toBe(422);
    const purchaseDetail = await request(`/transactions/${purchase.id}`);
    const purchaseBody = (await purchaseDetail.json()) as {
      splits: Array<{ amount: { minorUnits: string }; categoryName: string }>;
    };
    expect(purchaseBody.splits).toHaveLength(2);
    expect(purchaseBody.splits.map(({ categoryName }) => categoryName)).toEqual([
      "Groceries",
      "Home",
    ]);

    const transfer = await request("/transfers", {
      method: "POST",
      body: JSON.stringify({
        outflowTransactionId: outflow.id,
        inflowTransactionId: inflow.id,
      }),
    });
    expect(transfer.status).toBe(201);
    const transferBody = (await transfer.json()) as { id: string; status: string };
    expect(transferBody.id).toBe(transferSuggestionId);
    expect(transferBody).toMatchObject({ status: "confirmed" });
    const outflowDetail = await request(`/transactions/${outflow.id}`);
    expect(await outflowDetail.json()).toMatchObject({
      isTransfer: true,
      isExcluded: true,
      transfer: { inflowTransactionId: inflow.id, matchedBy: "fingerprint" },
    });
    const duplicateTransfer = await request("/transfers", {
      method: "POST",
      body: JSON.stringify({
        outflowTransactionId: outflow.id,
        inflowTransactionId: inflow.id,
      }),
    });
    expect(duplicateTransfer.status).toBe(409);

    const list = await request("/transactions");
    const listBody = (await list.json()) as {
      data: Array<{
        id: string;
        hasSplits: boolean;
        transferId?: string;
        transfer?: { status: string };
        refundLinkIds: string[];
        refundLinks: Array<{ status: string }>;
      }>;
    };
    expect(listBody.data.find(({ id }) => id === purchase.id)).toMatchObject({
      hasSplits: true,
      refundLinkIds: [expect.any(String)],
      refundLinks: [{ status: "confirmed" }],
    });
    expect(listBody.data.find(({ id }) => id === outflow.id)?.transferId).toEqual(
      expect.any(String),
    );
    expect(listBody.data.find(({ id }) => id === outflow.id)?.transfer).toMatchObject({
      status: "confirmed",
    });

    const spending = await request("/reports/spending");
    const spendingBody = (await spending.json()) as {
      categories: Array<{ category: string; amount: { minorUnits: string; currency: string } }>;
    };
    expect(spendingBody.categories).toEqual([
      { category: "Groceries", amount: { minorUnits: "4500", currency: "USD" } },
      { category: "Home", amount: { minorUnits: "3000", currency: "USD" } },
    ]);
    const cashFlow = await request("/reports/cash-flow");
    const cashFlowBody = (await cashFlow.json()) as {
      months: Array<{
        month: string;
        income: { minorUnits: string };
        expenses: { minorUnits: string };
        surplus: { minorUnits: string };
      }>;
    };
    expect(cashFlowBody.months.find(({ month }) => month === "2026-07")).toMatchObject({
      income: { minorUnits: "0" },
      expenses: { minorUnits: "7500" },
      surplus: { minorUnits: "-7500" },
    });

    expect(
      (
        await request(`/refund-links/${linkedBody.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(`/transfers/${transferBody.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(`/transactions/${purchase.id}/splits`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(await (await request(`/transactions/${purchase.id}`)).json()).toMatchObject({
      reviewState: "needs_review",
      splits: [],
      refundLinks: [],
    });
    expect(await (await request(`/transactions/${outflow.id}`)).json()).toMatchObject({
      isTransfer: false,
      isExcluded: false,
      transfer: null,
      reviewState: "needs_review",
    });
    expect(
      await application.db
        .select({ status: refundLinks.status })
        .from(refundLinks)
        .where(eq(refundLinks.id, linkedBody.id))
        .get(),
    ).toEqual({ status: "rejected" });
    expect(
      await application.db
        .select({ status: transfers.status })
        .from(transfers)
        .where(eq(transfers.id, transferBody.id))
        .get(),
    ).toEqual({ status: "rejected" });
    const confirmedRefundAudit = await application.db
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, linkedBody.id));
    expect(confirmedRefundAudit).toContainEqual({
      action: "movement.confirmed",
      metadata: {
        movementType: "refund",
        refundTransactionId: refund.id,
        purchaseTransactionId: purchase.id,
        amountMinorUnits: "2500",
        currency: "USD",
        evidence: { source: "suggestion", confidenceBps: 9_500 },
      },
    });
    expect(confirmedRefundAudit).toContainEqual({
      action: "movement.rejected",
      metadata: {
        movementType: "refund",
        previousStatus: "confirmed",
        refundTransactionId: refund.id,
        purchaseTransactionId: purchase.id,
        amountMinorUnits: "2500",
        confidenceBps: 10_000,
      },
    });
    const confirmedTransferAudit = await application.db
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, transferBody.id));
    expect(confirmedTransferAudit).toContainEqual({
      action: "movement.confirmed",
      metadata: {
        movementType: "transfer",
        outflowTransactionId: outflow.id,
        inflowTransactionId: inflow.id,
        amountMinorUnits: "50000",
        currency: "USD",
        evidence: {
          source: "suggestion",
          matchedBy: "fingerprint",
          confidenceBps: 9_800,
        },
      },
    });
    expect(confirmedTransferAudit).toContainEqual({
      action: "movement.rejected",
      metadata: {
        movementType: "transfer",
        previousStatus: "confirmed",
        outflowTransactionId: outflow.id,
        inflowTransactionId: inflow.id,
        matchedBy: "fingerprint",
        confidenceBps: 10_000,
      },
    });
    expect(
      (
        await request("/refund-links", {
          method: "POST",
          body: JSON.stringify({
            refundTransactionId: refund.id,
            purchaseTransactionId: purchase.id,
          }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/transfers", {
          method: "POST",
          body: JSON.stringify({
            outflowTransactionId: outflow.id,
            inflowTransactionId: inflow.id,
          }),
        })
      ).status,
    ).toBe(409);

    const suggestedPurchase = await transaction(checking.id, "-4200", "Ordinary merchant");
    const suggestedRefund = await transaction(checking.id, "4200", "Ordinary merchant");
    const suggestedRefundLinkId = "suggested-refund-to-reject";
    await application.db.insert(refundLinks).values({
      id: suggestedRefundLinkId,
      householdId: checkingRow.householdId,
      refundTransactionId: suggestedRefund.id,
      purchaseTransactionId: suggestedPurchase.id,
      amount: 4_200n,
      confidenceBps: 9_500,
      status: "suggested",
    });
    const refundBeforeRejection = await application.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, suggestedRefund.id))
      .get();
    expect(
      (
        await request(`/refund-links/${suggestedRefundLinkId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      await application.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, suggestedRefund.id))
        .get(),
    ).toEqual(refundBeforeRejection);
    expect(
      await application.db
        .select({ status: refundLinks.status })
        .from(refundLinks)
        .where(eq(refundLinks.id, suggestedRefundLinkId))
        .get(),
    ).toEqual({ status: "rejected" });

    const capacityPurchase = await transaction(checking.id, "-5000", "Capacity merchant");
    const capacityRefundOne = await transaction(checking.id, "4000", "Capacity merchant");
    const capacityRefundTwo = await transaction(checking.id, "4000", "Capacity merchant");
    expect(
      (
        await request("/refund-links", {
          method: "POST",
          body: JSON.stringify({
            refundTransactionId: capacityRefundOne.id,
            purchaseTransactionId: capacityPurchase.id,
          }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request("/refund-links", {
          method: "POST",
          body: JSON.stringify({
            refundTransactionId: capacityRefundTwo.id,
            purchaseTransactionId: capacityPurchase.id,
            amountMinorUnits: "2000",
          }),
        })
      ).status,
    ).toBe(422);
    const remainingCapacity = await request("/refund-links", {
      method: "POST",
      body: JSON.stringify({
        refundTransactionId: capacityRefundTwo.id,
        purchaseTransactionId: capacityPurchase.id,
      }),
    });
    expect(remainingCapacity.status).toBe(201);
    expect(await remainingCapacity.json()).toMatchObject({
      amount: { minorUnits: "1000", currency: "USD" },
    });
    expect(
      (
        await application.db
          .select({ amount: refundLinks.amount })
          .from(refundLinks)
          .where(
            and(
              eq(refundLinks.purchaseTransactionId, capacityPurchase.id),
              eq(refundLinks.status, "confirmed"),
            ),
          )
      ).reduce((sum, link) => sum + link.amount, 0n),
    ).toBe(5_000n);
    const wrongAccountRefund = await transaction(savings.id, "5000", "Capacity merchant");
    expect(
      (
        await request("/refund-links", {
          method: "POST",
          body: JSON.stringify({
            refundTransactionId: wrongAccountRefund.id,
            purchaseTransactionId: capacityPurchase.id,
          }),
        })
      ).status,
    ).toBe(422);

    const suggestedOutflow = await transaction(checking.id, "-7000", "Alpha");
    const suggestedInflow = await transaction(savings.id, "7000", "Beta");
    const alternativeInflow = await transaction(savings.id, "7000", "Gamma");
    const suggestedTransferId = "suggested-transfer-to-reject";
    await application.db.insert(transfers).values({
      id: suggestedTransferId,
      householdId: checkingRow.householdId,
      outflowTransactionId: suggestedOutflow.id,
      inflowTransactionId: suggestedInflow.id,
      confidenceBps: 9_800,
      status: "suggested",
      matchedBy: "fingerprint",
    });
    const transferSidesBeforeRejection = await application.db
      .select()
      .from(transactions)
      .where(inArray(transactions.id, [suggestedOutflow.id, suggestedInflow.id]));
    expect(
      (
        await request(`/transfers/${suggestedTransferId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      await application.db
        .select()
        .from(transactions)
        .where(inArray(transactions.id, [suggestedOutflow.id, suggestedInflow.id])),
    ).toEqual(transferSidesBeforeRejection);
    expect(
      await application.db
        .select({ status: transfers.status })
        .from(transfers)
        .where(eq(transfers.id, suggestedTransferId))
        .get(),
    ).toEqual({ status: "rejected" });
    const alternativeTransfer = await request("/transfers", {
      method: "POST",
      body: JSON.stringify({
        outflowTransactionId: suggestedOutflow.id,
        inflowTransactionId: alternativeInflow.id,
      }),
    });
    expect(alternativeTransfer.status).toBe(201);

    const tagged = await transaction(checking.id, "-1234", "Independent contractor expense");
    const replaceTags = await request(`/transactions/${tagged.id}/tags`, {
      method: "PUT",
      body: JSON.stringify({
        tags: ["Tax Deductible", "tax deductible", "  Side   Hustle  "],
      }),
    });
    expect(replaceTags.status).toBe(200);
    expect(await replaceTags.json()).toEqual({
      id: tagged.id,
      tags: ["Tax Deductible", "Side Hustle"],
    });
    expect(
      await application.db
        .select({ userOverrideAt: transactions.userOverrideAt })
        .from(transactions)
        .where(eq(transactions.id, tagged.id))
        .get(),
    ).toEqual({ userOverrideAt: null });
    const taggedPatch = await request(`/transactions/${tagged.id}`, {
      method: "PATCH",
      body: JSON.stringify({ note: "Receipt retained" }),
    });
    expect(taggedPatch.status).toBe(200);
    expect(await taggedPatch.json()).toMatchObject({
      id: tagged.id,
      note: "Receipt retained",
      tags: ["Side Hustle", "Tax Deductible"],
    });
    const overrideBeforeRemoval = await application.db
      .select({ userOverrideAt: transactions.userOverrideAt })
      .from(transactions)
      .where(eq(transactions.id, tagged.id))
      .get();
    expect(overrideBeforeRemoval?.userOverrideAt).toEqual(expect.any(String));
    expect(await (await request(`/transactions/${tagged.id}`)).json()).toMatchObject({
      tags: ["Side Hustle", "Tax Deductible"],
      status: "posted",
    });
    const taggedListBeforeRemoval = (await (await request("/transactions")).json()) as {
      data: Array<{ id: string; status: string; tags: string[] }>;
    };
    expect(taggedListBeforeRemoval.data.find(({ id }) => id === tagged.id)).toMatchObject({
      status: "posted",
      tags: expect.arrayContaining(["Tax Deductible", "Side Hustle"]),
    });

    await application.db
      .update(transactions)
      .set({ status: "pending" })
      .where(eq(transactions.id, tagged.id));
    const removed = await request(`/transactions/${tagged.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      id: tagged.id,
      status: "removed",
      removed: true,
      changed: true,
    });
    expect(await (await request(`/transactions/${tagged.id}`)).json()).toMatchObject({
      status: "removed",
      tags: ["Side Hustle", "Tax Deductible"],
    });
    const removedList = (await (await request("/transactions")).json()) as {
      data: Array<{ id: string; status: string }>;
    };
    expect(removedList.data.find(({ id }) => id === tagged.id)?.status).toBe("removed");
    expect(
      (
        await request(`/transactions/${tagged.id}`, {
          method: "PATCH",
          body: JSON.stringify({ note: "Must restore first" }),
        })
      ).status,
    ).toBe(409);
    expect(
      await application.db
        .select({ id: transactions.id, status: transactions.status })
        .from(transactions)
        .where(eq(transactions.id, tagged.id))
        .get(),
    ).toEqual({ id: tagged.id, status: "removed" });
    const repeatedRemoval = await request(`/transactions/${tagged.id}`, { method: "DELETE" });
    expect(await repeatedRemoval.json()).toMatchObject({ status: "removed", changed: false });
    await application.db
      .update(transactions)
      .set({ postedAt: "2026-07-17T12:00:00.000Z" })
      .where(eq(transactions.id, tagged.id));

    const restored = await request(`/transactions/${tagged.id}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({
      id: tagged.id,
      status: "posted",
      restored: true,
    });
    expect(await (await request(`/transactions/${tagged.id}`)).json()).toMatchObject({
      status: "posted",
      tags: ["Side Hustle", "Tax Deductible"],
    });
    expect(
      await application.db
        .select({ userOverrideAt: transactions.userOverrideAt })
        .from(transactions)
        .where(eq(transactions.id, tagged.id))
        .get(),
    ).toEqual(overrideBeforeRemoval);
    const transactionAudit = await application.db
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.householdId, checkingRow.householdId),
          eq(auditEvents.entityType, "transaction"),
          eq(auditEvents.entityId, tagged.id),
        ),
      );
    expect(transactionAudit).toHaveLength(3);
    expect(transactionAudit).toContainEqual({
      action: "transaction.tags_replaced",
      metadata: {
        previousTags: [],
        tags: ["Tax Deductible", "Side Hustle"],
      },
    });
    expect(transactionAudit).toContainEqual({
      action: "transaction.removed",
      metadata: {
        previousStatus: "pending",
        previousUserOverrideAt: overrideBeforeRemoval?.userOverrideAt,
      },
    });
    expect(transactionAudit).toContainEqual({
      action: "transaction.restored",
      metadata: {
        restoredStatus: "posted",
        restoredUserOverrideAt: overrideBeforeRemoval?.userOverrideAt,
        removalAuditEventId: expect.any(String),
      },
    });

    const bulkEligible = await transaction(checking.id, "-875", "Bulk eligible");
    const bulkRemoved = await transaction(checking.id, "-975", "Bulk removed");
    expect((await request(`/transactions/${bulkRemoved.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    const bulkUpdate = await request("/transactions/bulk", {
      method: "POST",
      body: JSON.stringify({
        ids: [bulkEligible.id, bulkRemoved.id, bulkEligible.id, "missing-transaction"],
        patch: { categoryName: "Home", note: "Reviewed as one batch" },
      }),
    });
    expect(bulkUpdate.status).toBe(200);
    const bulkUpdateBody = (await bulkUpdate.json()) as {
      affected: number;
      batchId: string;
      reversibleBatchId?: string;
    };
    expect(bulkUpdateBody.affected).toBe(1);
    expect(typeof bulkUpdateBody.batchId).toBe("string");
    expect(bulkUpdateBody.batchId.length).toBeGreaterThan(0);
    expect(bulkUpdateBody).not.toHaveProperty("reversibleBatchId");
    expect(await (await request(`/transactions/${bulkEligible.id}`)).json()).toMatchObject({
      categoryName: "Home",
      note: "Reviewed as one batch",
    });
    expect(await (await request(`/transactions/${bulkRemoved.id}`)).json()).toMatchObject({
      categoryName: "Uncategorized",
      note: null,
      status: "removed",
    });
    const bulkAudit = (
      await application.db
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          entityType: auditEvents.entityType,
          metadata: auditEvents.metadata,
        })
        .from(auditEvents)
    ).find(({ id }) => id === bulkUpdateBody.batchId);
    expect(bulkAudit).toEqual({
      id: bulkUpdateBody.batchId,
      action: "transaction.bulk_updated",
      entityType: "transaction_batch",
      metadata: {
        batchId: bulkUpdateBody.batchId,
        transactionIds: [bulkEligible.id],
        categoryId: home.id,
        categoryName: "Home",
        patch: { categoryName: "Home", note: "Reviewed as one batch" },
      },
    });

    const paginatedRows = Array.from({ length: 260 }, (_, index) => ({
      id: `pagination-${index.toString().padStart(3, "0")}`,
      householdId: checkingRow.householdId,
      accountId: checking.id,
      amount: index === 0 ? -43_210n : -100n - BigInt(index),
      currency: "USD",
      postedAt: "2025-01-01T00:00:00.000Z",
      transactedOn: "2025-01-01T00:00:00.000Z",
      rawDescription:
        index === 0 ? "Ancient pagination sentinel" : `Pagination ledger row ${index}`,
      normalizedDescription:
        index === 0 ? "ancient pagination sentinel" : `pagination ledger row ${index}`,
      status: index === 0 ? ("removed" as const) : ("posted" as const),
      source: "manual" as const,
    }));
    for (let index = 0; index < paginatedRows.length; index += 40) {
      await application.db.insert(transactions).values(paginatedRows.slice(index, index + 40));
    }
    await application.db.insert(transactions).values({
      id: "account-filter-sentinel",
      householdId: checkingRow.householdId,
      accountId: savings.id,
      amount: -321n,
      currency: "USD",
      postedAt: "2024-01-01T00:00:00.000Z",
      transactedOn: "2024-01-01T00:00:00.000Z",
      rawDescription: "Old account-scoped sentinel",
      normalizedDescription: "old account scoped sentinel",
      status: "posted",
      source: "manual",
    });
    const scopedActivity = await request(
      `/transactions?accountId=${encodeURIComponent(savings.id)}&limit=100`,
    );
    expect(scopedActivity.status).toBe(200);
    const scopedActivityBody = (await scopedActivity.json()) as {
      data: Array<{ id: string; accountId: string }>;
    };
    expect(scopedActivityBody.data.every(({ accountId }) => accountId === savings.id)).toBeTrue();
    expect(scopedActivityBody.data.map(({ id }) => id)).toContain("account-filter-sentinel");

    const invalidAccountFilter = await request("/transactions?accountId=not-an-internal-id");
    expect(invalidAccountFilter.status).toBe(422);
    expect(await invalidAccountFilter.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    const discoveredIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await request(
        `/transactions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<{ id: string }>;
        page: { cursor: string | null; hasMore: boolean };
      };
      expect(body.data.length).toBeLessThanOrEqual(100);
      discoveredIds.push(...body.data.map(({ id }) => id));
      cursor = body.page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
      if (body.page.hasMore) expect(cursor).not.toBeNull();
    } while (cursor);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(new Set(discoveredIds).size).toBe(discoveredIds.length);
    expect(discoveredIds.filter((id) => id.startsWith("pagination-"))).toHaveLength(260);

    const oldDescriptionSearch = await request(
      "/transactions?query=Ancient%20pagination%20sentinel&limit=10",
    );
    expect(await oldDescriptionSearch.json()).toMatchObject({
      data: [{ id: "pagination-000", status: "removed" }],
      page: { cursor: null, hasMore: false },
    });
    const oldAmountSearch = await request("/transactions?query=-432.10&limit=10");
    expect(await oldAmountSearch.json()).toMatchObject({
      data: [{ id: "pagination-000", amount: { minorUnits: "-43210", currency: "USD" } }],
    });
    const invalidCursor = await request("/transactions?cursor=not-a-valid-cursor");
    expect(invalidCursor.status).toBe(422);
    expect(await invalidCursor.json()).toMatchObject({ error: { code: "validation_failed" } });

    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "other-ledger@example.com",
        password: "OtherLedger!2026",
        householdName: "Other ledger",
      }),
    });
    const otherLogin = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "other-ledger@example.com",
        password: "OtherLedger!2026",
      }),
    });
    const isolated = await application.app.request(`/api/v1/transactions/${purchase.id}`, {
      headers: { cookie: cookieHeader(cookieJar(otherLogin)) },
    });
    expect(isolated.status).toBe(404);
    const isolatedAccountActivity = await application.app.request(
      `/api/v1/transactions?accountId=${encodeURIComponent(checking.id)}`,
      { headers: { cookie: cookieHeader(cookieJar(otherLogin)) } },
    );
    expect(isolatedAccountActivity.status).toBe(200);
    expect(await isolatedAccountActivity.json()).toMatchObject({
      data: [],
      page: { cursor: null, hasMore: false },
    });
  });
});
