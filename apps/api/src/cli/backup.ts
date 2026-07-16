import {
  chmodSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { closeDatabase, openDatabase } from "@betterwealth/db";
import { loadConfig } from "../config";

const config = loadConfig();
if (config.databasePath === ":memory:") throw new Error("Cannot back up an in-memory database");
const customDestination = process.argv[2];
const destination = resolve(
  config.workspaceRoot,
  customDestination ??
    `backups/betterwealth-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
);
const destinationDirectory = dirname(destination);
mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
const temporary = `${destination}.tmp`;
const db = openDatabase(config.databasePath, { create: false });
try {
  db.$client.exec("PRAGMA wal_checkpoint(FULL)");
  writeFileSync(temporary, db.$client.serialize(), { mode: 0o600, flag: "wx" });
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
  let pruned = 0;
  if (!customDestination) {
    const cutoff = Date.now() - config.BACKUP_RETENTION_DAYS * 86_400_000;
    for (const name of readdirSync(destinationDirectory)) {
      if (!/^betterwealth-.*\.sqlite$/.test(name) || name === basename(destination)) continue;
      const candidate = resolve(destinationDirectory, name);
      if (statSync(candidate).mtimeMs < cutoff) {
        rmSync(candidate, { force: true });
        pruned += 1;
      }
    }
  }
  console.log(JSON.stringify({ status: "backed_up", destination, pruned }));
} catch (error) {
  rmSync(temporary, { force: true });
  throw error;
} finally {
  closeDatabase(db);
}
