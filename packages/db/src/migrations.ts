import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { BetterWealthDatabase } from "./client.ts";

export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export interface MigrationOptions {
  migrationsFolder?: string;
  migrationsTable?: string;
}

/** Apply every pending migration in one Drizzle-managed SQLite transaction. */
export function runMigrations(db: BetterWealthDatabase, options: MigrationOptions = {}): void {
  migrate(db, {
    migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
    ...(options.migrationsTable === undefined ? {} : { migrationsTable: options.migrationsTable }),
  });
}
