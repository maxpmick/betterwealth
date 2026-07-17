import { afterEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  connections,
  createHouseholdRepositories,
  jobs,
  openDatabase,
  runMigrations,
} from "@betterwealth/db";
import { ALEX_IDS } from "@betterwealth/testkit";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { loadConfig } from "../config";
import { FieldCipher } from "../lib/crypto";
import { seedCanonicalAlex } from "../seed/canonical-alex";
import { syncActiveConnections } from "./scheduler";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

describe("scheduled account sync", () => {
  test("queues active and degraded connections but excludes disabled and reauth-required ones", async () => {
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
    const repositories = createHouseholdRepositories(db, ALEX_IDS.household);
    const cipher = new FieldCipher(config.ENCRYPTION_KEY);
    const degradedConnectionId = ulid();
    const excludedConnections = [
      { id: ulid(), status: "reauth_required" as const },
      { id: ulid(), status: "disabled" as const },
    ];
    for (const connection of [
      { id: degradedConnectionId, status: "degraded" as const },
      ...excludedConnections,
    ]) {
      const aad = `connection:${connection.id}:credentials`;
      repositories.connections.create({
        id: connection.id,
        ownerUserId: ALEX_IDS.user,
        provider: "simplefin",
        displayName: `SimpleFIN ${connection.status}`,
        encryptedCredentials: cipher.encrypt(
          `https://user:password@bridge.example.test/${connection.id}`,
          aad,
        ),
        credentialsAad: aad,
        capabilities: ["accounts", "balances", "transactions"],
        status: connection.status,
      });
    }

    expect(await syncActiveConnections(db, config)).toEqual({
      attempted: 2,
      queued: 2,
      skipped: 0,
    });
    expect(await syncActiveConnections(db, config)).toEqual({
      attempted: 2,
      queued: 0,
      skipped: 2,
    });

    const queued = await db.select().from(jobs).where(eq(jobs.type, "simplefin.sync"));
    expect(queued).toHaveLength(2);
    expect(queued.every((job) => job.householdId === ALEX_IDS.household)).toBeTrue();
    expect(queued.every((job) => job.state === "queued")).toBeTrue();
    expect(
      new Set(queued.map((job) => (job.payload as { connectionId: string }).connectionId)),
    ).toEqual(new Set([ALEX_IDS.connection, degradedConnectionId]));
  });
});
