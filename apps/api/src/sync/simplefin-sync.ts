import type { BetterWealthDatabase } from "@betterwealth/db";
import { createHouseholdRepositories } from "@betterwealth/db";
import {
  accounts,
  balanceSnapshots,
  connections,
  merchants,
  providerInstitutions,
  syncRuns,
  transactions,
} from "@betterwealth/db/schema";
import { parseDecimalToMinorUnits } from "@betterwealth/shared";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { categorizeHouseholdTransactions } from "../categorization/service";
import type { AppConfig } from "../config";
import type { SimpleFinAccountSet } from "../integrations/simplefin";
import { fetchSimpleFinAccounts } from "../integrations/simplefin";
import { FieldCipher, secureEqual } from "../lib/crypto";
import { AppError, NotFoundError } from "../lib/errors";
import {
  normalizeDescription,
  reconcilePendingTransactions,
  transactionFingerprint,
} from "./reconcile";
import { reconcileAccountTransfers } from "./transfer-reconcile";

type SyncCounts = {
  accountsSeen: number;
  balancesCreated: number;
  transactionsCreated: number;
  transactionsUpdated: number;
};

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function normalizeCurrency(value: string): { currency: string; originalCurrency?: string } {
  const upper = value.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return { currency: upper };
  return { currency: "XXX", originalCurrency: value };
}

function fractionDigits(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  if (currency === "BTC") return 8;
  return 2;
}

function parseProviderMoney(value: string, currency: string): bigint {
  return parseDecimalToMinorUnits(value, fractionDigits(currency), "half-even");
}

function inferAccountType(name: string, extra: Record<string, unknown> | undefined) {
  const hint = [
    name,
    typeof extra?.["account-type"] === "string" ? extra["account-type"] : "",
    typeof extra?.account_type === "string" ? extra.account_type : "",
    typeof extra?.type === "string" ? extra.type : "",
    typeof extra?.subtype === "string" ? extra.subtype : "",
  ]
    .join(" ")
    .toLowerCase();
  if (/credit|card/.test(hint))
    return { group: "credit" as const, type: "credit_card", isLiability: true };
  if (/loan|mortgage|student|auto debt/.test(hint))
    return { group: "loan" as const, type: "loan", isLiability: true };
  if (/401|403|ira|retire|broker|invest|stock|securit/.test(hint)) {
    return { group: "investment" as const, type: "investment", isLiability: false };
  }
  if (/crypto|bitcoin|ethereum/.test(hint))
    return { group: "crypto" as const, type: "crypto", isLiability: false };
  if (/reward|point|miles/.test(hint))
    return { group: "rewards" as const, type: "rewards", isLiability: false };
  if (/saving|money market|cash management/.test(hint))
    return { group: "cash" as const, type: "savings", isLiability: false };
  return { group: "cash" as const, type: "checking", isLiability: false };
}

function isoFromEpoch(epoch: number, fallback = Date.now()): string {
  const milliseconds = epoch > 0 ? epoch * 1_000 : fallback;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, "")
    .slice(0, 300);
}

async function institutionForAccount(
  db: BetterWealthDatabase,
  householdId: string,
  connectionId: string,
  account: SimpleFinAccountSet["accounts"][number],
  response: SimpleFinAccountSet,
) {
  const providerConnection = response.connections.find(
    (entry) => entry.conn_id === account.conn_id,
  );
  const externalId =
    account.conn_id ?? providerConnection?.conn_id ?? account.org?.domain ?? "simplefin";
  const existing = await db
    .select()
    .from(providerInstitutions)
    .where(
      and(
        eq(providerInstitutions.connectionId, connectionId),
        eq(providerInstitutions.externalId, externalId),
      ),
    )
    .get();
  const name =
    providerConnection?.org_name ??
    providerConnection?.name ??
    account.org?.name ??
    account.org?.domain ??
    "Financial institution";
  if (existing) {
    await db
      .update(providerInstitutions)
      .set({
        name,
        url: providerConnection?.org_url,
        metadata: { simplefinConnectionId: account.conn_id },
      })
      .where(eq(providerInstitutions.id, existing.id));
    return existing.id;
  }
  const id = ulid();
  await db.insert(providerInstitutions).values({
    id,
    householdId,
    connectionId,
    externalId,
    name,
    url: providerConnection?.org_url,
    metadata: { simplefinConnectionId: account.conn_id },
  });
  return id;
}

