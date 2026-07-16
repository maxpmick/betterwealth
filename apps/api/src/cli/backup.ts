import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  closeDatabase,
  createStandaloneSqliteSnapshot,
  openDatabase,
  removeSqliteFileSet,
  removeSqliteSidecars,
} from "@betterwealth/db";
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
const sourceIdentity = realpathSync(config.databasePath);
const destinationIdentity = (() => {
  try {
    return realpathSync(destination);
  } catch {
    return destination;
  }
})();
const sourceMetadata = statSync(sourceIdentity);
const destinationMetadata = existsSync(destination) ? statSync(destination) : undefined;
if (
  sourceIdentity === destinationIdentity ||
  (destinationMetadata &&
    sourceMetadata.dev === destinationMetadata.dev &&
    sourceMetadata.ino === destinationMetadata.ino)
) {
  throw new Error("Backup destination must not replace the live database");
}

const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
const db = openDatabase(config.databasePath, { create: false });
try {
  createStandaloneSqliteSnapshot(db.$client, temporary);
  removeSqliteSidecars(destination);
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
  let pruned = 0;
  if (!customDestination) {
    const cutoff = Date.now() - config.BACKUP_RETENTION_DAYS * 86_400_000;
    for (const name of readdirSync(destinationDirectory)) {
      if (!/^betterwealth-.*\.sqlite$/.test(name) || name === basename(destination)) continue;
      const candidate = resolve(destinationDirectory, name);
      if (statSync(candidate).mtimeMs < cutoff) {
        removeSqliteFileSet(candidate);
        pruned += 1;
      }
    }
  }
  console.log(JSON.stringify({ status: "backed_up", destination, pruned }));
} finally {
  removeSqliteFileSet(temporary);
  closeDatabase(db);
}
