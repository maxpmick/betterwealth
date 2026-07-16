import type { BetterWealthDatabase } from "@betterwealth/db";
import { connections, jobs } from "@betterwealth/db/schema";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppConfig } from "../config";

export async function syncActiveConnections(db: BetterWealthDatabase, config: AppConfig) {
  const active = await db
    .select({ id: connections.id, householdId: connections.householdId })
    .from(connections)
    .where(and(eq(connections.provider, "simplefin"), eq(connections.status, "active")));
  const now = new Date().toISOString();
  const intervalMs = config.SYNC_INTERVAL_MINUTES * 60_000;
  const scheduleBucket = Math.floor(Date.now() / intervalMs);
  let queued = 0;
  let skipped = 0;
  for (const connection of active) {
    const idempotencyKey = `simplefin.scheduled:${connection.id}:${scheduleBucket}`;
    const result = await db
      .insert(jobs)
      .values({
        id: ulid(),
        householdId: connection.householdId,
        type: "simplefin.sync",
        payload: { connectionId: connection.id, trigger: "scheduled" },
        state: "queued",
        scheduledAt: now,
        idempotencyKey,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (result.length > 0) queued += 1;
    else skipped += 1;
  }
  return { attempted: active.length, queued, skipped };
}
