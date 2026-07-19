import { mkdirSync } from "node:fs";
import { closeDatabase, openDatabase, runMigrations } from "@betterwealth/db";
import { loadConfig } from "../config";
import { seedCanonicalAlex } from "../seed/canonical-alex";
import { assertSeedAllowed, parseSeedArgs, SEED_DEMO_OVERRIDE_FLAG } from "./seed-options";

const options = parseSeedArgs(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: bun src/cli/seed.ts [${SEED_DEMO_OVERRIDE_FLAG}]`);
  process.exit(0);
}

const config = loadConfig();
assertSeedAllowed(config.isProduction, options);

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