async function merchantForDescription(
  db: BetterWealthDatabase,
  householdId: string,
  description: string,
) {
  const normalizedName = normalizeDescription(description) || "UNKNOWN MERCHANT";
  const existing = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(
      and(eq(merchants.householdId, householdId), eq(merchants.normalizedName, normalizedName)),
    )
    .get();
  if (existing) return existing.id;
  const id = ulid();
  await db.insert(merchants).values({
    id,
    householdId,
    name: description.trim().slice(0, 160) || "Unknown merchant",
    normalizedName,
  });
  return id;
}

async function syncAccount(
  db: BetterWealthDatabase,
  householdId: string,
  connectionId: string,
  syncRunId: string,
  account: SimpleFinAccountSet["accounts"][number],
  response: SimpleFinAccountSet,
  counts: SyncCounts,
) {
  const institutionId = await institutionForAccount(
    db,
    householdId,
    connectionId,
    account,
    response,
  );
  const currencyInfo = normalizeCurrency(account.currency);
  const inferred = inferAccountType(account.name, account.extra);
  let localAccount = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.connectionId, connectionId), eq(accounts.externalId, account.id)))
    .get();
  const providerMetadata = {
    ...account.extra,
    ...(currencyInfo.originalCurrency
      ? { simplefinCustomCurrency: currencyInfo.originalCurrency }
      : {}),
  };
  if (!localAccount) {
    const id = ulid();
    await db.insert(accounts).values({
      id,
      householdId,
      connectionId,
      institutionId,
      externalId: account.id,
      name: account.name,
      group: inferred.group,
      type: inferred.type,
      currency: currencyInfo.currency,
      isLiability: inferred.isLiability,
      isManual: false,
      providerMetadata,
      status: "active",
    });
    localAccount = await db.select().from(accounts).where(eq(accounts.id, id)).get();
  } else {
    await db
      .update(accounts)
      .set({
        institutionId,
        name: account.name,
        currency: currencyInfo.currency,
        providerMetadata,
        status: "active",
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(accounts.householdId, householdId), eq(accounts.id, localAccount.id)));
  }
  if (!localAccount) throw new Error("SimpleFIN account could not be persisted");
  counts.accountsSeen += 1;

  const balanceAsOf = isoFromEpoch(account["balance-date"]);
  const currentBalance = parseProviderMoney(account.balance, currencyInfo.currency);
  const availableBalance = account["available-balance"]
    ? parseProviderMoney(account["available-balance"], currencyInfo.currency)
    : currentBalance;
  const existingBalance = await db
    .select({ id: balanceSnapshots.id })
    .from(balanceSnapshots)
    .where(
      and(
        eq(balanceSnapshots.accountId, localAccount.id),
        eq(balanceSnapshots.asOf, balanceAsOf),
        eq(balanceSnapshots.source, "provider"),
      ),
    )
    .get();
  if (existingBalance) {
    await db
      .update(balanceSnapshots)
      .set({
        ledgerBalance: currentBalance,
        currentBalance,
        availableBalance,
        currency: currencyInfo.currency,
        syncRunId,
      })
      .where(eq(balanceSnapshots.id, existingBalance.id));
  } else {
    await db.insert(balanceSnapshots).values({
      id: ulid(),
      householdId,
      accountId: localAccount.id,
      ledgerBalance: currentBalance,
      currentBalance,
      availableBalance,
      currency: currencyInfo.currency,
      asOf: balanceAsOf,
      source: "provider",
      syncRunId,
    });
    counts.balancesCreated += 1;
  }

  const existingPending = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(transactions.accountId, localAccount.id),
        eq(transactions.status, "pending"),
      ),
    );
  const incomingCandidates = account.transactions
    .filter((transaction) => !transaction.pending && transaction.posted > 0)
    .map((transaction) => {
      const occurredAt = isoFromEpoch(transaction.transacted_at ?? transaction.posted);
      return {
        id: transaction.id,
        externalId: transaction.id,
        accountId: localAccount.id,
        amountMinor: parseProviderMoney(transaction.amount, currencyInfo.currency).toString(),
        description: transaction.description,
        occurredAt,
        pending: false,
      };
    });
  const reconciliation = reconcilePendingTransactions(
    existingPending.map((transaction) => ({
      id: transaction.id,
      ...(transaction.externalId ? { externalId: transaction.externalId } : {}),
      accountId: transaction.accountId,
      amountMinor: transaction.amount.toString(),
      description: transaction.rawDescription,
      occurredAt: transaction.authorizedAt ?? transaction.transactedOn,
      pending: true,
    })),
    incomingCandidates,
  );
  const pendingMatchByPosted = new Map(
    reconciliation.matches.map((match) => [match.postedId, match.pendingId]),
  );

  for (const providerTransaction of account.transactions) {
    const amount = parseProviderMoney(providerTransaction.amount, currencyInfo.currency);
    if (amount === 0n) continue;
    const pending = providerTransaction.pending === true || providerTransaction.posted === 0;
    const effectiveEpoch = providerTransaction.transacted_at ?? providerTransaction.posted;
    const transactedOn = isoFromEpoch(effectiveEpoch, new Date(balanceAsOf).getTime());
    const postedAt = pending ? undefined : isoFromEpoch(providerTransaction.posted);
    const normalized = normalizeDescription(providerTransaction.description) || "UNKNOWN MERCHANT";
    const merchantId = await merchantForDescription(
      db,
      householdId,
      providerTransaction.description,
    );
    const matchedPendingId = pending ? undefined : pendingMatchByPosted.get(providerTransaction.id);
    const existing = matchedPendingId
      ? await db.select().from(transactions).where(eq(transactions.id, matchedPendingId)).get()
      : await db
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.connectionId, connectionId),
              eq(transactions.accountId, localAccount.id),
              eq(transactions.externalId, providerTransaction.id),
            ),
          )
          .get();
    const fingerprint = transactionFingerprint({
      accountId: localAccount.id,
      externalId: providerTransaction.id,
      amountMinor: amount.toString(),
      description: providerTransaction.description,
      occurredAt: transactedOn,
    });
    if (existing) {
      await db
        .update(transactions)
        .set({
          externalId: providerTransaction.id,
          pendingExternalId:
            matchedPendingId && existing.externalId !== providerTransaction.id
              ? existing.externalId
              : existing.pendingExternalId,
          amount,
          currency: currencyInfo.currency,
          authorizedAt: transactedOn,
          postedAt,
          transactedOn,
          rawDescription: providerTransaction.description,
          normalizedDescription: normalized,
          merchantId,
          status: pending ? "pending" : "posted",
          providerCategory:
            typeof providerTransaction.extra?.category === "string"
              ? providerTransaction.extra.category
              : undefined,
          providerMetadata: providerTransaction.extra,
          fingerprint,
          lastSeenAt: new Date().toISOString(),
          removedUpstreamAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(transactions.householdId, householdId), eq(transactions.id, existing.id)));
      counts.transactionsUpdated += 1;
    } else {
      await db.insert(transactions).values({
        id: ulid(),
        householdId,
        accountId: localAccount.id,
        connectionId,
        externalId: providerTransaction.id,
        amount,
        currency: currencyInfo.currency,
        authorizedAt: transactedOn,
        postedAt,
        transactedOn,
        rawDescription: providerTransaction.description,
        normalizedDescription: normalized,
        merchantId,
        status: pending ? "pending" : "posted",
        source: "provider",
        reviewState: "needs_review",
        isIncome: amount > 0n,
        providerCategory:
          typeof providerTransaction.extra?.category === "string"
            ? providerTransaction.extra.category
            : undefined,
        providerMetadata: providerTransaction.extra,
        fingerprint,
      });
      counts.transactionsCreated += 1;
    }
  }
}

