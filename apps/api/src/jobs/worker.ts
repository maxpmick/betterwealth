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

function claimNext(db: BetterWealthDatabase, workerId: string, leaseDurationMs: number) {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();
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

type LeaseHeartbeat = {
  halt: () => void;
};

function startLeaseHeartbeat(input: {
  db: BetterWealthDatabase;
  job: typeof jobs.$inferSelect;
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  isWorkerStopped: () => boolean;
  logger: ReturnType<typeof createLogger>;
}): LeaseHeartbeat {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const halt = () => {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (!active || input.isWorkerStopped()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!active || input.isWorkerStopped()) return;

      const now = new Date().toISOString();
      try {
        const renewed = input.db
          .update(jobs)
          .set({
            leaseExpiresAt: new Date(Date.now() + input.leaseDurationMs).toISOString(),
            heartbeatAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(jobs.id, input.job.id),
              eq(jobs.state, "leased"),
              eq(jobs.leaseOwner, input.workerId),
              eq(jobs.leaseEpoch, input.job.leaseEpoch),
            ),
          )
          .returning({ id: jobs.id })
          .get();

        if (!renewed) {
          halt();
          input.logger.warn("job.lease_lost", {
            jobId: input.job.id,
            type: input.job.type,
            leaseEpoch: input.job.leaseEpoch,
          });
          return;
        }
      } catch {
        input.logger.warn("job.heartbeat_failed", {
          jobId: input.job.id,
          type: input.job.type,
          leaseEpoch: input.job.leaseEpoch,
        });
      }

      schedule();
    }, input.heartbeatIntervalMs);
  };

  schedule();
  return { halt };
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
  options: {
    intervalMs?: number;
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number;
    jobExecutor?: typeof executeJob;
  } = {},
) {
  const workerId = `api-${process.pid}-${randomUUID()}`;
  const logger = createLogger(config.LOG_LEVEL);
  const leaseDurationMs = Math.max(2, options.leaseDurationMs ?? 2 * 60_000);
  const heartbeatIntervalMs = Math.max(
    1,
    Math.min(options.heartbeatIntervalMs ?? 30_000, Math.floor(leaseDurationMs / 2)),
  );
  const jobExecutor = options.jobExecutor ?? executeJob;
  const activeHeartbeats = new Set<LeaseHeartbeat>();
  let stopped = false;
  let working = false;
  const tick = async () => {
    if (stopped || working) return;
    working = true;
    try {
      for (let processed = 0; processed < 10 && !stopped; processed += 1) {
        const job = claimNext(db, workerId, leaseDurationMs);
        if (!job) break;
        try {
          const heartbeat = startLeaseHeartbeat({
            db,
            job,
            workerId,
            leaseDurationMs,
            heartbeatIntervalMs,
            isWorkerStopped: () => stopped,
            logger,
          });
          activeHeartbeats.add(heartbeat);
          try {
            await jobExecutor(db, config, job);
          } finally {
            heartbeat.halt();
            activeHeartbeats.delete(heartbeat);
          }
          const now = new Date().toISOString();
          await db
            .update(jobs)
            .set({
              state: "succeeded",
              completedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              heartbeatAt: now,
              lastErrorCode: null,
              lastErrorMessage: null,
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
                eq(jobs.state, "leased"),
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
      for (const heartbeat of activeHeartbeats) heartbeat.halt();
      activeHeartbeats.clear();
    },
    tick,
  };
}
