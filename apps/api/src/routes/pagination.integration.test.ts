import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditEvents, importRuns } from "@betterwealth/db/schema";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { BetterWealthApplication } from "../app";
import { createApp } from "../app";
import { loadConfig } from "../config";

function cookieJar(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";", 1);
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) result[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return result;
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

type ListBody<Row> = {
  data: Row[];
  page: { cursor: string | null; hasMore: boolean };
};

type AuditEventRow = { id: string; action: string; occurredAt: string };
type ImportRunRow = {
  id: string;
  format: string;
  state: string;
  originalFilename: string | null;
  createdAt: string;
};

const SEED_BASE = Date.parse("2026-07-01T00:00:00.000Z");

describe("list endpoint pagination", () => {
  let directory: string;
  let application: BetterWealthApplication;
  let headers: Record<string, string>;
  let householdId: string;
  let userId: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-pagination-"));
    application = createApp(
      loadConfig({
        APP_ENV: "test",
        DATABASE_URL: join(directory, "test.sqlite"),
        ENCRYPTION_KEY: "e".repeat(64),
        WEB_ORIGIN: "http://localhost:5173",
        COOKIE_SECURE: "false",
        REGISTRATION_MODE: "open",
        LOG_LEVEL: "error",
      }),
    );
    const registration = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "pagination@example.com",
        password: "PaginationStrong!2026",
        householdName: "Pagination plan",
      }),
    });
    expect(registration.status).toBe(201);
    const identity = (await registration.json()) as { userId: string; householdId: string };
    userId = identity.userId;
    householdId = identity.householdId;
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "pagination@example.com", password: "PaginationStrong!2026" }),
    });
    expect(login.status).toBe(200);
    headers = { cookie: cookieHeader(cookieJar(login)) };
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function list(path: string) {
    return application.app.request(path, { headers });
  }

  async function seedAuditEvents(occurredAts: string[]) {
    for (const [index, occurredAt] of occurredAts.entries()) {
      await application.db.insert(auditEvents).values({
        id: ulid(),
        householdId,
        actorUserId: userId,
        actorType: "user",
        action: `test.event.${index}`,
        entityType: "user",
        entityId: userId,
        metadata: {},
        occurredAt,
      });
    }
  }

  async function clearAuditEvents() {
    await application.db.delete(auditEvents).where(eq(auditEvents.householdId, householdId));
  }

  async function seedImportRuns(count: number) {
    for (let index = 0; index < count; index++) {
      await application.db.insert(importRuns).values({
        id: ulid(),
        householdId,
        createdByUserId: userId,
        format: "csv",
        fileHash: `${index}`.padStart(64, "0"),
        originalFilename: `import-${index}.csv`,
        createdAt: new Date(SEED_BASE + index * 60_000).toISOString(),
      });
    }
  }

  test("audit-events pages with a cursor and tells the truth about hasMore", async () => {
    await clearAuditEvents();
    await seedAuditEvents([
      new Date(SEED_BASE).toISOString(),
      new Date(SEED_BASE + 60_000).toISOString(),
      new Date(SEED_BASE + 120_000).toISOString(),
    ]);

    const first = await list("/api/v1/audit-events?limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ListBody<AuditEventRow>;
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.page.hasMore).toBe(true);
    expect(firstBody.page.cursor).toEqual(expect.any(String));
    // Newest first.
    expect(firstBody.data[0]?.action).toBe("test.event.2");
    expect(firstBody.data[1]?.action).toBe("test.event.1");

    const second = await list(
      `/api/v1/audit-events?limit=2&cursor=${encodeURIComponent(firstBody.page.cursor ?? "")}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ListBody<AuditEventRow>;
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.data[0]?.action).toBe("test.event.0");
    expect(secondBody.page).toEqual({ cursor: null, hasMore: false });

    const firstIds = firstBody.data.map((row) => row.id);
    expect(firstIds).not.toContain(secondBody.data[0]?.id);
  });

  test("audit-events walks rows that share the same occurredAt without skipping", async () => {
    await clearAuditEvents();
    const shared = new Date(SEED_BASE).toISOString();
    await seedAuditEvents([shared, shared, new Date(SEED_BASE + 60_000).toISOString()]);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const path = cursor
        ? `/api/v1/audit-events?limit=1&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/audit-events?limit=1";
      const response = await list(path);
      expect(response.status).toBe(200);
      const body = (await response.json()) as ListBody<AuditEventRow>;
      expect(body.data).toHaveLength(1);
      seen.push(body.data[0]!.id);
      cursor = body.page.cursor;
      expect(body.page.hasMore).toBe(page < 2);
    }
    expect(new Set(seen).size).toBe(3);
  });

  test("audit-events rejects an invalid cursor with the contract error", async () => {
    const response = await list("/api/v1/audit-events?cursor=not-a-real-cursor");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_failed", message: "Invalid cursor" },
    });
  });

  test("audit-events without params keeps the previous response shape", async () => {
    await clearAuditEvents();
    await seedAuditEvents([new Date(SEED_BASE).toISOString()]);

    const response = await list("/api/v1/audit-events");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListBody<AuditEventRow>;
    expect(body.data).toHaveLength(1);
    expect(body.page).toEqual({ cursor: null, hasMore: false });
  });

  test("imports pages with a cursor and tells the truth about hasMore", async () => {
    await seedImportRuns(3);

    const first = await list("/api/v1/imports?limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ListBody<ImportRunRow>;
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.page.hasMore).toBe(true);
    expect(firstBody.page.cursor).toEqual(expect.any(String));
    expect(firstBody.data[0]?.originalFilename).toBe("import-2.csv");
    expect(firstBody.data[1]?.originalFilename).toBe("import-1.csv");

    const second = await list(
      `/api/v1/imports?limit=2&cursor=${encodeURIComponent(firstBody.page.cursor ?? "")}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ListBody<ImportRunRow>;
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.data[0]?.originalFilename).toBe("import-0.csv");
    expect(secondBody.page).toEqual({ cursor: null, hasMore: false });
  });

  test("imports rejects an invalid cursor with the contract error", async () => {
    const response = await list("/api/v1/imports?cursor=%40%23%24");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_failed", message: "Invalid cursor" },
    });
  });

  test("imports without params keeps the previous response shape", async () => {
    await seedImportRuns(1);

    const response = await list("/api/v1/imports");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListBody<ImportRunRow>;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      format: "csv",
      state: "preview",
      originalFilename: "import-0.csv",
    });
    expect(body.page).toEqual({ cursor: null, hasMore: false });
  });
});
