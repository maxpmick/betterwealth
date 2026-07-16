import type { BetterWealthDatabase } from "@betterwealth/db";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppConfig } from "../config";
import { secureEqual, sha256 } from "../lib/crypto";
import { AppError, ForbiddenError } from "../lib/errors";
import type { AppEnv } from "../types";
import { resolveSession, touchSession } from "./service";

export const SESSION_COOKIE = "bw_session";
export const CSRF_COOKIE = "bw_csrf";
export const HOUSEHOLD_COOKIE = "bw_household";

export function clientIp(context: Context<AppEnv>, config: AppConfig): string | undefined {
  if (config.TRUST_PROXY) {
    const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded.slice(0, 64);
    const realIp = context.req.header("x-real-ip")?.trim();
    if (realIp) return realIp.slice(0, 64);
  }
  return context.env?.remoteAddress?.slice(0, 64);
}

/** Reject browser cross-origin auth attempts while preserving origin-less native/CLI clients. */
export function requireTrustedOrigin(config: AppConfig): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const origin = context.req.header("origin");
    if (origin && origin !== config.WEB_ORIGIN) {
      throw new ForbiddenError("Request origin was rejected");
    }
    await next();
  };
}

export function requireJsonBody(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const mediaType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new AppError(
        "This endpoint requires an application/json body",
        415,
        "unsupported_media_type",
      );
    }
    await next();
  };
}

export function requireAuth(
  db: BetterWealthDatabase,
  config: AppConfig,
): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const auth = await resolveSession(
      db,
      getCookie(context, SESSION_COOKIE),
      getCookie(context, HOUSEHOLD_COOKIE),
    );
    context.set("auth", auth);
    await touchSession(db, auth, config);
    await next();
  };
}

export function requireCsrf(config: AppConfig): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
      await next();
      return;
    }
    const origin = context.req.header("origin");
    if (origin && origin !== config.WEB_ORIGIN)
      throw new ForbiddenError("Request origin was rejected");
    const cookieToken = getCookie(context, CSRF_COOKIE);
    const headerToken = context.req.header("x-csrf-token");
    const auth = context.get("auth");
    if (
      !cookieToken ||
      !headerToken ||
      !secureEqual(cookieToken, headerToken) ||
      !secureEqual(sha256(headerToken), auth.csrfTokenHash)
    ) {
      throw new ForbiddenError("CSRF validation failed");
    }
    if (auth.role === "viewer") {
      throw new ForbiddenError("View-only household members cannot make changes");
    }
    await next();
  };
}
