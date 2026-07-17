import { mkdirSync } from "node:fs";
import {
  closeDatabase,
  connections,
  createHouseholdRepositories,
  householdMembers,
  openDatabase,
  runMigrations,
  settings,
  users,
} from "@betterwealth/db";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { registerUser } from "../auth/service";
import { loadConfig } from "../config";
import { claimSimpleFinToken } from "../integrations/simplefin";
import { FieldCipher } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { syncSimpleFinConnection } from "../sync/simplefin-sync";

const config = loadConfig();
if (!config.BOOTSTRAP_USER_EMAIL || !config.BOOTSTRAP_USER_PASSWORD) {
  throw new Error(
    "BOOTSTRAP_USER_EMAIL and BOOTSTRAP_USER_PASSWORD are required for first-run bootstrap",
  );
}
if (config.dataDirectory !== ":memory:") {
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
}

const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  const normalizedEmail = config.BOOTSTRAP_USER_EMAIL.trim().toLowerCase();
  let user = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.normalizedEmail, normalizedEmail))
    .get();
  let householdId: string;
  let createdUser = false;
  if (!user) {
    // Bootstrap is operator-run tooling with secret inputs, so it is not subject
    // to the public-registration gate the HTTP register route enforces.
    const registered = await registerUser(
      db,
      {
        email: config.BOOTSTRAP_USER_EMAIL,
        password: config.BOOTSTRAP_USER_PASSWORD,
        householdName: config.BOOTSTRAP_HOUSEHOLD_NAME,
      },
      config,
    );
    householdId = registered.householdId;
    user = { id: registered.userId, email: config.BOOTSTRAP_USER_EMAIL };
    createdUser = true;
  } else {
    const membership = await db
      .select({ householdId: householdMembers.householdId })
      .from(householdMembers)
      .where(and(eq(householdMembers.userId, user.id), eq(householdMembers.status, "active")))
      .get();
    if (!membership) throw new Error("Bootstrap user has no active household");
    householdId = membership.householdId;
  }

  const cipher = new FieldCipher(config.ENCRYPTION_KEY);
  let configuredAi = false;
  if (config.BOOTSTRAP_OPENROUTER_API_KEY) {
    const repositories = createHouseholdRepositories(db, householdId);
    const existing = repositories.settings.get("integration.openrouter", user.id);
    const aad = `settings:${householdId}:${user.id}:openrouter`;
    const encrypted = cipher.encrypt(
      JSON.stringify({
        enabled: true,
        consent: true,
        baseUrl: config.OPENROUTER_BASE_URL,
        model: config.BOOTSTRAP_OPENROUTER_MODEL,
        apiKey: config.BOOTSTRAP_OPENROUTER_API_KEY,
        confidenceThreshold: 0.9,
      }),
      aad,
    );
    const row = repositories.settings.set(
      existing?.id ?? ulid(),
      "integration.openrouter",
      { encrypted },
      user.id,
    );
    await db.update(settings).set({ isSecret: true }).where(eq(settings.id, row.id));
    configuredAi = true;
  }

  const existingSimpleFin = await db
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(and(eq(connections.householdId, householdId), eq(connections.provider, "simplefin")))
    .get();
  let simpleFinState: "already_connected" | "not_configured" | "succeeded" | "sync_failed" =
    existingSimpleFin ? "already_connected" : "not_configured";
  let simpleFinConnectionId = existingSimpleFin?.id;
  let simpleFinErrorCode: string | undefined;
  if (!existingSimpleFin && config.BOOTSTRAP_SIMPLEFIN_SETUP_TOKEN) {
    const accessUrl = await claimSimpleFinToken(config.BOOTSTRAP_SIMPLEFIN_SETUP_TOKEN);
    const id = ulid();
    const aad = `connection:${id}:credentials`;
    createHouseholdRepositories(db, householdId).connections.create({
      id,
      ownerUserId: user.id,
      provider: "simplefin",
      displayName: "SimpleFIN",
      encryptedCredentials: cipher.encrypt(accessUrl, aad),
      credentialsAad: aad,
      capabilities: ["accounts", "balances", "transactions", "pending"],
      status: "active",
    });
    simpleFinConnectionId = id;
  }
  if (simpleFinConnectionId && existingSimpleFin?.status !== "disabled") {
    try {
      await syncSimpleFinConnection({
        db,
        config,
        householdId,
        connectionId: simpleFinConnectionId,
        trigger: existingSimpleFin ? "retry" : "initial",
      });
      simpleFinState = "succeeded";
    } catch (error) {
      simpleFinState = "sync_failed";
      simpleFinErrorCode = error instanceof AppError ? error.code : "simplefin_sync_failed";
      process.exitCode = 1;
    }
  }

  console.log(
    JSON.stringify({
      status: "ready",
      user: user.email,
      createdUser,
      configuredAi,
      simpleFin: simpleFinState,
      ...(simpleFinErrorCode ? { simpleFinErrorCode } : {}),
    }),
  );
} finally {
  closeDatabase(db);
}
