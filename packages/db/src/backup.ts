import { Database } from "bun:sqlite";
import { chmodSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

export interface StandaloneSqliteSnapshot {
  path: string;
  journalMode: "delete";
  sizeBytes: number;
  pageCount: number;
  schemaObjects: number;
}

/** Remove journals that may have been left beside a SQLite file after an interrupted operation. */
export function removeSqliteSidecars(path: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

/** Remove a SQLite main file together with every journal form it can depend on. */
export function removeSqliteFileSet(path: string): void {
  rmSync(path, { force: true });
  removeSqliteSidecars(path);
}

/**
 * Create a transactionally consistent, self-contained snapshot from an open SQLite connection.
 *
 * `Database.serialize()` preserves a WAL database's WAL header and can therefore produce bytes
 * that cannot be opened read-only without adjacent WAL/SHM files. SQLite's `VACUUM INTO` backup
 * path creates a new database generation instead. We still explicitly force DELETE journaling and
 * verify the snapshot before returning so callers can safely rename, download, or archive it.
 */
export function createStandaloneSqliteSnapshot(
  source: Database,
  destinationPath: string,
): StandaloneSqliteSnapshot {
  const destination = resolve(destinationPath);
  removeSqliteFileSet(destination);

  // SQLite creates the VACUUM target itself. A restrictive temporary umask closes the otherwise
  // brief window before chmod when the caller selected an existing, less-restrictive directory.
  const previousUmask = process.umask(0o077);
  try {
    source.query("VACUUM main INTO ?").run(destination);
  } catch (error) {
    removeSqliteFileSet(destination);
    throw error;
  } finally {
    process.umask(previousUmask);
  }

  let snapshot: Database | undefined;
  try {
    chmodSync(destination, 0o600);
    snapshot = new Database(destination, {
      create: false,
      readwrite: true,
      strict: true,
    });

    const journalMode = snapshot
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE")
      .get()?.journal_mode;
    if (journalMode?.toLowerCase() !== "delete") {
      throw new Error(`Backup journal mode is ${journalMode ?? "unknown"}; expected delete`);
    }

    const integrityRows = snapshot.query("PRAGMA quick_check").values() as unknown[][];
    if (integrityRows.length !== 1 || integrityRows[0]?.[0] !== "ok") {
      throw new Error("Backup SQLite quick_check failed");
    }
    if ((snapshot.query("PRAGMA foreign_key_check").values() as unknown[][]).length !== 0) {
      throw new Error("Backup SQLite foreign_key_check failed");
    }

    const pageCount = Number(
      (snapshot.query("PRAGMA page_count").values() as unknown[][])[0]?.[0] ?? 0,
    );
    const schemaObjects = Number(
      (snapshot.query("SELECT count(*) FROM sqlite_schema").values() as unknown[][])[0]?.[0] ?? 0,
    );
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || schemaObjects < 1) {
      throw new Error("Backup has no usable SQLite schema");
    }

    snapshot.close();
    snapshot = undefined;
    removeSqliteSidecars(destination);
    chmodSync(destination, 0o600);

    return {
      path: destination,
      journalMode: "delete",
      sizeBytes: statSync(destination).size,
      pageCount,
      schemaObjects,
    };
  } catch (error) {
    snapshot?.close();
    removeSqliteFileSet(destination);
    throw error;
  }
}
