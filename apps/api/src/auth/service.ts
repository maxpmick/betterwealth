import type { BetterWealthDatabase } from "@betterwealth/db";
import { categories, householdMembers, households, sessions, users } from "@betterwealth/db/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import type { AppConfig } from "../config";
import { randomToken, sha256 } from "../lib/crypto";
import { ConflictError, ForbiddenError, UnauthorizedError } from "../lib/errors";

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  householdName: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

export type HouseholdRole = "owner" | "admin" | "member" | "viewer";

export type AuthContext = {
  user: { id: string; email: string; name: string };
  householdId: string;
  role: HouseholdRole;
  sessionId: string;
  csrfTokenHash: string;
  absoluteExpiresAt: string;
};

const DEFAULT_CATEGORIES = [
  ["income", "Income", "income", "#1F9D72", "payments", null],
  ["housing", "Housing", "expense", "#4A7FD1", "home", null],
  ["food", "Food", "expense", "#D98B2B", "restaurant", null],
  ["transportation", "Transportation", "expense", "#7B61B3", "directions_car", null],
  ["utilities", "Utilities", "expense", "#4E8597", "bolt", null],
  ["health", "Health", "expense", "#DD625B", "favorite", null],
  ["personal", "Personal", "expense", "#A66B8D", "person", null],
  ["fun", "Fun & entertainment", "expense", "#8C6A43", "celebration", null],
  ["debt", "Debt payments", "debt", "#C46A4A", "credit_score", null],
  ["investing", "Investing", "investment", "#287E69", "trending_up", null],
  ["transfers", "Transfers", "transfer", "#6B7280", "swap_horiz", null],
  ["uncategorized", "Uncategorized", "expense", "#8A9099", "help_outline", null],
] as const;

// Known dummy values make an unknown email perform the same Argon2 work as a real login. The
// plaintext is intentionally not a credential; these hashes only close the account-enumeration
// timing side channel.
const DUMMY_PASSWORD_HASH_TEST =
  "$argon2id$v=19$m=1024,t=1,p=1$yC+7eMg5yq9SqS8zh3GUpigxNqCAMl/ZJ2wtnT3s3D4$niqerDD+I/0NcItvfrdp65cxnK01FyayKSFMn28gcWk";
const DUMMY_PASSWORD_HASH_PRODUCTION =
  "$argon2id$v=19$m=65536,t=3,p=1$yiWby4uSUyXVXdWdz86s6CZwChcec46zIWAGdV9kiAc$KeGDcNHvL5Y0lQ0YGbFujAr7EufkqBWaj6vHHKKasLI";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "BetterWealth user";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export async function registerUser(
  db: BetterWealthDatabase,
  inputValue: unknown,
  config: AppConfig,
): Promise<{ userId: string; householdId: string }> {
  if (config.REGISTRATION_MODE !== "open") {
    throw new ForbiddenError("Public registration is not enabled");
  }
  const input = registerSchema.parse(inputValue);
  const normalizedEmail = normalizeEmail(input.email);
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.normalizedEmail, normalizedEmail))
    .get();
  if (existing)
    throw new ConflictError("An account with that email already exists", "email_exists");

  const userId = ulid();
  const householdId = ulid();
  const passwordHash = await Bun.password.hash(input.password, {
    algorithm: "argon2id",
    memoryCost: config.APP_ENV === "test" ? 1_024 : 65_536,
    timeCost: config.APP_ENV === "test" ? 1 : 3,
  });
  const displayName = input.displayName ?? displayNameFromEmail(normalizedEmail);

  await db.transaction(async (transaction) => {
    await transaction.insert(users).values({
      id: userId,
      email: input.email.trim(),
      normalizedEmail,
      passwordHash,
      displayName,
    });
    await transaction.insert(households).values({
      id: householdId,
      name: input.householdName,
      baseCurrency: "USD",
      locale: "en-US",
      timezone: "America/New_York",
      registrationPolicy: "open",
    });
    await transaction.insert(householdMembers).values({
      householdId,
      userId,
      role: "owner",
      status: "active",
    });
    await transaction.insert(categories).values(
      DEFAULT_CATEGORIES.map(([slug, name, kind, color, icon], sortOrder) => ({
        id: ulid(),
        householdId,
        slug,
        name,
        kind,
        color,
        icon,
        isSystem: true,
        sortOrder,
      })),
    );
  });
  return { userId, householdId };
}

