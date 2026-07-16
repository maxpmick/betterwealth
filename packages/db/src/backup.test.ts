import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStandaloneSqliteSnapshot,
  removeSqliteFileSet,
  removeSqliteSidecars,
} from "./backup.ts";

let directory: string;
let source: Database | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "betterwealth-backup-"));
});

afterEach(() => {
  source?.close();
  source = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("standalone SQLite snapshots", () => {
  test("turns a live WAL database into a private DELETE-journal backup readable without sidecars", () => {
    const sourcePath = join(directory, "live.sqlite");
    const destination = join(directory, "backup.sqlite");
    source = new Database(sourcePath, { create: true, strict: true });
    source.exec("PRAGMA foreign_keys = ON");
    source.exec("PRAGMA journal_mode = WAL");
    source.exec(`
      CREATE TABLE parents (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
      CREATE TABLE children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parents(id)
      );
      INSERT INTO parents (id, label) VALUES (1, 'committed in WAL');
      INSERT INTO children (id, parent_id) VALUES (1, 1);
    `);
    expect(statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);

    // A previous interrupted attempt must not poison the next snapshot.
    writeFileSync(destination, "stale");
    writeFileSync(`${destination}-wal`, "stale");
    writeFileSync(`${destination}-shm`, "stale");
    writeFileSync(`${destination}-journal`, "stale");

    const result = createStandaloneSqliteSnapshot(source, destination);
    expect(result.journalMode).toBe("delete");
    expect(result.sizeBytes).toBeGreaterThan(512);
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.schemaObjects).toBeGreaterThanOrEqual(2);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(existsSync(`${destination}-wal`)).toBe(false);
    expect(existsSync(`${destination}-shm`)).toBe(false);
    expect(existsSync(`${destination}-journal`)).toBe(false);

    const readonly = new Database(destination, {
      create: false,
      readonly: true,
      strict: true,
    });
    try {
      expect(
        readonly.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      ).toBe("delete");
      expect(
        readonly.query<{ count: number }, []>("SELECT count(*) AS count FROM children").get()
          ?.count,
      ).toBe(1);
      expect(readonly.query("PRAGMA quick_check").values()).toEqual([["ok"]]);
    } finally {
      readonly.close();
    }

    expect(existsSync(`${destination}-wal`)).toBe(false);
    expect(existsSync(`${destination}-shm`)).toBe(false);
  });

  test("cleans every SQLite journal form with or without the main file", () => {
    const path = join(directory, "interrupted.sqlite");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      writeFileSync(`${path}${suffix}`, "artifact");
    }

    removeSqliteSidecars(path);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(`${path}-journal`)).toBe(false);

    removeSqliteFileSet(path);
    expect(existsSync(path)).toBe(false);
  });
});
