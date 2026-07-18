import { chmodSync, existsSync, mkdirSync } from "node:fs";
import {
  type BetterWealthDatabase,
  closeDatabase,
  openDatabase,
  runMigrations,
} from "@betterwealth/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { isTrustedWebOrigin } from "./auth/middleware";
import type { AppConfig } from "./config";
import { AppError } from "./lib/errors";
import { createLogger } from "./lib/logger";
import { rateLimit } from "./lib/rate-limit";
import { createAuthRoutes } from "./routes/auth";
import { createIntegrationRoutes, type IntegrationRouteDependencies } from "./routes/integrations";
import { createLedgerRoutes } from "./routes/ledger";
import { createOperationRoutes } from "./routes/operations";
import { createPlanningRoutes } from "./routes/planning";
import { createReportRoutes } from "./routes/reports";
import type { AppEnv } from "./types";

export interface BetterWealthApplication {
  app: Hono<AppEnv>;
  db: BetterWealthDatabase;
  close(): void;
}

export interface BetterWealthApplicationDependencies {
  integrations?: IntegrationRouteDependencies;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => Date;
}

const documentedOperations = [
  ["GET", "/health", "Runtime readiness", true],
  ["GET", "/capabilities", "Read public instance capabilities", true],
  ["POST", "/auth/register", "Register a user and household", true],
  ["POST", "/auth/login", "Create a browser or mobile session", true],
  ["GET", "/auth/session", "Read the current session"],
  ["GET", "/auth/sessions", "List active sessions"],
  ["DELETE", "/auth/sessions/{id}", "Revoke an active session"],
  ["POST", "/auth/logout", "End the current session"],
  ["GET", "/auth/tokens", "List personal access tokens"],
  ["POST", "/auth/tokens", "Create a personal access token"],
  ["DELETE", "/auth/tokens/{id}", "Revoke a personal access token"],
  ["GET", "/profile", "Read user and household profile"],
  ["PATCH", "/profile", "Update user and household profile"],
  ["POST", "/profile/password", "Change the account password"],
  ["GET", "/household/members", "List household members"],
  ["GET", "/accounts", "List financial accounts"],
  ["POST", "/accounts", "Create a manual account"],
  ["PATCH", "/accounts/{id}", "Update an account"],
  ["GET", "/accounts/{id}/balances", "Read dated balance history and reconciliation"],
  ["GET", "/categories", "List transaction categories"],
  ["POST", "/categories", "Create a category"],
  ["PATCH", "/categories/{id}", "Update a category"],
  ["GET", "/transactions", "List and filter transactions"],
  ["POST", "/transactions", "Create a manual transaction"],
  ["GET", "/transactions/{id}", "Read transaction details and ledger links"],
  ["PATCH", "/transactions/{id}", "Update or approve a transaction"],
  ["DELETE", "/transactions/{id}", "Soft-remove a transaction with audit history"],
  ["POST", "/transactions/{id}/restore", "Restore a soft-removed transaction"],
  ["PUT", "/transactions/{id}/tags", "Replace transaction tags"],
  ["PUT", "/transactions/{id}/splits", "Replace exact transaction splits"],
  ["DELETE", "/transactions/{id}/splits", "Remove transaction splits"],
  ["POST", "/transactions/bulk", "Bulk update transactions"],
  ["POST", "/transfers", "Confirm a matched account transfer"],
  ["DELETE", "/transfers/{id}", "Remove a confirmed transfer match"],
  ["POST", "/refund-links", "Link a refund credit to its purchase"],
  ["DELETE", "/refund-links/{id}", "Remove a refund link"],
  ["GET", "/connections", "List data connections"],
  ["POST", "/connections/simplefin/claim", "Claim a SimpleFIN setup token"],
  ["PATCH", "/connections/{id}", "Update a data connection"],
  ["POST", "/sync-runs", "Queue an account sync"],
  ["GET", "/sync-runs", "List account sync runs"],
  ["GET", "/settings/integrations", "Read integration settings"],
  ["PATCH", "/settings/integrations", "Update integration settings"],
  ["GET", "/settings/integrations/ai", "Read the current user's AI provider configuration"],
  ["PUT", "/settings/integrations/ai", "Configure the current user's encrypted AI provider"],
  ["POST", "/ai/suggestions/transactions/{id}", "Request a bounded transaction suggestion"],
  ["GET", "/ai/suggestions", "List AI categorization suggestions"],
  ["POST", "/ai/suggestions/{id}/regenerate", "Regenerate an AI suggestion from user feedback"],
  ["PATCH", "/ai/suggestions/{id}", "Review an AI suggestion"],
  ["GET", "/envelopes", "List envelope definitions"],
  ["POST", "/envelopes", "Create an envelope"],
  ["PATCH", "/envelopes/{id}", "Update an envelope"],
  ["DELETE", "/envelopes/{id}", "Archive an envelope"],
  ["GET", "/budgets", "List budget periods with envelopes"],
  ["POST", "/budgets", "Create a budget period"],
  ["PATCH", "/budgets/{id}", "Update a budget period"],
  ["DELETE", "/budgets/{id}", "Archive a budget period"],
  [
    "POST",
    "/budgets/{id}/build-from-monthly-spend",
    "Convert an approximate monthly plan into exact paycheck funding",
  ],
  ["POST", "/allocations", "Move money between envelope allocations"],
  ["POST", "/budgets/{id}/build-from-monthly-spend", "Build envelopes from monthly spend"],
  ["GET", "/bills", "List planned bills"],
  ["POST", "/bills", "Create a planned bill"],
  ["PATCH", "/bills/{id}", "Update a planned bill"],
  ["DELETE", "/bills/{id}", "Archive a planned bill"],
  ["GET", "/goals", "List financial goals"],
  ["POST", "/goals", "Create a financial goal"],
  ["PUT", "/goals/order", "Atomically reorder financial goals"],
  ["PATCH", "/goals/{id}", "Update a financial goal"],
  ["DELETE", "/goals/{id}", "Archive a financial goal"],
  ["GET", "/goals/{id}/contributions", "List goal contributions"],
  ["POST", "/goals/{id}/contributions", "Record a goal contribution"],
  ["GET", "/rules", "List deterministic transaction rules"],
  ["POST", "/rules", "Create a deterministic transaction rule"],
  ["PATCH", "/rules/{id}", "Update a deterministic transaction rule"],
  ["DELETE", "/rules/{id}", "Delete a deterministic transaction rule"],
  ["POST", "/rules/preview", "Preview a transaction rule"],
  ["POST", "/rules/{id}/apply", "Apply a rule to matching transactions"],
  ["GET", "/scenarios", "List forecast scenarios"],
  ["POST", "/scenarios", "Create a forecast scenario"],
  ["PATCH", "/scenarios/{id}", "Update a forecast scenario"],
  ["DELETE", "/scenarios/{id}", "Archive a forecast scenario"],
  ["GET", "/forecasts", "List forecast runs"],
  ["POST", "/forecasts", "Run a deterministic or Monte Carlo forecast"],
  ["GET", "/forecast-runs/{id}", "Read full forecast output"],
  ["GET", "/assets", "List manually valued assets"],
  ["POST", "/assets", "Create a manually valued asset"],
  ["PATCH", "/assets/{id}", "Update a manually valued asset"],
  ["DELETE", "/assets/{id}", "Archive a manually valued asset"],
  ["GET", "/assets/{id}/valuations", "List dated asset valuations"],
  ["POST", "/assets/{id}/valuations", "Append an asset valuation"],
  ["GET", "/income-sources", "List income sources"],
  ["POST", "/income-sources", "Create an income source"],
  ["PATCH", "/income-sources/{id}", "Update an income source"],
  ["DELETE", "/income-sources/{id}", "Archive an income source"],
  ["GET", "/imports", "List file imports"],
  ["POST", "/imports/transactions", "Import CSV, OFX, or QFX transactions"],
  ["GET", "/reports/dashboard", "Read the safe-to-spend dashboard"],
  ["GET", "/reports/dashboard/preferences", "Read safe-to-spend planning preferences"],
  ["PATCH", "/reports/dashboard/preferences", "Update safe-to-spend planning preferences"],
  ["GET", "/reports/net-worth", "Read net-worth history and composition"],
  ["GET", "/reports/cash-flow", "Read monthly cash flow"],
  ["GET", "/reports/spending", "Read category spending"],
  ["GET", "/audit-events", "List sanitized audit events"],
  ["GET", "/data-export", "Download a secret-free JSON export"],
  ["GET", "/database-backup", "Download a consistent SQLite backup"],
] as const;

