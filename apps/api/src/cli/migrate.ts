import { mkdirSync } from "node:fs";
import { closeDatabase, openDatabase, runMigrations } from "@betterwealth/db";
import { loadConfig } from "../config";

const config = loadConfig();
if (config.dataDirectory !== ":memory:") {
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
}
const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  console.log(JSON.stringify({ status: "migrated", database: config.databasePath }));
} finally {
  closeDatabase(db);
}
