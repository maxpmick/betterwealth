import {
  closeDatabase,
  householdMembers,
  households,
  openDatabase,
  runMigrations,
  settings,
  transactions,
  users,
} from "@betterwealth/db";
import { aiSuggestions, rules } from "@betterwealth/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { resetHouseholdCategorization } from "../categorization/reset";
import { categorizeHouseholdTransactions } from "../categorization/service";
import { ensureStarterTaxonomy } from "../categorization/taxonomy";
import { loadConfig } from "../config";
import {
  assertTrustedAiBaseUrl,
  suggestTransactionCategory,
  verifyTransactionCategorization,
} from "../integrations/openrouter";
import { FieldCipher } from "../lib/crypto";
import { parseRecategorizeArgs } from "./recategorize-options";

function assertVerifiedAiConfiguration(input: {
  encryptedValue: unknown;
  encryptionKey: string;
  householdId: string;
  userId: string;
}) {
  const wrapper = z.object({ encrypted: z.string() }).parse(input.encryptedValue);
  const plaintext = new FieldCipher(input.encryptionKey).decrypt(
    wrapper.encrypted,
    `settings:${input.householdId}:${input.userId}:openrouter`,
  );
  const configured = z
    .object({
      enabled: z.literal(true),
      consent: z.literal(true),
      baseUrl: z.string().url(),
      model: z.string().min(1),
      apiKey: z.string().min(10),
      webResearchEnabled: z.boolean(),
    })
    .passthrough()
    .parse(JSON.parse(plaintext));
  const baseUrl = assertTrustedAiBaseUrl(configured.baseUrl);
  if (baseUrl.hostname.toLowerCase() !== "openrouter.ai") {
    throw new Error("Verified rebuild requires the OpenRouter base URL for server-side web search");
  }
  return configured;
}

async function assertProviderAndWebVerifierReady(configured: {
  apiKey: string;
  baseUrl: string;
  model: string;
}) {
  // Use only synthetic, public context. This proves the configured model/key can both produce
  // valid JSON and complete an actual OpenRouter web-grounded verification before any live state
  // is cleared.
  const categories = [
    { id: "preflight-income", name: "Income", path: "Income" },
    { id: "preflight-technology", name: "Technology", path: "Expenses / Technology" },
    { id: "preflight-transfer", name: "Transfer", path: "Transfer" },
    { id: "preflight-debt", name: "Debt", path: "Debt" },
    { id: "preflight-investment", name: "Investment", path: "Investment" },
  ];
  const transaction = {
    normalizedDescription: "OPENROUTER AI API CREDITS",
    direction: "outflow" as const,
    amountBand: "2500-4999 minor units",
    currency: "USD",
    accountType: "checking",
  };
  const firstPass = await suggestTransactionCategory({
    ...configured,
    transaction,
    categories,
  });
  const verified = await verifyTransactionCategorization({
    ...configured,
    transaction,
    categories,
    previousSuggestion: firstPass,
    allowCategoryProposal: true,
  });
  // Server-side web search is unavailable for some models (e.g. MiniMax M3); in that case the
  // provider layer retries without the tool and the verification runs as an independent recheck.
  if (verified.research.requested && verified.research.citationHosts.length < 1) {
    throw new Error(
      "The configured model did not complete a cited merchant web search; no reset was applied",
    );
  }
  return { webResearchUsed: verified.research.requested };
}

