#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { resolve } from "node:path";

function usage(): never {
  console.error(
    "Usage: bun deploy/reset-password.ts --email user@example.com [--database /path/to/betterwealth.sqlite]",
  );
  process.exit(64);
}

function parseArguments(): { email: string; databasePath: string } {
  const arguments_ = process.argv.slice(2);
  let email = "";
  let databasePath = process.env.DATABASE_URL ?? "./data/betterwealth.sqlite";
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) usage();
    if (key === "--email") email = value;
    else if (key === "--database") databasePath = value;
    else usage();
  }
  email = email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) usage();
  if (databasePath === ":memory:") throw new Error("Refusing to reset a password in memory");
  return { email, databasePath: resolve(process.cwd(), databasePath) };
}

function hiddenLine(label: string): string {
  let tty: number;
  try {
    tty = openSync("/dev/tty", "r+");
  } catch {
    throw new Error(
      "No interactive TTY is available. Use matching BETTERWEALTH_NEW_PASSWORD and BETTERWEALTH_NEW_PASSWORD_CONFIRM environment variables.",
    );
  }

  const bytes: number[] = [];
  try {
    writeSync(tty, label);
    const disabled = spawnSync("stty", ["-echo"], { stdio: [tty, "ignore", tty] });
    if (disabled.status !== 0) throw new Error("Could not disable terminal echo");
    try {
      const byte = Buffer.alloc(1);
      while (bytes.length <= 512) {
        const count = readSync(tty, byte, 0, 1, null);
        if (count === 0 || byte[0] === 10 || byte[0] === 13) break;
        bytes.push(byte[0] ?? 0);
      }
    } finally {
      spawnSync("stty", ["echo"], { stdio: [tty, "ignore", tty] });
      writeSync(tty, "\n");
    }
  } finally {
    closeSync(tty);
  }
  return Buffer.from(bytes).toString("utf8");
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 128) {
    throw new Error("The new password must contain between 12 and 128 characters");
  }
}

function readNewPassword(): string {
  const fromEnvironment = process.env.BETTERWEALTH_NEW_PASSWORD;
  const confirmationFromEnvironment = process.env.BETTERWEALTH_NEW_PASSWORD_CONFIRM;
  if (fromEnvironment !== undefined || confirmationFromEnvironment !== undefined) {
    delete process.env.BETTERWEALTH_NEW_PASSWORD;
    delete process.env.BETTERWEALTH_NEW_PASSWORD_CONFIRM;
    if (!fromEnvironment || !confirmationFromEnvironment) {
      throw new Error(
        "Both BETTERWEALTH_NEW_PASSWORD and BETTERWEALTH_NEW_PASSWORD_CONFIRM are required",
      );
    }
    validatePassword(fromEnvironment);
    if (fromEnvironment !== confirmationFromEnvironment) {
      throw new Error("The supplied password values do not match");
    }
    return fromEnvironment;
  }

  const password = hiddenLine("New password: ");
  validatePassword(password);
  const confirmation = hiddenLine("Confirm new password: ");
  if (password !== confirmation) throw new Error("The supplied password values do not match");
  return password;
}

const { email: normalizedEmail, databasePath } = parseArguments();
const newPassword = readNewPassword();

const database = new Database(databasePath, {
  create: false,
  readonly: false,
  readwrite: true,
  strict: true,
});
try {
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
  const user = database
    .query<{ id: string }, [string]>("SELECT id FROM users WHERE normalized_email = ?")
    .get(normalizedEmail);
  if (!user) throw new Error("No user exists with that normalized email address");

  const passwordHash = await Bun.password.hash(newPassword, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  });
  const now = new Date().toISOString();

  const result = database.transaction(() => {
    const sessionsRevoked =
      database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL",
        )
        .get(user.id)?.count ?? 0;
    const tokensRevoked =
      database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM personal_access_tokens WHERE user_id = ? AND revoked_at IS NULL",
        )
        .get(user.id)?.count ?? 0;
    const memberships = database
      .query<{ householdId: string }, [string]>(
        "SELECT household_id AS householdId FROM household_members WHERE user_id = ?",
      )
      .all(user.id);

    database
      .query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, now, user.id);
    database
      .query("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(now, user.id);
    database
      .query(
        "UPDATE personal_access_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
      )
      .run(now, user.id);

    const insertAudit = database.query(
      `INSERT INTO audit_events
        (id, household_id, actor_user_id, actor_type, action, entity_type, entity_id, request_id, ip_address, metadata, occurred_at)
       VALUES (?, ?, NULL, 'system', 'password.reset_by_operator', 'user', ?, NULL, NULL, ?, ?)`,
    );
    for (const membership of memberships) {
      insertAudit.run(
        crypto.randomUUID(),
        membership.householdId,
        user.id,
        JSON.stringify({
          sessionsRevoked,
          personalAccessTokensRevoked: tokensRevoked,
          recoveryMethod: "local_operator_cli",
        }),
        now,
      );
    }

    return { sessionsRevoked, tokensRevoked };
  })();

  console.log(
    `Password reset completed. Revoked ${result.sessionsRevoked} session(s) and ${result.tokensRevoked} personal access token(s).`,
  );
} finally {
  try {
    database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } finally {
    database.close();
  }
}
