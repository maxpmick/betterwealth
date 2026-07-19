import type { BetterWealthDatabase } from "@betterwealth/db";
import { householdMembers, households, personalAccessTokens, users } from "@betterwealth/db/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { randomToken, sha256 } from "../lib/crypto";
import { ForbiddenError, NotFoundError } from "../lib/errors";
import type { AuthContext, HouseholdRole } from "./service";

export const TOKEN_PREFIX = "bw_pat_";
export const TOKEN_SCOPES = ["read", "write"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const createTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(TOKEN_SCOPES)).min(1).max(TOKEN_SCOPES.length).default(["read"]),
    expiresInDays: z.number().int().min(1).max(730).optional(),
  })
  .strict();

function membershipQuery(db: BetterWealthDatabase, userId: string) {
  return db
    .select({ householdId: householdMembers.householdId, role: householdMembers.role })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(
      and(
        eq(householdMembers.userId, userId),
        eq(householdMembers.status, "active"),
        eq(households.status, "active"),
      ),
    );
}

/**
 * Resolve a bearer token to an AuthContext, or undefined when the token is
 * unknown, revoked, or expired. lastUsedAt is stamped lazily by the caller's
 * middleware so a token list shows honest "last used" data.
 */
export async function resolvePersonalAccessToken(
  db: BetterWealthDatabase,
  bearerToken: string,
  requestedHouseholdId?: string,
): Promise<AuthContext | undefined> {
  if (!bearerToken.startsWith(TOKEN_PREFIX)) return undefined;
  const now = new Date().toISOString();
  const row = await db
    .select({
      id: personalAccessTokens.id,
      userId: users.id,
      email: users.email,
      name: users.displayName,
      scopes: personalAccessTokens.scopes,
      expiresAt: personalAccessTokens.expiresAt,
    })
    .from(personalAccessTokens)
    .innerJoin(users, eq(users.id, personalAccessTokens.userId))
    .where(
      and(
        eq(personalAccessTokens.tokenHash, sha256(bearerToken)),
        isNull(personalAccessTokens.revokedAt),
        eq(users.status, "active"),
        or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, now)),
      ),
    )
    .get();
  if (!row) return undefined;

  const memberships = await membershipQuery(db, row.userId);
  const membership = requestedHouseholdId
    ? memberships.find((entry) => entry.householdId === requestedHouseholdId)
    : memberships[0];
  if (!membership) throw new ForbiddenError("You do not have access to this household");

  return {
    user: { id: row.userId, email: row.email, name: row.name },
    householdId: membership.householdId,
    role: membership.role as HouseholdRole,
    sessionId: `pat:${row.id}`,
    csrfTokenHash: "",
    absoluteExpiresAt: row.expiresAt ?? "9999-12-31T00:00:00.000Z",
    tokenScopes: row.scopes,
  };
}

export function personalAccessTokenId(sessionId: string): string | undefined {
  return sessionId.startsWith("pat:") ? sessionId.slice(4) : undefined;
}

export function isPersonalAccessTokenAuth(auth: AuthContext): boolean {
  return personalAccessTokenId(auth.sessionId) !== undefined;
}

export async function touchPersonalAccessToken(
  db: BetterWealthDatabase,
  tokenId: string,
): Promise<void> {
  await db
    .update(personalAccessTokens)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(personalAccessTokens.id, tokenId));
}

export async function createPersonalAccessToken(
  db: BetterWealthDatabase,
  userId: string,
  input: z.infer<typeof createTokenSchema>,
): Promise<{ id: string; token: string; expiresAt: string | null }> {
  const id = ulid();
  const token = `${TOKEN_PREFIX}${randomToken(24)}`;
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
    : null;
  await db.insert(personalAccessTokens).values({
    id,
    userId,
    name: input.name,
    tokenHash: sha256(token),
    scopes: [...new Set(input.scopes)],
    expiresAt,
  });
  return { id, token, expiresAt };
}

export async function listPersonalAccessTokens(db: BetterWealthDatabase, userId: string) {
  return db
    .select({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
      scopes: personalAccessTokens.scopes,
      expiresAt: personalAccessTokens.expiresAt,
      lastUsedAt: personalAccessTokens.lastUsedAt,
      createdAt: personalAccessTokens.createdAt,
    })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt)))
    .orderBy(personalAccessTokens.createdAt);
}

export async function revokePersonalAccessToken(
  db: BetterWealthDatabase,
  userId: string,
  tokenId: string,
): Promise<void> {
  const updated = await db
    .update(personalAccessTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(personalAccessTokens.id, tokenId),
        eq(personalAccessTokens.userId, userId),
        isNull(personalAccessTokens.revokedAt),
      ),
    )
    .returning({ id: personalAccessTokens.id })
    .get();
  if (!updated) throw new NotFoundError("Token");
}

export function requireScope(auth: AuthContext, scope: TokenScope): void {
  if (!isPersonalAccessTokenAuth(auth)) return; // cookie sessions are full-scope
  if (scope === "read") return;
  if (!auth.tokenScopes?.includes("write")) {
    throw new ForbiddenError("This token cannot make changes");
  }
}