const options = parseRecategorizeArgs(process.argv.slice(2));
if (options.help) {
  console.log(
    [
      "BetterWealth verified categorization rebuild",
      "",
      "  bun run recategorize --dry-run --user-email <email>",
      "  bun run recategorize --preflight-only --user-email <email>",
      "  bun run recategorize --apply --user-email <email>",
      "  bun run recategorize --resume --user-email <email>",
      "",
      "Apply clears the selected household's categorization/rules, then rebuilds them.",
      "Resume continues a previously reset rebuild without deleting any current state.",
      "A per-user OpenRouter configuration is required. Merchant web research is used when the",
      "model supports it; otherwise verification runs as an independent recheck.",
      "Create a SQLite backup before using --apply.",
      "",
      "Options:",
      "  --dry-run              Preview reset impact only (default)",
      "  --preflight-only       Verify model/key/verification path without changing data",
      "  --apply                Apply reset and verified rebuild",
      "  --resume               Continue verified rebuild without resetting",
      "  --batches <1-100>      Maximum bounded batches (default 40)",
      "  --ai-limit <1-50>      First-pass calls per batch (default 25)",
      "  --user-email <email>   Explicit active owner/admin target",
      "  --household <id>       Explicit active household target",
    ].join("\n"),
  );
  process.exit(0);
}
const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  runMigrations(db);
  const normalizedEmail =
    options.userEmail ?? config.BOOTSTRAP_USER_EMAIL?.trim().toLowerCase() ?? undefined;
  const conditions = [
    eq(users.status, "active"),
    eq(households.status, "active"),
    eq(householdMembers.status, "active"),
    inArray(householdMembers.role, ["owner", "admin"]),
  ];
  if (normalizedEmail) conditions.push(eq(users.normalizedEmail, normalizedEmail));
  if (options.householdId) conditions.push(eq(households.id, options.householdId));
  const targets = await db
    .select({ userId: users.id, householdId: households.id })
    .from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(...conditions))
    .orderBy(asc(users.normalizedEmail), asc(households.id));
  if (targets.length !== 1) {
    throw new Error(
      targets.length === 0
        ? "No active owner/admin target matched the explicit selection"
        : "Target is ambiguous; pass --user-email and --household to select exactly one household",
    );
  }
  const target = targets[0];
  if (!target) throw new Error("The selected categorization target disappeared");
  const storedAi = await db
    .select({ value: settings.value, isSecret: settings.isSecret })
    .from(settings)
    .where(
      and(
        eq(settings.householdId, target.householdId),
        eq(settings.scopeKey, target.userId),
        eq(settings.key, "integration.openrouter"),
      ),
    )
    .get();
  if (!storedAi?.isSecret) {
    throw new Error("Verified rebuild requires a configured per-user AI integration");
  }
  const configuredAi = assertVerifiedAiConfiguration({
    encryptedValue: storedAi.value,
    encryptionKey: config.ENCRYPTION_KEY,
    householdId: target.householdId,
    userId: target.userId,
  });

  let preflight: { webResearchUsed: boolean } | undefined;
  if (options.mode !== "dry-run") {
    preflight = await assertProviderAndWebVerifierReady(configuredAi);
  }

  if (options.mode === "preflight-only") {
    console.log(
      JSON.stringify(
        {
          preflight: "verified",
          webResearchUsed: preflight?.webResearchUsed ?? false,
          reset: "not_applied",
        },
        null,
        2,
      ),
    );
  } else {
    const reset =
      options.mode === "resume"
        ? ("not_applied_resume" as const)
        : await resetHouseholdCategorization({
            db,
            householdId: target.householdId,
            userId: target.userId,
            apply: options.mode === "apply",
          });
    if (options.mode === "dry-run") {
      console.log(JSON.stringify({ reset, rebuild: "not_applied" }, null, 2));
    } else {
      // Guarantee the hardcoded starter taxonomy before the model chooses from it.
      const taxonomy = await ensureStarterTaxonomy(db, target.householdId);
      const totals = {
        batches: 0,
        aiCalls: 0,
        verificationCalls: 0,
        verified: 0,
        verificationFailed: 0,
        citations: 0,
        categoriesCreated: 0,
        accepted: 0,
        pending: 0,
        failed: 0,
        deterministic: 0,
      };
      const citationHosts = new Set<string>();
      const attemptedFingerprints = new Set<string>();
      let stalledBatches = 0;
      for (let batch = 0; batch < options.batches; batch += 1) {
        const result = await categorizeHouseholdTransactions({
          db,
          config,
          householdId: target.householdId,
          userId: target.userId,
          aiLimit: options.aiLimit,
          attemptedFingerprints,
          retryInvalidSuggestions: options.mode === "resume",
        });
        totals.batches += 1;
        totals.aiCalls += result.aiCalls;
        totals.verificationCalls += result.aiVerificationCalls;
        totals.verified += result.aiVerified;
        totals.verificationFailed += result.aiVerificationFailed;
        totals.citations += result.aiResearchCitations;
        totals.categoriesCreated += result.aiCreatedCategories;
        totals.accepted += result.aiAccepted;
        totals.pending += result.aiPending;
        totals.failed += result.aiFailed;
        totals.deterministic += result.deterministic;
        for (const host of result.aiResearchHosts) citationHosts.add(host);
        const progress = result.deterministic + result.aiAccepted + result.aiPending;
        stalledBatches = progress === 0 ? stalledBatches + 1 : 0;
        if (result.aiCalls === 0 || stalledBatches >= 2) break;
      }
      const [categorized, pending, ruleCount, remainingReview] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(transactions)
          .where(
            and(
              eq(transactions.householdId, target.householdId),
              sql`${transactions.categoryId} IS NOT NULL`,
            ),
          )
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(aiSuggestions)
          .where(
            and(
              eq(aiSuggestions.householdId, target.householdId),
              eq(aiSuggestions.status, "pending"),
            ),
          )
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(rules)
          .where(eq(rules.householdId, target.householdId))
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(transactions)
          .where(
            and(
              eq(transactions.householdId, target.householdId),
              eq(transactions.reviewState, "needs_review"),
              eq(transactions.isTransfer, false),
            ),
          )
          .get(),
      ]);
      console.log(
        JSON.stringify(
          {
            reset,
            rebuild: {
              ...totals,
              webResearchUsed: preflight?.webResearchUsed ?? false,
              starterTaxonomyCreated: taxonomy.created,
              citationHosts: [...citationHosts].sort(),
              categorizedTransactions: Number(categorized?.count ?? 0),
              pendingHumanReview: Number(pending?.count ?? 0),
              rules: Number(ruleCount?.count ?? 0),
              remainingReviewTransactions: Number(remainingReview?.count ?? 0),
            },
          },
          null,
          2,
        ),
      );
    }
  }
} finally {
  closeDatabase(db);
}
