import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BetterWealthDatabase,
  createStandaloneSqliteSnapshot,
  removeSqliteFileSet,
} from "@betterwealth/db";
import {
  accounts,
  assets,
  assetValuations,
  auditEvents,
  balanceSnapshots,
  budgetPeriods,
  categories,
  connections,
  envelopeAllocations,
  envelopes,
  forecastScenarios,
  goalContributions,
  goals,
  householdMembers,
  households,
  rules,
  sessions,
  settings,
  transactions,
  users,
} from "@betterwealth/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../auth/middleware";
import { requireRole } from "../auth/service";
import type { AppConfig } from "../config";
import { sha256 } from "../lib/crypto";
import { ForbiddenError, NotFoundError } from "../lib/errors";
import type { AppEnv } from "../types";

function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry)),
  ) as T;
}

const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    targetAge: z.number().int().min(18).max(120).nullable().optional(),
    householdName: z.string().trim().min(1).max(80).optional(),
    baseCurrency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export function createOperationRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireAuth(db, config));

  routes.get("/profile", async (context) => {
    const auth = context.get("auth");
    const [user, household] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          birthDate: users.birthDate,
          targetAge: users.targetAge,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.id, auth.user.id))
        .get(),
      db
        .select({
          id: households.id,
          name: households.name,
          baseCurrency: households.baseCurrency,
          locale: households.locale,
          timezone: households.timezone,
        })
        .from(households)
        .where(eq(households.id, auth.householdId))
        .get(),
    ]);
    if (!user || !household) throw new NotFoundError("Profile");
    return context.json({ user, household, role: auth.role });
  });

  routes.patch("/profile", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = profilePatchSchema.parse(await context.req.json());
    db.transaction((transaction) => {
      if (
        input.displayName !== undefined ||
        input.birthDate !== undefined ||
        input.targetAge !== undefined
      ) {
        transaction
          .update(users)
          .set({
            displayName: input.displayName,
            birthDate: input.birthDate,
            targetAge: input.targetAge,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(users.id, auth.user.id))
          .run();
      }
      if (
        input.householdName !== undefined ||
        input.baseCurrency !== undefined ||
        input.timezone !== undefined
      ) {
        requireRole(auth, ["owner", "admin"]);
        transaction
          .update(households)
          .set({
            name: input.householdName,
            baseCurrency: input.baseCurrency,
            timezone: input.timezone,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(households.id, auth.householdId))
          .run();
      }
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "profile.updated",
          entityType: "user",
          entityId: auth.user.id,
          requestId: context.get("requestId"),
          metadata: { fields: Object.keys(input) },
        })
        .run();
    });
    return context.json({ updated: true });
  });

  routes.post("/profile/password", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        currentPassword: z.string().min(1).max(128),
        newPassword: z.string().min(12).max(128),
      })
      .strict()
      .parse(await context.req.json());
    const user = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, auth.user.id))
      .get();
    if (!user || !(await Bun.password.verify(input.currentPassword, user.passwordHash))) {
      throw new ForbiddenError("Current password is incorrect");
    }
    const passwordHash = await Bun.password.hash(input.newPassword, {
      algorithm: "argon2id",
      memoryCost: config.APP_ENV === "test" ? 1_024 : 65_536,
      timeCost: config.APP_ENV === "test" ? 1 : 3,
    });
    db.transaction((transaction) => {
      transaction
        .update(users)
        .set({ passwordHash, updatedAt: new Date().toISOString() })
        .where(eq(users.id, auth.user.id))
        .run();
      transaction
        .update(sessions)
        .set({ revokedAt: new Date().toISOString() })
        .where(and(eq(sessions.userId, auth.user.id), ne(sessions.id, auth.sessionId)))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          id: ulid(),
          householdId: auth.householdId,
          actorUserId: auth.user.id,
          actorType: "user",
          action: "password.changed",
          entityType: "user",
          entityId: auth.user.id,
          requestId: context.get("requestId"),
          metadata: {},
        })
        .run();
    });
    return context.json({ changed: true });
  });

  routes.get("/household/members", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: householdMembers.role,
        status: householdMembers.status,
        joinedAt: householdMembers.joinedAt,
      })
      .from(householdMembers)
      .innerJoin(users, eq(users.id, householdMembers.userId))
      .where(eq(householdMembers.householdId, auth.householdId));
    return context.json({ data: rows, page: { cursor: null, hasMore: false } });
  });

  routes.get("/audit-events", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.householdId, auth.householdId))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(250);
    return context.json({ data: rows, page: { cursor: null, hasMore: false } });
  });

  routes.get("/data-export", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const householdId = auth.householdId;
    const [
      household,
      memberRows,
      connectionRows,
      accountRows,
      balanceRows,
      categoryRows,
      transactionRows,
      periodRows,
      envelopeRows,
      allocationRows,
      goalRows,
      contributionRows,
      ruleRows,
      assetRows,
      valuationRows,
      scenarioRows,
      preferenceRows,
    ] = await Promise.all([
      db.select().from(households).where(eq(households.id, householdId)).get(),
      db
        .select({
          userId: users.id,
          email: users.email,
          name: users.displayName,
          role: householdMembers.role,
        })
        .from(householdMembers)
        .innerJoin(users, eq(users.id, householdMembers.userId))
        .where(eq(householdMembers.householdId, householdId)),
      db
        .select({
          id: connections.id,
          provider: connections.provider,
          displayName: connections.displayName,
          status: connections.status,
          capabilities: connections.capabilities,
          lastSuccessAt: connections.lastSuccessAt,
          createdAt: connections.createdAt,
        })
        .from(connections)
        .where(eq(connections.householdId, householdId)),
      db.select().from(accounts).where(eq(accounts.householdId, householdId)),
      db.select().from(balanceSnapshots).where(eq(balanceSnapshots.householdId, householdId)),
      db.select().from(categories).where(eq(categories.householdId, householdId)),
      db.select().from(transactions).where(eq(transactions.householdId, householdId)),
      db.select().from(budgetPeriods).where(eq(budgetPeriods.householdId, householdId)),
      db.select().from(envelopes).where(eq(envelopes.householdId, householdId)),
      db.select().from(envelopeAllocations).where(eq(envelopeAllocations.householdId, householdId)),
      db.select().from(goals).where(eq(goals.householdId, householdId)),
      db.select().from(goalContributions).where(eq(goalContributions.householdId, householdId)),
      db.select().from(rules).where(eq(rules.householdId, householdId)),
      db.select().from(assets).where(eq(assets.householdId, householdId)),
      db.select().from(assetValuations).where(eq(assetValuations.householdId, householdId)),
      db.select().from(forecastScenarios).where(eq(forecastScenarios.householdId, householdId)),
      db
        .select({ key: settings.key, value: settings.value, scopeKey: settings.scopeKey })
        .from(settings)
        .where(and(eq(settings.householdId, householdId), eq(settings.isSecret, false))),
    ]);
    const exportedAt = new Date().toISOString();
    const unsignedPayload = jsonSafe({
      format: "betterwealth-export-v1",
      exportedAt,
      household,
      members: memberRows,
      connections: connectionRows,
      accounts: accountRows,
      balanceSnapshots: balanceRows,
      categories: categoryRows,
      transactions: transactionRows,
      budgetPeriods: periodRows,
      envelopes: envelopeRows,
      envelopeAllocations: allocationRows,
      goals: goalRows,
      goalContributions: contributionRows,
      rules: ruleRows,
      assets: assetRows,
      assetValuations: valuationRows,
      forecastScenarios: scenarioRows,
      settings: preferenceRows,
    });
    const payload = {
      ...unsignedPayload,
      integrity: {
        algorithm: "sha256",
        canonicalization: "JSON.stringify(payload without integrity)",
        digest: sha256(JSON.stringify(unsignedPayload)),
      },
    };
    const finalBody = JSON.stringify(payload, null, 2);
    return new Response(finalBody, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="betterwealth-${exportedAt.slice(0, 10)}.json"`,
        "x-content-type-options": "nosniff",
      },
    });
  });

  routes.get("/database-backup", (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner"]);
    const temporaryParent = config.dataDirectory === ":memory:" ? tmpdir() : config.dataDirectory;
    const temporaryDirectory = mkdtempSync(join(temporaryParent, ".betterwealth-download-"));
    const snapshotPath = join(temporaryDirectory, "snapshot.sqlite");
    chmodSync(temporaryDirectory, 0o700);
    try {
      createStandaloneSqliteSnapshot(db.$client, snapshotPath);
      const bytes = readFileSync(snapshotPath);
      const date = new Date().toISOString().replace(/[:.]/g, "-");
      return new Response(Uint8Array.from(bytes).buffer, {
        headers: {
          "content-type": "application/vnd.sqlite3",
          "content-disposition": `attachment; filename="betterwealth-${date}.sqlite"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } finally {
      removeSqliteFileSet(snapshotPath);
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  return routes;
}
