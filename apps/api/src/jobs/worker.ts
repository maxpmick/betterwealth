import { randomUUID } from "node:crypto";
import type { BetterWealthDatabase } from "@betterwealth/db";
import { withImmediateTransaction } from "@betterwealth/db";
import { jobs } from "@betterwealth/db/schema";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { categorizeHouseholdTransactions } from "../categorization/service";
import type { AppConfig } from "../config";
import { AppError } from "../lib/errors";
import { createLogger } from "../lib/logger";
import { syncSimpleFinConnection } from "../sync/simplefin-sync";

const syncPayloadSchema = z
  .object({
    connectionId: z.string().min(1),
    trigger: z.enum(["manual", "scheduled", "initial", "retry"]).default("manual"),
  })
  .strict();

const categorizationPayloadSchema = z
  .object({
    userId: z.string().min(1),
    aiLimit: z.number().int().min(0).max(250).default(25),
    trigger: z.enum(["file_import", "manual", "sync"]).default("manual"),
  })
  .strict();

function claimNext(db: BetterWealthDatabase, workerId: string) {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
  return withImmediateTransaction(db, (transaction) => {
    const candidate = transaction
      .select()
      .from(jobs)
      .where(
        and(
          lte(jobs.scheduledAt, now),
          sql`${jobs.attempts} < ${jobs.maxAttempts}`,
          or(
            eq(jobs.state, "queued"),
            and(eq(jobs.state, "leased"), lte(jobs.leaseExpiresAt, now)),
          ),
        ),
      )
      .orderBy(jobs.scheduledAt, jobs.createdAt)
      .limit(1)
      .get();
    if (!candidate) return undefined;
    return transaction
      .update(jobs)
      .set({
        state: "leased",
        leaseOwner: workerId,
        leaseExpiresAt,
        heartbeatAt: now,
        leaseEpoch: sql`${jobs.leaseEpoch} + 1`,
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: now,
      })
      .where(and(eq(jobs.id, candidate.id), eq(jobs.leaseEpoch, candidate.leaseEpoch)))
      .returning()
      .get();
  });
}

async function executeJob(
  db: BetterWealthDatabase,
  config: AppConfig,
  job: typeof jobs.$inferSelect,
) {
  switch (job.type) {
    case "simplefin.sync": {
      const payload = syncPayloadSchema.parse(job.payload);
      await syncSimpleFinConnection({
        db,
        config,
        householdId: job.householdId,
        connectionId: payload.connectionId,
        trigger: payload.trigger,
        jobId: job.id,
      });
      return;
    }
    case "categorization.run": {
      const payload = categorizationPayloadSchema.parse(job.payload);
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: job.householdId,
        userId: payload.userId,
        aiLimit: payload.aiLimit,
      });
      return;
    }
    default:
      throw new AppError("Unsupported background job", 500, "unsupported_job_type");
  }
}

export function startJobWorker(
  db: BetterWealthDatabase,
  config: AppConfig,
  options: { intervalMs?: number } = {},
) {
  const workerId = `api-${process.pid}-${randomUUID()}`;
  const logger = createLogger(config.LOG_LEVEL);
  let stopped = false;
  let working = false;
  const tick = async () => {
    if (stopped || working) return;
    working = true;
    try {
      for (let processed = 0; processed < 10 && !stopped; processed += 1) {
        const job = claimNext(db, workerId);
        if (!job) break;
        try {
          await executeJob(db, config, job);
          const now = new Date().toISOString();
          await db
            .update(jobs)
            .set({
              state: "succeeded",
              completedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(jobs.id, job.id),
                eq(jobs.state, "leased"),
                eq(jobs.leaseOwner, workerId),
                eq(jobs.leaseEpoch, job.leaseEpoch),
              ),
            );
        } catch (error) {
          const terminal = job.attempts >= job.maxAttempts;
          const retryDelayMinutes = Math.min(60, 2 ** Math.max(0, job.attempts - 1));
          const code = error instanceof AppError ? error.code : "job_failed";
          const message = error instanceof AppError ? error.message : "Background job failed";
          await db
            .update(jobs)
            .set({
              state: terminal ? "failed" : "queued",
              scheduledAt: new Date(Date.now() + retryDelayMinutes * 60_000).toISOString(),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: code,
              lastErrorMessage: message.slice(0, 500),
              completedAt: terminal ? new Date().toISOString() : null,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(jobs.id, job.id),
                eq(jobs.leaseOwner, workerId),
                eq(jobs.leaseEpoch, job.leaseEpoch),
              ),
            );
          logger.warn("job.failed", {
            jobId: job.id,
            type: job.type,
            attempt: job.attempts,
            terminal,
            code,
          });
        }
      }
    } finally {
      working = false;
    }
  };
  const interval = setInterval(() => void tick(), options.intervalMs ?? 2_000);
  void tick();
  return {
    workerId,
    stop() {
      stopped = true;
      clearInterval(interval);
    },
    tick,
  };
}
