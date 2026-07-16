import { afterEach, describe, expect, test } from "bun:test";
import { closeDatabase, connections, jobs, openDatabase, runMigrations } from "@betterwealth/db";
import { ALEX_IDS } from "@betterwealth/testkit";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config";
import { seedCanonicalAlex } from "../seed/canonical-alex";
import { syncActiveConnections } from "./scheduler";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

describe("scheduled account sync", () => {
  test("queues a durable idempotent job instead of performing provider I/O inline", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    await seedCanonicalAlex(db);
    await db
      .update(connections)
      .set({ status: "active" })
      .where(eq(connections.id, ALEX_IDS.connection));
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "a".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      SYNC_INTERVAL_MINUTES: "360",
    });

    expect(await syncActiveConnections(db, config)).toEqual({
      attempted: 1,
      queued: 1,
      skipped: 0,
    });
    expect(await syncActiveConnections(db, config)).toEqual({
      attempted: 1,
      queued: 0,
      skipped: 1,
    });

    const queued = await db.select().from(jobs).where(eq(jobs.type, "simplefin.sync"));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      householdId: ALEX_IDS.household,
      state: "queued",
      payload: { connectionId: ALEX_IDS.connection },
    });
  });
});
