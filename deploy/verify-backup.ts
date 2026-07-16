#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");
const backupDirectory = resolve(workspaceRoot, "backups");
const arguments_ = process.argv.slice(2);
const full = arguments_.includes("--full");
const positional = arguments_.filter((argument) => argument !== "--full");

function fail(message: string): never {
  console.error(JSON.stringify({ status: "invalid", message }));
  process.exit(1);
}

function newestManagedBackup(): string {
  if (!existsSync(backupDirectory)) fail("No managed backup directory exists");
  const candidates = readdirSync(backupDirectory)
    .filter((name) => /^betterwealth-.*\.sqlite$/.test(name))
    .map((name) => resolve(backupDirectory, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const newest = candidates[0];
  if (!newest) fail("No managed BetterWealth backup exists");
  return newest;
}

if (positional.length > 1) {
  fail("Usage: bun deploy/verify-backup.ts [--full] [backup.sqlite]");
}

const backupPath = positional[0] ? resolve(process.cwd(), positional[0]) : newestManagedBackup();
if (!existsSync(backupPath)) fail("Backup file does not exist");

const metadata = statSync(backupPath);
if (!metadata.isFile()) fail("Backup path is not a regular file");
if (metadata.size < 512) fail("Backup is too small to be a SQLite database");
if ((metadata.mode & 0o077) !== 0) {
  fail("Backup permissions are too broad; expected no group or other access");
}
if (existsSync(`${backupPath}-wal`) || existsSync(`${backupPath}-shm`)) {
  fail("Backup is not standalone; adjacent WAL or SHM files were found");
}

const descriptor = openSync(backupPath, "r");
const header = Buffer.alloc(16);
try {
  readSync(descriptor, header, 0, header.length, 0);
} finally {
  closeSync(descriptor);
}
if (header.toString("utf8") !== "SQLite format 3\u0000") {
  fail("Backup does not have a SQLite 3 header");
}

const database = new Database(backupPath, { readonly: true, create: false, strict: true });
try {
  const check = full ? "integrity_check" : "quick_check";
  const integrityRows = database.query(`PRAGMA ${check}`).values() as unknown[][];
  if (integrityRows.length !== 1 || integrityRows[0]?.[0] !== "ok") {
    fail(`SQLite ${check} failed`);
  }

  const foreignKeyRows = database.query("PRAGMA foreign_key_check").values() as unknown[][];
  if (foreignKeyRows.length !== 0) fail("SQLite foreign key check failed");

  const pageCount = Number(
    (database.query("PRAGMA page_count").values() as unknown[][])[0]?.[0] ?? 0,
  );
  const schemaObjects = Number(
    (database.query("SELECT count(*) FROM sqlite_schema").values() as unknown[][])[0]?.[0] ?? 0,
  );
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || schemaObjects < 1) {
    fail("Backup has no usable SQLite schema");
  }

  console.log(
    JSON.stringify({
      status: "verified",
      file: basename(backupPath),
      check,
      sizeBytes: metadata.size,
      pageCount,
      schemaObjects,
    }),
  );
} finally {
  database.close();
}