export async function syncSimpleFinConnection(input: {
  db: BetterWealthDatabase;
  config: AppConfig;
  householdId: string;
  connectionId: string;
  trigger?: "manual" | "scheduled" | "initial" | "retry";
  jobId?: string;
  fetchAccounts?: typeof fetchSimpleFinAccounts;
}) {
  const repositories = createHouseholdRepositories(input.db, input.householdId);
  const connection = repositories.connections.findById(input.connectionId);
  if (connection?.provider !== "simplefin") throw new NotFoundError("SimpleFIN connection");
  const runId = ulid();
  const startedAt = new Date().toISOString();
  await input.db.insert(syncRuns).values({
    id: runId,
    householdId: input.householdId,
    connectionId: connection.id,
    jobId: input.jobId,
    trigger: input.trigger ?? "manual",
    state: "running",
    startedAt,
  });
  await input.db
    .update(connections)
    .set({ lastAttemptAt: startedAt })
    .where(and(eq(connections.householdId, input.householdId), eq(connections.id, connection.id)));

  const counts: SyncCounts = {
    accountsSeen: 0,
    balancesCreated: 0,
    transactionsCreated: 0,
    transactionsUpdated: 0,
  };
  try {
    const cipher = new FieldCipher(input.config.ENCRYPTION_KEY);
    const expectedAad = `connection:${connection.id}:credentials`;
    if (!secureEqual(connection.credentialsAad, expectedAad)) {
      throw new AppError(
        "SimpleFIN credentials failed their record binding check",
        409,
        "credential_binding_failed",
      );
    }
    const accessUrl = cipher.decrypt(connection.encryptedCredentials, expectedAad);
    const checkpoint = connection.syncCursor ? Number(connection.syncCursor) : undefined;
    const startDate =
      checkpoint && Number.isFinite(checkpoint) ? Math.max(0, checkpoint - 14 * 86_400) : 0;
    const response = await (input.fetchAccounts ?? fetchSimpleFinAccounts)(accessUrl, {
      startDate,
      pending: true,
    });
    for (const account of response.accounts) {
      await syncAccount(
        input.db,
        input.householdId,
        connection.id,
        runId,
        account,
        response,
        counts,
      );
    }
    const transferReconciliation = await reconcileAccountTransfers(input.db, input.householdId);
    const categorization = await categorizeHouseholdTransactions({
      db: input.db,
      config: input.config,
      householdId: input.householdId,
      userId: connection.ownerUserId,
    });
    const checkpointAfter = Math.floor(Date.now() / 1_000).toString();
    const providerErrors = [
      ...response.errlist.map(({ code, msg }) => `${code}: ${sanitizeProviderMessage(msg)}`),
      ...response.errors.map(sanitizeProviderMessage),
    ];
    const finishedAt = new Date().toISOString();
    await input.db
      .update(syncRuns)
      .set({
        state: "succeeded",
        checkpointBefore: connection.syncCursor,
        checkpointAfter,
        ...counts,
        errorCode: providerErrors.length ? "provider_warning" : null,
        errorMessage: providerErrors.length ? providerErrors.join("; ").slice(0, 1_000) : null,
        finishedAt,
      })
      .where(eq(syncRuns.id, runId));
    await input.db
      .update(connections)
      .set({
        status: providerErrors.length ? "degraded" : "active",
        syncCursor: checkpointAfter,
        lastSuccessAt: finishedAt,
        lastErrorCode: providerErrors.length ? "provider_warning" : null,
        updatedAt: finishedAt,
      })
      .where(
        and(eq(connections.householdId, input.householdId), eq(connections.id, connection.id)),
      );
    return {
      syncRunId: runId,
      state: "succeeded" as const,
      ...counts,
      categorization,
      transferReconciliation,
      providerErrors,
    };
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            "SimpleFIN sync failed",
            502,
            "simplefin_sync_failed",
            input.config.APP_ENV === "test"
              ? { cause: error instanceof Error ? error.message : String(error) }
              : undefined,
          );
    const finishedAt = new Date().toISOString();
    await input.db
      .update(syncRuns)
      .set({
        state: "failed",
        errorCode: appError.code,
        errorMessage: appError.message,
        finishedAt,
        ...counts,
      })
      .where(eq(syncRuns.id, runId));
    await input.db
      .update(connections)
      .set({
        status: appError.code === "simplefin_reauth_required" ? "reauth_required" : "degraded",
        lastErrorCode: appError.code,
        updatedAt: finishedAt,
      })
      .where(
        and(eq(connections.householdId, input.householdId), eq(connections.id, connection.id)),
      );
    throw appError;
  }
}
