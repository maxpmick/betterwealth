import { type BetterWealthDatabase, splitEncryptedPayload } from "@betterwealth/db";
import { importRuns, jobs, rawImportRecords, transactions } from "@betterwealth/db/schema";
import { parseDecimalToMinorUnits } from "@betterwealth/shared";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCsrf } from "../../auth/middleware";
import { categorizeHouseholdTransactions } from "../../categorization/service";
import type { AppConfig } from "../../config";
import { parseTransactionFile } from "../../imports/parsers";
import { FieldCipher, sha256 } from "../../lib/crypto";
import { AppError, ConflictError } from "../../lib/errors";
import { listPageParams, paginateList } from "../../lib/pagination";
import { normalizeDescription, transactionFingerprint } from "../../sync/reconcile";
import type { AppEnv } from "../../types";
import { currencySchema, nowIso, requireAccount } from "./shared";

const importTransactionsSchema = z
  .object({
    accountId: z.string(),
    filename: z.string().trim().min(1).max(255),
    content: z
      .string()
      .min(1)
      .max(10 * 1024 * 1024),
    currency: currencySchema.optional(),
  })
  .strict();

export function createImportRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();

  // Local CSV / OFX / QFX imports -----------------------------------------

  routes.get("/imports", async (context) => {
    const auth = context.get("auth");
    const { limit, cursor } = listPageParams(context.req, 100);
    const conditions = [eq(importRuns.householdId, auth.householdId)];
    if (cursor) {
      const cursorCondition = or(
        lt(importRuns.createdAt, cursor.sortKey),
        and(eq(importRuns.createdAt, cursor.sortKey), lt(importRuns.id, cursor.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
    const fetched = await db
      .select({
        id: importRuns.id,
        format: importRuns.format,
        originalFilename: importRuns.originalFilename,
        state: importRuns.state,
        totalRecords: importRuns.totalRecords,
        importedRecords: importRuns.importedRecords,
        duplicateRecords: importRuns.duplicateRecords,
        rejectedRecords: importRuns.rejectedRecords,
        committedAt: importRuns.committedAt,
        createdAt: importRuns.createdAt,
      })
      .from(importRuns)
      .where(and(...conditions))
      .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
      .limit(limit + 1);
    const { rows, page } = paginateList(fetched, limit, (row) => ({
      sortKey: row.createdAt,
      id: row.id,
    }));
    return context.json({ data: rows, page });
  });

  routes.post("/imports/transactions", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = importTransactionsSchema.parse(await context.req.json());
    const account = await requireAccount(db, auth.householdId, input.accountId);
    const currency = input.currency ?? account.currency;
    const parsed = parseTransactionFile(input.filename, input.content);
    if (parsed.length > 100_000) {
      throw new AppError("Import contains too many transactions", 413, "import_too_large");
    }
    const fileHash = sha256(input.content);
    const existingRun = await db
      .select({ id: importRuns.id, state: importRuns.state })
      .from(importRuns)
      .where(and(eq(importRuns.householdId, auth.householdId), eq(importRuns.fileHash, fileHash)))
      .get();
    if (existingRun) {
      throw new ConflictError(
        `This file was already imported as ${existingRun.id}`,
        "duplicate_import_file",
      );
    }
    const existingTransactions = await db
      .select({ externalId: transactions.externalId, fingerprint: transactions.fingerprint })
      .from(transactions)
      .where(
        and(eq(transactions.householdId, auth.householdId), eq(transactions.accountId, account.id)),
      );
    const externalIds = new Set(
      existingTransactions
        .map((transaction) => transaction.externalId)
        .filter((value): value is string => Boolean(value)),
    );
    const fingerprints = new Set(
      existingTransactions
        .map((transaction) => transaction.fingerprint)
        .filter((value): value is string => Boolean(value)),
    );
    const extension = input.filename.toLowerCase().split(".").at(-1);
    const format = extension === "csv" ? "csv" : extension === "qfx" ? "qfx" : "ofx";
    const runId = ulid();
    const cipher = new FieldCipher(config.ENCRYPTION_KEY);
    let imported = 0;
    let duplicates = 0;
    db.transaction((transaction) => {
      transaction
        .insert(importRuns)
        .values({
          id: runId,
          householdId: auth.householdId,
          createdByUserId: auth.user.id,
          format,
          fileHash,
          originalFilename: input.filename,
          state: "running",
          totalRecords: parsed.length,
        })
        .run();
      for (const [index, record] of parsed.entries()) {
        const amount = parseDecimalToMinorUnits(record.amount, 2, "reject");
        const fingerprint = transactionFingerprint({
          accountId: account.id,
          ...(record.externalId ? { externalId: record.externalId } : {}),
          amountMinor: amount.toString(),
          description: record.description,
          occurredAt: record.postedAt,
        });
        const recordHash = sha256(
          `${record.externalId ?? ""}\u001f${fingerprint}\u001f${record.postedAt}`,
        );
        const duplicate =
          (record.externalId ? externalIds.has(record.externalId) : false) ||
          fingerprints.has(fingerprint);
        const rawRecordId = ulid();
        const payloadAad = `raw-import:${auth.householdId}:${runId}:${rawRecordId}`;
        const encryptedPayload = splitEncryptedPayload(
          cipher.encrypt(
            JSON.stringify({
              postedAt: record.postedAt,
              amount: record.amount,
              description: record.description,
              ...(record.memo ? { memo: record.memo } : {}),
            }),
            payloadAad,
          ),
        );
        transaction
          .insert(rawImportRecords)
          .values({
            id: rawRecordId,
            householdId: auth.householdId,
            importRunId: runId,
            rowNumber: index + 1,
            ...(record.externalId ? { externalId: record.externalId } : {}),
            payloadCiphertext: encryptedPayload.ciphertext,
            payloadNonce: encryptedPayload.nonce,
            payloadAuthTag: encryptedPayload.authTag,
            payloadKeyVersion: encryptedPayload.keyId,
            payloadAad,
            recordHash,
            status: duplicate ? "duplicate" : "accepted",
          })
          .run();
        if (duplicate) {
          duplicates += 1;
          continue;
        }
        const transactionId = ulid();
        transaction
          .insert(transactions)
          .values({
            id: transactionId,
            householdId: auth.householdId,
            accountId: account.id,
            importRunId: runId,
            ...(record.externalId ? { externalId: record.externalId } : {}),
            amount,
            currency,
            postedAt: record.postedAt,
            transactedOn: record.postedAt,
            rawDescription: record.description,
            normalizedDescription: normalizeDescription(record.description),
            status: record.pending ? "pending" : "posted",
            source: "import",
            reviewState: "needs_review",
            ...(record.memo ? { note: record.memo } : {}),
            fingerprint,
          })
          .run();
        imported += 1;
        if (record.externalId) externalIds.add(record.externalId);
        fingerprints.add(fingerprint);
      }
      transaction
        .update(importRuns)
        .set({
          state: "succeeded",
          importedRecords: imported,
          duplicateRecords: duplicates,
          committedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(and(eq(importRuns.householdId, auth.householdId), eq(importRuns.id, runId)))
        .run();
    });
    const deterministicCategorization = await categorizeHouseholdTransactions({
      db,
      config,
      householdId: auth.householdId,
      userId: auth.user.id,
      aiLimit: 0,
    });
    const needsAi =
      deterministicCategorization.candidates > deterministicCategorization.deterministic;
    const categorizationJobId = needsAi ? ulid() : undefined;
    if (categorizationJobId) {
      await db.insert(jobs).values({
        id: categorizationJobId,
        householdId: auth.householdId,
        type: "categorization.run",
        payload: { userId: auth.user.id, aiLimit: 25, trigger: "file_import" },
        state: "queued",
        scheduledAt: nowIso(),
        idempotencyKey: `categorization:import:${runId}`,
      });
    }
    return context.json(
      {
        id: runId,
        state: "succeeded" as const,
        totalRecords: parsed.length,
        importedRecords: imported,
        duplicateRecords: duplicates,
        rejectedRecords: 0,
        categorization: {
          ...deterministicCategorization,
          state: needsAi ? ("queued" as const) : ("succeeded" as const),
          ...(categorizationJobId ? { jobId: categorizationJobId } : {}),
        },
      },
      201,
    );
  });

  return routes;
}
