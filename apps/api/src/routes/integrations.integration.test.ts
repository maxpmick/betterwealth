import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHouseholdRepositories } from "@betterwealth/db";
import {
  accounts,
  aiSuggestions,
  auditEvents,
  categories,
  jobs,
  rules,
  settings,
  transactions,
} from "@betterwealth/db/schema";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import type { BetterWealthApplication } from "../app";
import { createApp } from "../app";
import { loadConfig } from "../config";
import type {
  RegeneratedCategorizationSuggestion,
  regenerateTransactionCategory,
} from "../integrations/openrouter";
import { FieldCipher } from "../lib/crypto";

function cookieJar(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";", 1);
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) result[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return result;
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function authenticatedOwner(
  application: BetterWealthApplication,
  email: string,
  password: string,
) {
  const registration = await application.app.request("/api/v1/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ email, password, householdName: `${email} plan` }),
  });
  expect(registration.status).toBe(201);
  const identity = (await registration.json()) as { userId: string; householdId: string };
  const login = await application.app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  const auth = (await login.json()) as { csrfToken: string };
  return {
    ...identity,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      cookie: cookieHeader(cookieJar(login)),
      "x-csrf-token": auth.csrfToken,
    },
  };
}

async function insertAiSuggestion(
  application: BetterWealthApplication,
  input: {
    householdId: string;
    ownerUserId: string | null;
    categoryId: string;
    description?: string;
  },
) {
  const accountId = ulid();
  const transactionId = ulid();
  const suggestionId = ulid();
  const description = input.description ?? "TST* MYSTERY CAFE 0812";
  await application.db.insert(accounts).values({
    id: accountId,
    householdId: input.householdId,
    ownerUserId: input.ownerUserId,
    name: "Checking",
    group: "cash",
    type: "checking",
    currency: "USD",
    isLiability: false,
    isManual: true,
  });
  await application.db.insert(transactions).values({
    id: transactionId,
    householdId: input.householdId,
    accountId,
    amount: -2_245n,
    currency: "USD",
    transactedOn: "2026-07-16",
    postedAt: "2026-07-16T12:00:00.000Z",
    rawDescription: description,
    normalizedDescription: description,
    status: "posted",
    source: "manual",
    reviewState: "needs_review",
  });
  await application.db.insert(aiSuggestions).values({
    id: suggestionId,
    householdId: input.householdId,
    transactionId,
    inputFingerprint: `test-${suggestionId}`,
    suggestedMerchantName: "Mystery Cafe",
    suggestedCategoryId: input.categoryId,
    proposedRule: { descriptionContains: "MYSTERY CAFE", direction: "outflow" },
    confidenceBps: 5_500,
    rationale: "The original proposal was uncertain",
    status: "rejected",
    model: "test/old-model",
  });
  return { accountId, transactionId, suggestionId };
}