export async function verifyLogin(
  db: BetterWealthDatabase,
  inputValue: unknown,
  config: AppConfig,
): Promise<{ id: string; email: string; name: string }> {
  const input = loginSchema.parse(inputValue);
  const user = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.displayName,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(eq(users.normalizedEmail, normalizeEmail(input.email)))
    .get();
  const valid = await Bun.password.verify(
    input.password,
    user?.passwordHash ??
      (config.APP_ENV === "test" ? DUMMY_PASSWORD_HASH_TEST : DUMMY_PASSWORD_HASH_PRODUCTION),
  );
  if (!user || !valid || user.status !== "active") {
    throw new UnauthorizedError("Email or password is incorrect");
  }
  await db
    .update(users)
    .set({ lastLoginAt: new Date().toISOString() })
    .where(eq(users.id, user.id));
  return { id: user.id, email: user.email, name: user.name };
}

export async function createSession(
  db: BetterWealthDatabase,
  userId: string,
  config: AppConfig,
  metadata: { ipAddress?: string; userAgent?: string } = {},
) {
  const now = Date.now();
  const token = randomToken();
  const csrfToken = randomToken(24);
  const id = ulid();
  const absoluteExpiresAt = new Date(now + config.sessionAbsoluteMs).toISOString();
  const idleExpiresAt = new Date(
    Math.min(now + config.sessionIdleMs, now + config.sessionAbsoluteMs),
  ).toISOString();
  await db.insert(sessions).values({
    id,
    userId,
    tokenHash: sha256(token),
    csrfTokenHash: sha256(csrfToken),
    idleExpiresAt,
    absoluteExpiresAt,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent?.slice(0, 500),
  });
  return { id, token, csrfToken, idleExpiresAt, absoluteExpiresAt };
}

export async function resolveSession(
  db: BetterWealthDatabase,
  sessionToken: string | undefined,
  requestedHouseholdId?: string,
): Promise<AuthContext> {
  if (!sessionToken) throw new UnauthorizedError();
  const now = new Date().toISOString();
  const row = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      name: users.displayName,
      csrfTokenHash: sessions.csrfTokenHash,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
      idleExpiresAt: sessions.idleExpiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256(sessionToken)),
        isNull(sessions.revokedAt),
        gt(sessions.idleExpiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
        eq(users.status, "active"),
      ),
    )
    .get();
  if (!row) throw new UnauthorizedError("Your session has expired");

  const memberships = await db
    .select({ householdId: householdMembers.householdId, role: householdMembers.role })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(
      and(
        eq(householdMembers.userId, row.userId),
        eq(householdMembers.status, "active"),
        eq(households.status, "active"),
      ),
    );
  const membership = requestedHouseholdId
    ? memberships.find((entry) => entry.householdId === requestedHouseholdId)
    : memberships[0];
  if (!membership) throw new ForbiddenError("You do not have access to this household");

  return {
    user: { id: row.userId, email: row.email, name: row.name },
    householdId: membership.householdId,
    role: membership.role,
    sessionId: row.sessionId,
    csrfTokenHash: row.csrfTokenHash,
    absoluteExpiresAt: row.absoluteExpiresAt,
  };
}

export async function touchSession(
  db: BetterWealthDatabase,
  auth: AuthContext,
  config: AppConfig,
): Promise<void> {
  const nextIdle = Math.min(
    Date.now() + config.sessionIdleMs,
    new Date(auth.absoluteExpiresAt).getTime(),
  );
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date().toISOString(), idleExpiresAt: new Date(nextIdle).toISOString() })
    .where(eq(sessions.id, auth.sessionId));
}

export async function revokeSession(db: BetterWealthDatabase, sessionToken: string | undefined) {
  if (!sessionToken) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(sessions.tokenHash, sha256(sessionToken)));
}

export function requireRole(auth: AuthContext, allowed: readonly HouseholdRole[]) {
  if (!allowed.includes(auth.role)) throw new ForbiddenError();
}
