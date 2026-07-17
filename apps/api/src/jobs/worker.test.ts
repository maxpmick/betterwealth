import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BetterWealthDatabase,
  closeDatabase,
  jobs,
  openDatabase,
  runMigrations,
} from "@betterwealth/db";
import { ALEX_IDS } from "@betterwealth/testkit";
import { eq } from "drizzle-orm";
import { type AppConfig, loadConfig } from "../config";
import { seedCanonicalAlex } from "../seed/canonical-alex";
import { startJobWorker } from "./worker";

describe("durable job worker", () => {
  let directory: string;
  let db: BetterWealthDatabase;
  let config: AppConfig;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-worker-"));
    db = openDatabase(join(directory, "worker.sqlite"));
    runMigrations(db);
    await seedCanonicalAlex(db);
    config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: join(directory, "worker.sqlite"),
      ENCRYPTION_KEY: "c".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      LOG_LEVEL: "error",
    });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  });

  test("leases a due job once and records a safe terminal failure", async () => {
    await db.insert(jobs).values({
      id: "unsupported-job",
      householdId: ALEX_IDS.household,
      type: "unsupported.test",
      payload: { secret: "must-not-appear" },
      state: "queued",
      maxAttempts: 1,
      scheduledAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const worker = startJobWorker(db, config, { intervalMs: 60_000 });
    try {
      let row = await db.select().from(jobs).where(eq(jobs.id, "unsupported-job")).get();
      for (let attempt = 0; attempt < 40 && row?.state !== "failed"; attempt += 1) {
        await Bun.sleep(5);
        row = await db.select().from(jobs).where(eq(jobs.id, "unsupported-job")).get();
      }
      expect(row).toMatchObject({
        state: "failed",
        attempts: 1,
        maxAttempts: 1,
        lastErrorCode: "unsupported_job_type",
        lastErrorMessage: "Unsupported background job",
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(row?.completedAt).toBeTruthy();
      expect(`${row?.lastErrorCode} ${row?.lastErrorMessage}`).not.toContain("must-not-appear");

      await worker.tick();
      const unchanged = await db.select().from(jobs).where(eq(jobs.id, "unsupported-job")).get();
      expect(unchanged?.attempts).toBe(1);
    } finally {
      worker.stop();
    }
  });

  test("renews the fenced lease while a long-running job is active and stops after completion", async () => {
    await db.insert(jobs).values({
      id: "long-running-job",
      householdId: ALEX_IDS.household,
      type: "unsupported.test",
      payload: {},
      state: "queued",
      maxAttempts: 1,
      scheduledAt: new Date(Date.now() - 1_000).toISOString(),
      lastErrorCode: "transient_failure",
      lastErrorMessage: "A previous attempt failed",
    });

    let releaseJob: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    let markStarted: (() => void) | undefined;
    const jobStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const worker = startJobWorker(db, config, {
      intervalMs: 60_000,
      leaseDurationMs: 80,
      heartbeatIntervalMs: 10,
      jobExecutor: async () => {
        markStarted?.();
        await executionStarted;
      },
    });

    try {
      await jobStarted;
      const initiallyLeased = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, "long-running-job"))
        .get();
      expect(initiallyLeased?.state).toBe("leased");
      expect(initiallyLeased?.leaseOwner).toBe(worker.workerId);

      await Bun.sleep(110);
      const renewed = await db.select().from(jobs).where(eq(jobs.id, "long-running-job")).get();
      expect(renewed?.state).toBe("leased");
      expect(renewed?.leaseEpoch).toBe(initiallyLeased?.leaseEpoch);
      expect(Date.parse(renewed?.heartbeatAt ?? "")).toBeGreaterThan(
        Date.parse(initiallyLeased?.heartbeatAt ?? ""),
      );
      expect(Date.parse(renewed?.leaseExpiresAt ?? "")).toBeGreaterThan(
        Date.parse(initiallyLeased?.leaseExpiresAt ?? ""),
      );
      expect(Date.parse(renewed?.leaseExpiresAt ?? "")).toBeGreaterThan(Date.now());

      releaseJob?.();
      let completed = renewed;
      for (let attempt = 0; attempt < 40 && completed?.state !== "succeeded"; attempt += 1) {
        await Bun.sleep(5);
        completed = await db.select().from(jobs).where(eq(jobs.id, "long-running-job")).get();
      }
      expect(completed).toMatchObject({
        state: "succeeded",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      const completedHeartbeat = completed?.heartbeatAt;
      await Bun.sleep(40);
      const unchanged = await db.select().from(jobs).where(eq(jobs.id, "long-running-job")).get();
      expect(unchanged?.heartbeatAt).toBe(completedHeartbeat);
    } finally {
      worker.stop();
      releaseJob?.();
    }
  });

  test("stop cancels an active job heartbeat without leaking its timer", async () => {
    await db.insert(jobs).values({
      id: "stopped-long-running-job",
      householdId: ALEX_IDS.household,
      type: "unsupported.test",
      payload: {},
      state: "queued",
      maxAttempts: 1,
      scheduledAt: new Date(Date.now() - 1_000).toISOString(),
    });

    let releaseJob: (() => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    let markStarted: (() => void) | undefined;
    const jobStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const worker = startJobWorker(db, config, {
      intervalMs: 60_000,
      leaseDurationMs: 100,
      heartbeatIntervalMs: 10,
      jobExecutor: async () => {
        markStarted?.();
        await executionStarted;
      },
    });

    try {
      await jobStarted;
      await Bun.sleep(25);
      worker.stop();
      const stoppedHeartbeat = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, "stopped-long-running-job"))
        .get();
      expect(stoppedHeartbeat?.state).toBe("leased");

      await Bun.sleep(45);
      const unchanged = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, "stopped-long-running-job"))
        .get();
      expect(unchanged?.heartbeatAt).toBe(stoppedHeartbeat?.heartbeatAt);
      expect(unchanged?.leaseExpiresAt).toBe(stoppedHeartbeat?.leaseExpiresAt);

      releaseJob?.();
      let completed = unchanged;
      for (let attempt = 0; attempt < 40 && completed?.state !== "succeeded"; attempt += 1) {
        await Bun.sleep(5);
        completed = await db
          .select()
          .from(jobs)
          .where(eq(jobs.id, "stopped-long-running-job"))
          .get();
      }
      expect(completed?.state).toBe("succeeded");
    } finally {
      worker.stop();
      releaseJob?.();
    }
  });
});
