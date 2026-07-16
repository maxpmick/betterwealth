import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const sourceLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function applicationEnvironment(): Record<string, string | undefined> {
  const workspaceRoot = resolve(import.meta.dir, "../../..");
  const appEnv = process.env.APP_ENV ?? "development";
  return {
    ...parseEnvFile(resolve(workspaceRoot, ".env")),
    ...parseEnvFile(resolve(workspaceRoot, `.env.${appEnv}`)),
    ...parseEnvFile(resolve(workspaceRoot, ".env.local")),
    ...process.env,
  };
}

const envSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1).default("./data/betterwealth.sqlite"),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  COOKIE_SECURE: z
    .preprocess((value) => value === true || value === "true", z.boolean())
    .default(false),
  TRUST_PROXY: z
    .preprocess((value) => value === true || value === "true", z.boolean())
    .default(false),
  REGISTRATION_MODE: z.enum(["open", "invite", "closed"]).default("open"),
  SESSION_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(15).default(360),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(30),
  OPENROUTER_BASE_URL: z
    .string()
    .url()
    .max(2_048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }, "must be an HTTPS URL without embedded credentials")
    .default("https://openrouter.ai/api/v1"),
  BOOTSTRAP_OPENROUTER_MODEL: z.string().default("tencent/hy3:free"),
  BOOTSTRAP_OPENROUTER_API_KEY: z.string().optional(),
  BOOTSTRAP_SIMPLEFIN_SETUP_TOKEN: z.string().optional(),
  BOOTSTRAP_USER_EMAIL: z.string().email().optional(),
  BOOTSTRAP_USER_PASSWORD: z.string().min(12).max(128).optional(),
  BOOTSTRAP_HOUSEHOLD_NAME: z.string().trim().min(1).max(80).default("My Wealth Plan"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source?: Record<string, string | undefined>) {
  const parsed = envSchema.safeParse(source ?? applicationEnvironment());
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid BetterWealth configuration:\n${details.join("\n")}`);
  }

  const workspaceRoot = resolve(import.meta.dir, "../../..");
  const databasePath =
    parsed.data.DATABASE_URL === ":memory:"
      ? ":memory:"
      : resolve(workspaceRoot, parsed.data.DATABASE_URL);

  const webOriginUrl = new URL(parsed.data.WEB_ORIGIN);
  if (
    webOriginUrl.origin !== parsed.data.WEB_ORIGIN ||
    webOriginUrl.username ||
    webOriginUrl.password
  ) {
    throw new Error(
      "Invalid BetterWealth configuration:\nWEB_ORIGIN: must be an exact origin without a path, query, fragment, or credentials",
    );
  }

  return {
    ...parsed.data,
    workspaceRoot,
    databasePath,
    dataDirectory: databasePath === ":memory:" ? ":memory:" : resolve(databasePath, ".."),
    isProduction: parsed.data.APP_ENV === "production",
    sessionIdleMs: parsed.data.SESSION_IDLE_DAYS * 86_400_000,
    sessionAbsoluteMs: parsed.data.SESSION_ABSOLUTE_DAYS * 86_400_000,
  } as const;
}