function openApiPaths() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, summary, isPublic = false] of documentedOperations) {
    const parameters: Array<Record<string, unknown>> = [];
    for (const match of path.matchAll(/\{([^}]+)\}/g)) {
      parameters.push({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !isPublic) {
      parameters.push({
        name: "X-CSRF-Token",
        in: "header",
        required: true,
        schema: { type: "string" },
        description: "Mirror the bw_csrf cookie for cookie-authenticated mutations.",
      });
    }
    const pathOperations = paths[path] ?? {};
    pathOperations[method.toLowerCase()] = {
      summary,
      ...(isPublic ? { security: [] } : { security: [{ sessionCookie: [] }, { bearerToken: [] }] }),
      ...(parameters.length ? { parameters } : {}),
      responses: {
        "200": { description: "Successful response" },
        "400": {
          description: "Malformed request (bad JSON, oversized body, or unsupported input shape)",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        "401": {
          description: "Authentication required",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        "403": {
          description: "Forbidden (origin, CSRF, or role check failed)",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        "404": {
          description: "Resource not found",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        "409": {
          description: "Conflict with current state",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        "413": {
          description: "Request body exceeds the size limit",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        "415": {
          description: "Unsupported media type (JSON required)",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        "422": {
          description: "Validation failed (schema or domain rule)",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
        "429": {
          description: "Rate limit exceeded",
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Error" } },
          },
        },
      },
    };
    paths[path] = pathOperations;
  }
  return paths;
}

export function createApp(
  config: AppConfig,
  dependencies: BetterWealthApplicationDependencies = {},
): BetterWealthApplication {
  if (config.dataDirectory !== ":memory:") {
    mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDirectory, 0o700);
  }
  const db = openDatabase(config.databasePath);
  if (config.databasePath !== ":memory:") {
    chmodSync(config.databasePath, 0o600);
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${config.databasePath}${suffix}`;
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
  }
  runMigrations(db);
  const logger = createLogger(config.LOG_LEVEL);
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  app.use("*", async (context, next) => {
    context.set("requestId", context.get("requestId"));
    const startedAt = performance.now();
    await next();
    logger.info("request.complete", {
      requestId: context.get("requestId"),
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  });
  app.use(
    "*",
    secureHeaders({
      crossOriginResourcePolicy: "same-site",
      referrerPolicy: "no-referrer",
      strictTransportSecurity: config.isProduction ? "max-age=31536000; includeSubDomains" : false,
      contentSecurityPolicy: {
        // JSON-only API: no scripts, no framing, no subresources.
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    }),
  );
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (isTrustedWebOrigin(config, origin) ? origin : undefined),
      allowHeaders: [
        "Content-Type",
        "X-CSRF-Token",
        "Idempotency-Key",
        "Authorization",
        "X-BetterWealth-Household",
      ],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      exposeHeaders: ["X-Request-Id", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"],
      credentials: true,
      maxAge: 600,
    }),
  );
  app.use("/api/v1/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  });
  const defaultBodyLimit = 2 * 1024 * 1024;
  const importBodyLimit = 12 * 1024 * 1024;
  app.use("/api/*", async (context, next) => {
    // Imports carry whole CSV/OFX files inside the JSON body and get a larger
    // budget; everything else stays at the default cap.
    const maxSize = context.req.path.startsWith("/api/v1/imports/")
      ? importBodyLimit
      : defaultBodyLimit;
    return bodyLimit({ maxSize })(context, next);
  });
  app.use(
    "/api/v1/auth/login",
    rateLimit({
      limit: 10,
      windowMs: 60_000,
      keyPrefix: "login",
      trustProxy: config.TRUST_PROXY,
    }),
  );
  app.use(
    "/api/v1/auth/register",
    rateLimit({
      limit: 5,
      windowMs: 60_000,
      keyPrefix: "register",
      trustProxy: config.TRUST_PROXY,
    }),
  );
  const highCostLimits = [
    ["/api/v1/connections/simplefin/claim", 5, 3_600_000, "simplefin-claim"],
    ["/api/v1/sync-runs", 30, 3_600_000, "sync"],
    ["/api/v1/ai/suggestions/transactions/*", 30, 60_000, "ai-suggestion"],
    ["/api/v1/ai/suggestions/*/regenerate", 20, 60_000, "ai-regenerate"],
    ["/api/v1/imports/transactions", 12, 3_600_000, "import"],
    ["/api/v1/forecasts", 20, 60_000, "forecast"],
    ["/api/v1/data-export", 6, 3_600_000, "export"],
    ["/api/v1/database-backup", 6, 3_600_000, "backup"],
  ] as const;
  for (const [path, limit, windowMs, keyPrefix] of highCostLimits) {
    app.use(path, rateLimit({ limit, windowMs, keyPrefix, trustProxy: config.TRUST_PROXY }));
  }

  const health = () => ({
    status: "ok" as const,
    version: "0.1.0",
    time: new Date().toISOString(),
    database: "ready" as const,
  });
  app.get("/health", (context) => context.json(health()));
  app.get("/api/v1/health", (context) => context.json(health()));
  app.get("/api/v1/capabilities", (context) =>
    context.json({
      registration: {
        mode: config.REGISTRATION_MODE,
        selfService: config.REGISTRATION_MODE === "open",
      },
    }),
  );

  app.get("/api/v1/openapi.json", (context) =>
    context.json({
      openapi: "3.1.0",
      info: {
        title: "BetterWealth API",
        version: "0.1.0",
        description:
          "A household-scoped personal finance API for ledger, planning, budgeting, and wealth forecasting. Money uses signed base-10 minor-unit strings.",
      },
      servers: [{ url: "/api/v1" }],
      paths: openApiPaths(),
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "bw_session",
            description:
              "Session cookie from POST /auth/login. Non-browser clients call POST /auth/login, store the Set-Cookie values (bw_session, bw_csrf), send them as a Cookie header on every request, and mirror the bw_csrf value in the X-CSRF-Token header on every mutation. Requests without an Origin header are allowed so native clients are not origin-checked.",
          },
          bearerToken: {
            type: "http",
            scheme: "bearer",
            description:
              "Personal access token (bw_pat_...) from POST /auth/tokens. Send as Authorization: Bearer <token>. No CSRF header is required for bearer-authenticated requests. Tokens are scoped (read, write) and per-user.",
          },
        },
        schemas: {
          Money: {
            type: "object",
            additionalProperties: false,
            required: ["minorUnits", "currency"],
            properties: {
              minorUnits: { type: "string", pattern: "^-?\\d+$" },
              currency: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{2,11}$" },
            },
          },
          Error: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message"],
                properties: { code: { type: "string" }, message: { type: "string" } },
              },
            },
          },
        },
      },
    }),
  );

  app.route("/api/v1/auth", createAuthRoutes(db, config));
  app.route("/api/v1", createLedgerRoutes(db, config));
  app.route("/api/v1/reports", createReportRoutes(db, config));
  app.route("/api/v1", createIntegrationRoutes(db, config, dependencies.integrations));
  app.route("/api/v1", createOperationRoutes(db, config));
  app.route("/api/v1", createPlanningRoutes(db, config, dependencies.now));

  app.notFound((context) =>
    context.json({ error: { code: "not_found", message: "API route not found" } }, 404),
  );
  app.onError((error, context) => {
    if (error instanceof AppError) {
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        error.status as 400,
      );
    }
    if (error instanceof ZodError) {
      return context.json(
        {
          error: {
            code: "validation_failed",
            message: "The request did not pass validation",
            details: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
          },
        },
        422,
      );
    }
    if (error instanceof SyntaxError) {
      // Malformed JSON request bodies surface from context.req.json() as
      // SyntaxError; they are client errors, not server failures.
      return context.json(
        { error: { code: "invalid_json", message: "The request body is not valid JSON" } },
        400,
      );
    }
    if (error instanceof HTTPException) {
      // Framework-raised errors (e.g. the body-limit middleware's 413) keep
      // their real status instead of collapsing into a 500.
      const code = error.status === 413 ? "payload_too_large" : "request_failed";
      const message =
        error.status === 413
          ? "The request body exceeds the size limit"
          : error.message || "The request could not be completed";
      return context.json({ error: { code, message } }, error.status);
    }
    logger.error("request.failed", {
      requestId: context.get("requestId"),
      method: context.req.method,
      path: context.req.path,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
    });
    return context.json(
      { error: { code: "internal_error", message: "An unexpected server error occurred" } },
      500,
    );
  });

  return { app, db, close: () => closeDatabase(db) };
}
