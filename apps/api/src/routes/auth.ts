import type { BetterWealthDatabase } from "@betterwealth/db";
import { sessions } from "@betterwealth/db/schema";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  CSRF_COOKIE,
  clientIp,
  HOUSEHOLD_COOKIE,
  requireAuth,
  requireCsrf,
  requireJsonBody,
  requireTrustedOrigin,
  SESSION_COOKIE,
} from "../auth/middleware";
import { createSession, registerUser, revokeSession, verifyLogin } from "../auth/service";
import type { AppConfig } from "../config";
import type { AppEnv } from "../types";

function sessionCookieOptions(config: AppConfig, httpOnly: boolean) {
  return {
    path: "/",
    httpOnly,
    secure: config.COOKIE_SECURE || config.isProduction,
    sameSite: "Lax" as const,
    maxAge: config.SESSION_ABSOLUTE_DAYS * 86_400,
  };
}

export function createAuthRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();

  routes.post("/register", requireTrustedOrigin(config), requireJsonBody(), async (context) => {
    const result = await registerUser(db, await context.req.json(), config);
    return context.json(result, 201);
  });

  routes.post("/login", requireTrustedOrigin(config), requireJsonBody(), async (context) => {
    const user = await verifyLogin(db, await context.req.json(), config);
    const ipAddress = clientIp(context, config);
    const userAgent = context.req.header("user-agent");
    const session = await createSession(db, user.id, config, {
      ...(ipAddress ? { ipAddress } : {}),
      ...(userAgent ? { userAgent } : {}),
    });
    setCookie(context, SESSION_COOKIE, session.token, sessionCookieOptions(config, true));
    setCookie(context, CSRF_COOKIE, session.csrfToken, sessionCookieOptions(config, false));
    // A host-scoped selector can outlive an older local instance or a removed membership. Start a
    // fresh session from the user's first active household instead of letting stale browser state
    // turn a valid login into an immediate forbidden response.
    deleteCookie(context, HOUSEHOLD_COOKIE, { path: "/" });
    return context.json({ user, csrfToken: session.csrfToken });
  });

  routes.get("/session", requireAuth(db, config), (context) => {
    const auth = context.get("auth");
    setCookie(context, HOUSEHOLD_COOKIE, auth.householdId, sessionCookieOptions(config, false));
    return context.json({ user: auth.user, householdId: auth.householdId, role: auth.role });
  });

  routes.get("/sessions", requireAuth(db, config), async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        ipAddress: sessions.ipAddress,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.absoluteExpiresAt,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, auth.user.id),
          isNull(sessions.revokedAt),
          gt(sessions.idleExpiresAt, new Date().toISOString()),
          gt(sessions.absoluteExpiresAt, new Date().toISOString()),
        ),
      )
      .orderBy(desc(sessions.lastSeenAt));
    return context.json({
      data: rows.map((row) => ({
        ...row,
        current: row.id === auth.sessionId,
        userAgent: row.userAgent ?? "Unknown device",
        ipAddress: row.ipAddress ?? "Unknown network",
      })),
      page: { cursor: null, hasMore: false },
    });
  });

  routes.delete("/sessions/:id", requireAuth(db, config), requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const id = context.req.param("id");
    if (id === auth.sessionId) {
      return context.json(
        { error: { code: "current_session", message: "Use sign out to end this session" } },
        409,
      );
    }
    await db
      .update(sessions)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(sessions.id, id), eq(sessions.userId, auth.user.id)));
    return context.body(null, 204);
  });

  routes.post("/logout", requireAuth(db, config), requireCsrf(config), async (context) => {
    await revokeSession(db, getCookie(context, SESSION_COOKIE));
    deleteCookie(context, SESSION_COOKIE, { path: "/" });
    deleteCookie(context, CSRF_COOKIE, { path: "/" });
    deleteCookie(context, HOUSEHOLD_COOKIE, { path: "/" });
    return context.body(null, 204);
  });

  return routes;
}