describe("per-user integration settings", () => {
  let directory: string;
  let application: BetterWealthApplication;
  let regenerateImplementation: typeof regenerateTransactionCategory;
  let regenerationInputs: Parameters<typeof regenerateTransactionCategory>[0][];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-integrations-"));
    regenerationInputs = [];
    regenerateImplementation = async () => {
      throw new Error("Unexpected AI regeneration call");
    };
    application = createApp(
      loadConfig({
        APP_ENV: "test",
        API_HOST: "127.0.0.1",
        API_PORT: "3001",
        WEB_ORIGIN: "http://localhost:5173",
        DATABASE_URL: join(directory, "test.sqlite"),
        ENCRYPTION_KEY: "b".repeat(64),
        COOKIE_SECURE: "false",
        REGISTRATION_MODE: "open",
        OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
        BOOTSTRAP_OPENROUTER_MODEL: "test/default",
        LOG_LEVEL: "error",
      }),
      {
        integrations: {
          regenerateTransactionCategory: async (input) => {
            regenerationInputs.push(input);
            return regenerateImplementation(input);
          },
        },
      },
    );
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("encrypts an AI key, preserves it on edits, and never returns it", async () => {
    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "owner@example.com",
        password: "OwnerStrong!2026",
        householdName: "Owner plan",
      }),
    });
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "owner@example.com", password: "OwnerStrong!2026" }),
    });
    const auth = (await login.json()) as { csrfToken: string };
    const cookies = cookieJar(login);
    const mutationHeaders = {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      cookie: cookieHeader(cookies),
      "x-csrf-token": auth.csrfToken,
    };
    const syntheticKey = "sk-test-never-store-in-plaintext";

    const absent = await application.app.request("/api/v1/settings/integrations/ai", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(await absent.json()).toMatchObject({
      configured: false,
      webResearchEnabled: false,
    });

    const untrusted = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        enabled: true,
        consent: true,
        baseUrl: "https://rebinding.attacker.example/v1",
        model: "test/unsafe",
        apiKey: syntheticKey,
        confidenceThreshold: 0.91,
        webResearchEnabled: true,
      }),
    });
    expect(untrusted.status).toBe(400);
    expect(await untrusted.json()).toMatchObject({ error: { code: "ai_host_not_allowed" } });

    const configured = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        enabled: true,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/first",
        apiKey: syntheticKey,
        confidenceThreshold: 0.91,
        webResearchEnabled: true,
      }),
    });
    expect(configured.status).toBe(200);
    const configuredBody = await configured.json();
    expect(configuredBody).toMatchObject({
      configured: true,
      enabled: true,
      model: "test/first",
      confidenceThreshold: 0.91,
      webResearchEnabled: true,
    });
    expect(configuredBody).not.toHaveProperty("apiKey");

    const stored = await application.db.select().from(settings);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]?.value)).not.toContain(syntheticKey);
    expect(stored[0]?.isSecret).toBe(true);

    const edited = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        enabled: false,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/second",
        confidenceThreshold: 0.95,
        webResearchEnabled: true,
      }),
    });
    expect(edited.status).toBe(200);

    const fetched = await application.app.request("/api/v1/settings/integrations/ai", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(fetched.status).toBe(200);
    const fetchedBody = await fetched.json();
    expect(fetchedBody).toEqual({
      configured: true,
      enabled: false,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "test/second",
      confidenceThreshold: 0.95,
      webResearchEnabled: true,
    });
    expect(JSON.stringify(fetchedBody)).not.toContain(syntheticKey);

    const toggled = await application.app.request("/api/v1/settings/integrations", {
      method: "PATCH",
      headers: mutationHeaders,
      body: JSON.stringify({
        ai: {
          enabled: true,
          model: "test/third",
          consentedFields: ["normalized_description", "direction", "coarse_amount"],
        },
      }),
    });
    expect(toggled.status).toBe(200);
    const afterToggle = await application.app.request("/api/v1/settings/integrations/ai", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(await afterToggle.json()).toMatchObject({
      enabled: true,
      model: "test/third",
      webResearchEnabled: true,
    });
  });

  test("refuses to enable AI without explicit consent fields or a user-configured key", async () => {
    const owner = await authenticatedOwner(
      application,
      "consent-explicit@example.com",
      "ConsentExplicit!2026",
    );

    // No key configured at all: even with consent fields there is nothing to enable.
    const noKey = await application.app.request("/api/v1/settings/integrations", {
      method: "PATCH",
      headers: owner.headers,
      body: JSON.stringify({
        ai: { enabled: true, consentedFields: ["normalized_description"] },
      }),
    });
    expect(noKey.status).toBe(404);

    const configured = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: owner.headers,
      body: JSON.stringify({
        enabled: false,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/consent",
        apiKey: "sk-test-consent-explicit",
        confidenceThreshold: 0.9,
        webResearchEnabled: false,
      }),
    });
    expect(configured.status).toBe(200);

    // Key configured, but enabling without the explicit field list fails closed.
    const noConsent = await application.app.request("/api/v1/settings/integrations", {
      method: "PATCH",
      headers: owner.headers,
      body: JSON.stringify({ ai: { enabled: true } }),
    });
    expect(noConsent.status).toBe(400);
    expect(await noConsent.json()).toMatchObject({ error: { code: "ai_consent_required" } });
    const stillDisabled = await application.app.request("/api/v1/settings/integrations/ai", {
      headers: owner.headers,
    });
    expect(await stillDisabled.json()).toMatchObject({ enabled: false });

    const enabled = await application.app.request("/api/v1/settings/integrations", {
      method: "PATCH",
      headers: owner.headers,
      body: JSON.stringify({
        ai: { enabled: true, consentedFields: ["normalized_description", "coarse_amount"] },
      }),
    });
    expect(enabled.status).toBe(200);
  });

  test("regenerates the same pending suggestion from bounded feedback with full category paths", async () => {
    const owner = await authenticatedOwner(
      application,
      "feedback@example.com",
      "FeedbackStrong!2026",
    );
    const food = await application.db
      .select({ id: categories.id, name: categories.name, kind: categories.kind })
      .from(categories)
      .where(eq(categories.householdId, owner.householdId))
      .then((rows) => rows.find(({ kind }) => kind === "expense"));
    if (!food) throw new Error("Expected a default expense category");
    const coffeeId = ulid();
    await application.db.insert(categories).values({
      id: coffeeId,
      householdId: owner.householdId,
      parentId: food.id,
      name: "Coffee shops",
      slug: "coffee-shops",
      kind: "expense",
      isActive: true,
      sortOrder: 100,
    });
    const fixture = await insertAiSuggestion(application, {
      householdId: owner.householdId,
      ownerUserId: owner.userId,
      categoryId: food.id,
    });
    const regenerate = (body: unknown) =>
      application.app.request(`/api/v1/ai/suggestions/${fixture.suggestionId}/regenerate`, {
        method: "POST",
        headers: owner.headers,
        body: JSON.stringify(body),
      });

    const tooShort = await regenerate({ feedback: " x " });
    expect(tooShort.status).toBe(422);
    const notConfigured = await regenerate({ feedback: "This is my neighborhood coffee shop" });
    expect(notConfigured.status).toBe(404);
    expect(regenerationInputs).toHaveLength(0);

    const configured = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: owner.headers,
      body: JSON.stringify({
        enabled: true,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/regenerator",
        apiKey: "sk-test-feedback-regeneration",
        confidenceThreshold: 0.9,
        webResearchEnabled: true,
      }),
    });
    expect(configured.status).toBe(200);
    regenerateImplementation = async () => ({
      merchant: "Mystery Cafe",
      categoryId: coffeeId,
      confidence: 0.98,
      rationale: "The user's correction and public merchant identity agree",
      proposedRule: { descriptionContains: "MYSTERY CAFE", direction: "outflow" },
      research: {
        requested: true,
        citationCount: 2,
        citationHosts: ["merchant.example", "directory.example"],
      },
    });
    const feedback = "  This is my neighborhood coffee shop, not a restaurant command.  ";
    const response = await regenerate({ feedback });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: fixture.suggestionId,
      transactionId: fixture.transactionId,
      merchant: "Mystery Cafe",
      categoryId: coffeeId,
      categoryName: "Coffee shops",
      categoryPath: [food.name, "Coffee shops"],
      confidence: 0.98,
      status: "pending",
      research: { requested: true, citationCount: 2 },
    });
    expect(regenerationInputs).toHaveLength(1);
    const disclosed = regenerationInputs[0];
    expect(disclosed?.userFeedback).toBe(feedback.trim());
    expect(disclosed?.allowWebResearch).toBe(true);
    expect(disclosed?.transaction.amountBand).toBe("1000-2499 minor units");
    expect(JSON.stringify(disclosed)).not.toContain('"amount":-2245');
    expect(disclosed?.categories).toContainEqual(
      expect.objectContaining({ id: coffeeId, path: expect.stringContaining("/ Coffee shops") }),
    );
    const stored = await application.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, fixture.suggestionId))
      .get();
    expect(stored).toMatchObject({
      id: fixture.suggestionId,
      suggestedCategoryId: coffeeId,
      confidenceBps: 9_800,
      status: "pending",
      model: "test/regenerator",
      reviewedAt: null,
      reviewedByUserId: null,
    });
    const audit = await application.db
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, fixture.suggestionId))
      .get();
    expect(audit).toMatchObject({
      action: "ai.suggestion_regenerated",
      metadata: {
        feedbackLength: feedback.trim().length,
        regeneratedCategoryId: coffeeId,
        webCitationCount: 2,
      },
    });
    expect(JSON.stringify(audit)).not.toContain(feedback.trim());

    const approved = await application.app.request(
      `/api/v1/ai/suggestions/${fixture.suggestionId}`,
      {
        method: "PATCH",
        headers: owner.headers,
        body: JSON.stringify({ status: "accepted", createRule: true }),
      },
    );
    expect(approved.status).toBe(200);
    const savedRule = await application.db
      .select()
      .from(rules)
      .where(eq(rules.householdId, owner.householdId))
      .get();
    expect(savedRule?.conditions).toMatchObject({
      all: expect.arrayContaining([
        expect.objectContaining({
          field: "normalizedDescription",
          operator: "contains",
          value: "MYSTERY CAFE",
        }),
      ]),
    });
    expect(JSON.stringify(savedRule?.actions)).toContain(coffeeId);
  });

  test("materializes and case-insensitively deduplicates proposed top-level and child categories", async () => {
    const owner = await authenticatedOwner(
      application,
      "taxonomy@example.com",
      "TaxonomyStrong!2026",
    );
    const food = await application.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.householdId, owner.householdId))
      .then((rows) => rows[0]);
    if (!food) throw new Error("Expected default categories");
    const fixture = await insertAiSuggestion(application, {
      householdId: owner.householdId,
      ownerUserId: owner.userId,
      categoryId: food.id,
      description: "ACME PRO MONTHLY",
    });
    const configured = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: owner.headers,
      body: JSON.stringify({
        enabled: true,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/taxonomy",
        apiKey: "sk-test-taxonomy-regeneration",
        confidenceThreshold: 0.9,
        webResearchEnabled: false,
      }),
    });
    expect(configured.status).toBe(200);
    let result: RegeneratedCategorizationSuggestion = {
      merchant: "Acme Pro",
      proposedCategory: {
        topLevelName: "Subscriptions",
        childName: null,
        kind: "expense",
      },
      confidence: 0.96,
      rationale: "No existing category path is suitable",
      research: { requested: false, citationCount: 0, citationHosts: [] },
    };
    regenerateImplementation = async () => result;
    const request = async (feedback: string) => {
      const response = await application.app.request(
        `/api/v1/ai/suggestions/${fixture.suggestionId}/regenerate`,
        {
          method: "POST",
          headers: owner.headers,
          body: JSON.stringify({ feedback }),
        },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { categoryId: string; categoryPath: string[] };
    };
    const topLevel = await request("This is software I subscribe to every month");
    expect(topLevel.categoryPath).toEqual(["Subscriptions"]);
    expect(regenerationInputs[0]?.allowWebResearch).toBe(false);
    result = {
      ...result,
      proposedCategory: {
        topLevelName: " subscriptions ",
        childName: null,
        kind: "expense",
      },
    };
    const duplicateTopLevel = await request("Use the subscriptions category you just created");
    expect(duplicateTopLevel.categoryId).toBe(topLevel.categoryId);
    result = {
      ...result,
      proposedCategory: {
        topLevelName: "SUBSCRIPTIONS",
        childName: "Software",
        kind: "expense",
      },
    };
    const child = await request("More specifically this is a software subscription");
    expect(child.categoryPath).toEqual(["Subscriptions", "Software"]);
    result = {
      ...result,
      proposedCategory: {
        topLevelName: "subscriptions",
        childName: " software ",
        kind: "expense",
      },
    };
    const duplicateChild = await request("Keep this in the same software subcategory");
    expect(duplicateChild.categoryId).toBe(child.categoryId);
    const created = await application.db
      .select({ name: categories.name, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.householdId, owner.householdId));
    expect(
      created.filter(({ name }) => name.toLocaleLowerCase("en-US") === "subscriptions"),
    ).toHaveLength(1);
    expect(
      created.filter(({ name }) => name.toLocaleLowerCase("en-US") === "software"),
    ).toHaveLength(1);
    expect(regenerationInputs.at(-1)?.categories).toContainEqual(
      expect.objectContaining({ id: child.categoryId, path: "Subscriptions / Software" }),
    );
  });

  test("does not disclose another user's suggestion to the configured reviewer", async () => {
    const owner = await authenticatedOwner(
      application,
      "reviewer@example.com",
      "ReviewerStrong!2026",
    );
    const otherRegistration = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "other-owner@example.com",
        password: "OtherOwnerStrong!2026",
        householdName: "Other plan",
      }),
    });
    const other = (await otherRegistration.json()) as { userId: string };
    const category = await application.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.householdId, owner.householdId))
      .then((rows) => rows[0]);
    if (!category) throw new Error("Expected default categories");
    const fixture = await insertAiSuggestion(application, {
      householdId: owner.householdId,
      ownerUserId: other.userId,
      categoryId: category.id,
    });
    const response = await application.app.request(
      `/api/v1/ai/suggestions/${fixture.suggestionId}/regenerate`,
      {
        method: "POST",
        headers: owner.headers,
        body: JSON.stringify({ feedback: "This belongs to the other account owner" }),
      },
    );
    expect(response.status).toBe(404);
    expect(regenerationInputs).toHaveLength(0);
  });

  test("does not disclose another user's transaction for on-demand suggestions", async () => {
    const owner = await authenticatedOwner(
      application,
      "ondemand@example.com",
      "OnDemandStrong!2026",
    );
    const otherRegistration = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "ondemand-other@example.com",
        password: "OnDemandOther!2026",
        householdName: "Other plan",
      }),
    });
    const other = (await otherRegistration.json()) as { userId: string };
    const category = await application.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.householdId, owner.householdId))
      .then((rows) => rows[0]);
    if (!category) throw new Error("Expected default categories");
    const fixture = await insertAiSuggestion(application, {
      householdId: owner.householdId,
      ownerUserId: other.userId,
      categoryId: category.id,
    });
    const configured = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: owner.headers,
      body: JSON.stringify({
        enabled: true,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/on-demand",
        apiKey: "sk-test-on-demand-scope",
        confidenceThreshold: 0.9,
        webResearchEnabled: false,
      }),
    });
    expect(configured.status).toBe(200);

    // The requester has AI configured and consenting, but the transaction belongs
    // to a different account owner, so the route fails closed with a 404.
    const foreign = await application.app.request(
      `/api/v1/ai/suggestions/transactions/${fixture.transactionId}`,
      { method: "POST", headers: owner.headers },
    );
    expect(foreign.status).toBe(404);

    const accountId = ulid();
    const ownTransactionId = ulid();
    await application.db.insert(accounts).values({
      id: accountId,
      householdId: owner.householdId,
      ownerUserId: null,
      name: "Ownerless household account",
      group: "cash",
      type: "checking",
      currency: "USD",
      isLiability: false,
      isManual: true,
    });
    await application.db.insert(transactions).values({
      id: ownTransactionId,
      householdId: owner.householdId,
      accountId,
      amount: -1_000n,
      currency: "USD",
      transactedOn: "2026-07-16",
      rawDescription: "SHARED ACCOUNT PURCHASE",
      normalizedDescription: "SHARED ACCOUNT PURCHASE",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });

    // Ownerless/shared accounts fail closed too — the batch path applies the
    // same rule because there is no household-wide disclosure consent yet.
    const ownerless = await application.app.request(
      `/api/v1/ai/suggestions/transactions/${ownTransactionId}`,
      { method: "POST", headers: owner.headers },
    );
    expect(ownerless.status).toBe(404);
  });

  test("queues active and degraded SimpleFIN connections while excluding blocked states", async () => {
    const registration = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "sync@example.com",
        password: "SyncAllStrong!2026",
        householdName: "Sync plan",
      }),
    });
    const identity = (await registration.json()) as { userId: string; householdId: string };
    const repositories = createHouseholdRepositories(application.db, identity.householdId);
    const cipher = new FieldCipher("b".repeat(64));
    const connectionFixtures = [
      { id: ulid(), status: "active" as const },
      { id: ulid(), status: "degraded" as const },
      { id: ulid(), status: "reauth_required" as const },
      { id: ulid(), status: "disabled" as const },
    ];
    for (const [index, connection] of connectionFixtures.entries()) {
      const { id } = connection;
      const aad = `connection:${id}:credentials`;
      repositories.connections.create({
        id,
        ownerUserId: identity.userId,
        provider: "simplefin",
        displayName: `SimpleFIN ${index + 1}`,
        encryptedCredentials: cipher.encrypt(
          `https://user:password@bridge.example.test/simplefin-${index + 1}`,
          aad,
        ),
        credentialsAad: aad,
        capabilities: ["accounts", "balances", "transactions"],
        status: connection.status,
      });
    }
    const retryableConnectionIds = connectionFixtures
      .filter(({ status }) => status === "active" || status === "degraded")
      .map(({ id }) => id);
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "sync@example.com", password: "SyncAllStrong!2026" }),
    });
    const auth = (await login.json()) as { csrfToken: string };
    const cookies = cookieJar(login);
    const sync = () =>
      application.app.request("/api/v1/sync-runs", {
        method: "POST",
        headers: {
          cookie: cookieHeader(cookies),
          origin: "http://localhost:5173",
          "x-csrf-token": auth.csrfToken,
          "idempotency-key": "sync-all-test",
        },
      });

    const first = await sync();
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      syncRunIds: string[];
      state: string;
    };
    expect(firstBody.syncRunIds).toHaveLength(2);
    expect(firstBody.state).toBe("queued");
    const queued = await application.db.select().from(jobs);
    expect(queued).toHaveLength(2);
    expect(new Set(queued.map((job) => job.id))).toEqual(new Set(firstBody.syncRunIds));
    expect(
      new Set(queued.map((job) => (job.payload as { connectionId: string }).connectionId)),
    ).toEqual(new Set(retryableConnectionIds));

    const repeated = await sync();
    expect(repeated.status).toBe(202);
    const repeatedBody = (await repeated.json()) as { syncRunIds: string[] };
    expect(new Set(repeatedBody.syncRunIds)).toEqual(new Set(firstBody.syncRunIds));
    expect(await application.db.select().from(jobs)).toHaveLength(2);
  });
});
