import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";

/**
 * Pins the OpenAPI surface to the live route table: every mounted route must
 * appear in /api/v1/openapi.json. This is what stops the hand-maintained spec
 * from silently drifting again (the failure mode that hid 9 endpoints).
 */

// Deliberately excluded from the public spec: the unversioned ops probe and
// the spec itself. The versioned /api/v1/health IS documented (as "/health").
const UNDOCUMENTED = new Set(["GET /health", "GET /api/v1/openapi.json"]);

function liveOperations(app: ReturnType<typeof createApp>["app"]): string[] {
  const operations = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue; // middleware registrations, not endpoints
    if (!route.path.startsWith("/api/v1") && route.path !== "/health") continue;
    const operation = `${route.method} ${route.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{id}")}`;
    if (!UNDOCUMENTED.has(operation) && !UNDOCUMENTED.has(`${route.method} ${route.path}`)) {
      operations.add(operation.replace("/api/v1", ""));
    }
  }
  return [...operations].sort();
}

describe("OpenAPI contract", () => {
  test("every live route is documented in openapi.json", async () => {
    const directory = mkdtempSync(join(tmpdir(), "betterwealth-openapi-"));
    const application = createApp(
      loadConfig({
        APP_ENV: "test",
        DATABASE_URL: join(directory, "test.sqlite"),
        ENCRYPTION_KEY: "a".repeat(64),
        WEB_ORIGIN: "http://localhost:5173",
        LOG_LEVEL: "error",
      }),
    );
    try {
      const response = await application.app.request("/api/v1/openapi.json");
      expect(response.status).toBe(200);
      const document = (await response.json()) as {
        paths: Record<string, Record<string, unknown>>;
      };
      const documented = new Set(
        Object.entries(document.paths).flatMap(([path, operations]) =>
          Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
        ),
      );

      const live = liveOperations(application.app);
      const missing = live.filter((operation) => !documented.has(operation));
      const stale = [...documented].filter((operation) => !live.includes(operation));
      expect({ missing, stale }).toEqual({ missing: [], stale: [] });
    } finally {
      application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
