import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENCRYPTION_KEY = "c".repeat(64);
const CLI_DIRECTORY = import.meta.dir;

function runCli(script: string, env: Record<string, string>, args: string[] = []) {
  return spawnSync("bun", [join(CLI_DIRECTORY, script), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("CLI smoke tests", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function temporaryDatabase() {
    const directory = mkdtempSync(join(tmpdir(), "betterwealth-cli-"));
    directories.push(directory);
    return join(directory, "cli.sqlite");
  }

  test("migrate creates a database and reports the applied journal", () => {
    const databasePath = temporaryDatabase();
    const result = runCli("migrate.ts", {
      APP_ENV: "test",
      DATABASE_URL: databasePath,
      ENCRYPTION_KEY,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      status: "migrated",
      database: databasePath,
    });
  });

  test("seed refuses production by default and accepts the explicit override", () => {
    const baseEnv = {
      APP_ENV: "production",
      DATABASE_URL: temporaryDatabase(),
      ENCRYPTION_KEY,
    };

    const refused = runCli("seed.ts", baseEnv);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Refusing to seed the demo account");

    const allowed = runCli("seed.ts", baseEnv, ["--i-know-this-is-demo-data"]);
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout.trim())).toMatchObject({
      status: "seeded",
      email: "alex@example.com",
    });

    const unknownFlag = runCli("seed.ts", baseEnv, ["--force"]);
    expect(unknownFlag.status).not.toBe(0);
    expect(unknownFlag.stderr).toContain("Unknown argument: --force");
  });

  test("seed rejects an unknown argument", () => {
    const result = runCli(
      "seed.ts",
      { APP_ENV: "test", DATABASE_URL: ":memory:", ENCRYPTION_KEY },
      ["--wat"],
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown argument: --wat");
  });

  test("backup refuses an in-memory database", () => {
    const result = runCli("backup.ts", {
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot back up an in-memory database");
  });

  test("backup writes a verified snapshot to a custom destination", () => {
    const directory = mkdtempSync(join(tmpdir(), "betterwealth-cli-backup-"));
    directories.push(directory);
    const databasePath = join(directory, "live.sqlite");
    const destination = join(directory, "snapshot.sqlite");

    const migrated = runCli("migrate.ts", {
      APP_ENV: "test",
      DATABASE_URL: databasePath,
      ENCRYPTION_KEY,
    });
    expect(migrated.status).toBe(0);

    const result = runCli(
      "backup.ts",
      {
        APP_ENV: "test",
        DATABASE_URL: databasePath,
        ENCRYPTION_KEY,
      },
      [destination],
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      status: "backed_up",
      destination,
      pruned: 0,
    });

    const verified = spawnSync(
      "bun",
      [join(CLI_DIRECTORY, "../../../../deploy/verify-backup.ts"), destination],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(verified.status).toBe(0);
  });
});
