import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BetterWealthDatabase,
  closeDatabase,
  openDatabase,
  runMigrations,
} from "@betterwealth/db";
import { sessions } from "@betterwealth/db/schema";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config";
import { UnauthorizedError } from "../lib/errors";
import {
  createSession,
  registerUser,
  resolveSession,
  revokeSession,
  touchSession,
} from "./service";

const config = loadConfig({
  APP_ENV: "test",
  DATABASE_URL: ":memory:",
  ENCRYPTION_KEY: "c".repeat(64),
  SESSION_IDLE_DAYS: "1",
  SESSION_ABSOLUTE_DAYS: "30",
  LOG_LEVEL: "error",
});

let db: BetterWealthDatabase;

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db);
});

afterEach(() => {
  closeDatabase(db);
});

async function registerAndCreateSession(email: string) {
  const identity = await registerUser(
    db,
    { email, password: "SessionTest!2026", householdName: `${email} plan` },
    config,
  );
  const session = await createSession(db, identity.userId, config);
  return { ...identity, session };
}

async function expectUnauthorized(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UnauthorizedError);
    expect((error as UnauthorizedError).status).toBe(401);
    expect((error as UnauthorizedError).code).toBe("unauthorized");
    return;
  }
  throw new Error("Expected the session to be rejected");
}

async function sessionRow(id: string) {
  const row = await db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) throw new Error(`Expected session ${id} to exist`);
  return row;
}

describe("session lifecycle", () => {
  test("resolves a fresh session with its household membership", async () => {
    const { userId, householdId, session } = await registerAndCreateSession("fresh@example.com");

    const auth = await resolveSession(db, session.token);

    expect(auth).toMatchObject({
      user: { id: userId, email: "fresh@example.com" },
      householdId,
      role: "owner",
      sessionId: session.id,
      absoluteExpiresAt: session.absoluteExpiresAt,
    });
  });

  test("does not resolve a session whose idle expiry has passed", async () => {
    const { session } = await registerAndCreateSession("idle-expired@example.com");
    await db
      .update(sessions)
      .set({ idleExpiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(sessions.id, session.id));

    await expectUnauthorized(resolveSession(db, session.token));
  });

  test("does not resolve a session whose absolute expiry passed even when the idle expiry is fresh", async () => {
    const { session } = await registerAndCreateSession("absolute-expired@example.com");
    // The sessions_expiry_order_ck CHECK constraint (idle <= absolute) makes this state
    // unreachable through normal writes, so suspend enforcement to exercise the
    // defense-in-depth absolute-expiry filter in resolveSession directly.
    db.$client.exec("PRAGMA ignore_check_constraints = ON");
    await db
      .update(sessions)
      .set({
        idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        absoluteExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      })
      .where(eq(sessions.id, session.id));
    db.$client.exec("PRAGMA ignore_check_constraints = OFF");

    await expectUnauthorized(resolveSession(db, session.token));
  });

  test("touchSession rolls the idle expiry forward and stamps lastSeenAt", async () => {
    const { session } = await registerAndCreateSession("touch-idle@example.com");
    const staleIdle = new Date(Date.now() + 60_000).toISOString();
    await db
      .update(sessions)
      .set({
        idleExpiresAt: staleIdle,
        lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
      })
      .where(eq(sessions.id, session.id));
    const auth = await resolveSession(db, session.token);
    const beforeTouch = Date.now();

    await touchSession(db, auth, config);

    const row = await sessionRow(session.id);
    const touchedIdle = new Date(row.idleExpiresAt).getTime();
    expect(touchedIdle).toBeGreaterThan(new Date(staleIdle).getTime());
    expect(Math.abs(touchedIdle - (beforeTouch + config.sessionIdleMs))).toBeLessThan(10_000);
    expect(new Date(row.lastSeenAt).getTime()).toBeGreaterThanOrEqual(beforeTouch - 1_000);
  });

  test("touchSession never extends the idle expiry beyond the absolute expiry", async () => {
    const { session } = await registerAndCreateSession("touch-clamp@example.com");
    const absolute = new Date(Date.now() + 3_600_000).toISOString();
    await db
      .update(sessions)
      .set({
        absoluteExpiresAt: absolute,
        idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(sessions.id, session.id));
    const auth = await resolveSession(db, session.token);
    expect(auth.absoluteExpiresAt).toBe(absolute);

    await touchSession(db, auth, config);

    // sessionIdleMs (1 day) overshoots the 1-hour absolute expiry, so the clamp must win.
    const row = await sessionRow(session.id);
    expect(new Date(row.idleExpiresAt).toISOString()).toBe(absolute);
  });

  test("logout revokes the session so it no longer resolves", async () => {
    const { session } = await registerAndCreateSession("logout@example.com");
    await resolveSession(db, session.token);

    await revokeSession(db, session.token);

    await expectUnauthorized(resolveSession(db, session.token));
    expect((await sessionRow(session.id)).revokedAt).not.toBeNull();
  });

  test("revokeSession ignores a missing token", async () => {
    await expect(revokeSession(db, undefined)).resolves.toBeUndefined();
  });
});
