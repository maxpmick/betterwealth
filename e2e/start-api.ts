import { mkdirSync, rmSync } from "node:fs";
import { loadConfig } from "../apps/api/src/config";
import { seedCanonicalAlex } from "../apps/api/src/seed/canonical-alex";
import { closeDatabase, openDatabase, runMigrations } from "../packages/db/src/index";

Object.assign(process.env, {
  APP_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: process.env.E2E_API_PORT ?? "3001",
  WEB_ORIGIN: `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? "5173"}`,
  DATABASE_URL: "./data/e2e.sqlite",
  ENCRYPTION_KEY: "e2e0000000000000000000000000000000000000000000000000000000000000",
  COOKIE_SECURE: "false",
  REGISTRATION_MODE: "open",
  LOG_LEVEL: "error",
});

const config = loadConfig(process.env);
if (config.dataDirectory !== ":memory:") {
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${config.databasePath}${suffix}`, { force: true });
  }
}
const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  await seedCanonicalAlex(db);
} finally {
  closeDatabase(db);
}

await import("../apps/api/src/index");
