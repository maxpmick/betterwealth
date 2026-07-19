import type { BetterWealthDatabase } from "@betterwealth/db";
import { idempotencyKeys } from "@betterwealth/db/schema";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { AppError, ConflictError } from "./errors";

const IN_PROGRESS = 0;

/**
 * Replay-safe POST mutations. When a client sends Idempotency-Key, the first
 * request's response is stored per (household, key) and exact retries replay
 * it without re-executing. The key is claimed before the handler runs, so a
 * concurrent duplicate fails fast instead of double-writing. Thrown errors and
 * 5xx responses release the claim so the client may retry.
 */
export function idempotency(db: BetterWealthDatabase): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    // Route modules share mount points, so a request can pass through this
    // middleware more than once before a route matches (e.g. /api/v1 is the
    // base for several modules). Process each request exactly once.
    if (context.get("idempotencyProcessed")) {
      await next();
      return;
    }
    context.set("idempotencyProcessed", true);
    if (context.req.method !== "POST") {
      await next();
      return;
    }
    const suppliedKey = context.req.header("idempotency-key")?.trim();
    if (!suppliedKey) {
      await next();
      return;
    }
    if (suppliedKey.length > 160) {
      throw new AppError("Idempotency-Key must be 160 characters or fewer", 400, "bad_request");
    }
    const auth = context.get("auth");
    const scopedKey = `${auth.user.id}:${context.req.method} ${context.req.path}:${suppliedKey}`;
    const lookup = () =>
      db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.householdId, auth.householdId),
            eq(idempotencyKeys.key, scopedKey),
          ),
        )
        .get();
    const release = () =>
      db
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.householdId, auth.householdId),
            eq(idempotencyKeys.key, scopedKey),
          ),
        );

    const existing = await lookup();
    if (existing && existing.status !== IN_PROGRESS) {
      context.header("Idempotency-Replayed", "true");
      return context.newResponse(existing.body, existing.status as 200, {
        "content-type": "application/json",
      });
    }
    if (existing) {
      throw new ConflictError(
        "A request with this idempotency key is still being processed",
        "idempotency_in_progress",
      );
    }

    const claimed = await db
      .insert(idempotencyKeys)
      .values({
        householdId: auth.householdId,
        key: scopedKey,
        method: context.req.method,
        path: context.req.path,
        status: IN_PROGRESS,
        body: "",
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key })
      .get();
    if (!claimed) {
      // Lost a race against a concurrent request with the same key.
      const winner = await lookup();
      if (winner && winner.status !== IN_PROGRESS) {
        context.header("Idempotency-Replayed", "true");
        return context.newResponse(winner.body, winner.status as 200, {
          "content-type": "application/json",
        });
      }
      throw new ConflictError(
        "A request with this idempotency key is still being processed",
        "idempotency_in_progress",
      );
    }

    try {
      await next();
      const response = context.res;
      // Only successful responses are stored for replay. 4xx (often produced
      // by onError inside the chain, not thrown) and 5xx mean the mutation
      // never happened, so the claim is released and the client may retry
      // after fixing the request.
      if (response.status < 200 || response.status >= 300) {
        await release();
        return;
      }
      const body = await response.clone().text();
      await db
        .update(idempotencyKeys)
        .set({ status: response.status, body })
        .where(
          and(
            eq(idempotencyKeys.householdId, auth.householdId),
            eq(idempotencyKeys.key, scopedKey),
          ),
        );
    } catch (error) {
      // Errors thrown to onError (AppError → 4xx, unexpected → 5xx) never
      // happened as far as the client is concerned; allow the retry.
      await release();
      throw error;
    }
  };
}
