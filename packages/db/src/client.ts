import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

export type BetterWealthDatabase = BunSQLiteDatabase<typeof schema> & { $client: Database };

export interface OpenDatabaseOptions {
  /** Create the database if it does not exist. Defaults to true for writable connections. */
  create?: boolean;
  /** Open without write access. WAL setup and migrations are unavailable in this mode. */
  readonly?: boolean;
  /** Milliseconds SQLite waits for a competing writer. Defaults to 5 seconds. */
  busyTimeoutMs?: number;
  /** Enable WAL for file databases. Defaults to true. */
  wal?: boolean;
}

function checkedBusyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 300_000) {
    throw new RangeError("busyTimeoutMs must be a safe integer between 0 and 300000");
  }
  return value;
}

/**
 * Open the application's schema-typed Drizzle database. The native Bun handle is available as
 * `db.$client`; callers should normally use {@link closeDatabase} for shutdown.
 */
export function openDatabase(
  filename: string,
  options: OpenDatabaseOptions = {},
): BetterWealthDatabase {
  const readonly = options.readonly ?? false;
  const client = new Database(filename, {
    create: options.create ?? !readonly,
    readonly,
    readwrite: !readonly,
    strict: true,
  });

  try {
    if (!readonly && filename !== ":memory:" && filename !== "") {
      chmodSync(filename, 0o600);
    }
    client.exec("PRAGMA foreign_keys = ON");
    client.exec(`PRAGMA busy_timeout = ${checkedBusyTimeout(options.busyTimeoutMs ?? 5_000)}`);
    if (!readonly && (options.wal ?? true) && filename !== ":memory:" && filename !== "") {
      client.exec("PRAGMA journal_mode = WAL");
      client.exec("PRAGMA synchronous = NORMAL");
    }
    client.exec("PRAGMA trusted_schema = OFF");
    client.exec("PRAGMA temp_store = MEMORY");
    if (!readonly) client.exec("PRAGMA secure_delete = FAST");

    const foreignKeys = client.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
    if (foreignKeys?.foreign_keys !== 1) {
      throw new Error("SQLite foreign key enforcement could not be enabled");
    }

    return drizzle(client, { schema }) as BetterWealthDatabase;
  } catch (error) {
    client.close();
    throw error;
  }
}

/** Checkpoint WAL where possible and close the native database handle. */
export function closeDatabase(db: BetterWealthDatabase): void {
  if (!db.$client.inTransaction) {
    try {
      db.$client.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      // Read-only and in-memory connections may not support a WAL checkpoint.
    }
  }
  db.$client.close();
}

export function getJournalMode(db: BetterWealthDatabase): string {
  const row = db.$client.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  return row?.journal_mode ?? "unknown";
}

export function foreignKeysEnabled(db: BetterWealthDatabase): boolean {
  return (
    db.$client.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys === 1
  );
}
