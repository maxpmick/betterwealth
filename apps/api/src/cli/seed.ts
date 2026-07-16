import { mkdirSync } from "node:fs";
import { closeDatabase, openDatabase, runMigrations } from "@betterwealth/db";
import { loadConfig } from "../config";
import { seedCanonicalAlex } from "../seed/canonical-alex";

const config = loadConfig();
if (config.dataDirectory !== ":memory:") {
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
}

const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  const result = await seedCanonicalAlex(db);
  console.log(JSON.stringify({ status: "seeded", ...result }));
} finally {
  closeDatabase(db);
}
