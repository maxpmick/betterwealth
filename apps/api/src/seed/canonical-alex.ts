import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  assets,
  assetValuations,
  balanceSnapshots,
  bills,
  budgetPeriods,
  categories,
  connections,
  envelopeAllocations,
  envelopeCategoryLinks,
  envelopeRuleLinks,
  envelopes,
  forecastRuns,
  forecastScenarios,
  goals,
  householdMembers,
  households,
  incomeSources,
  merchants,
  payCycles,
  providerInstitutions,
  rules,
  settings,
  transactions,
  transfers,
  users,
} from "@betterwealth/db/schema";
import {
  type ForecastScenario,
  forecastResultToJson,
  type RuleAction,
  type RuleCondition,
  ruleSpecificity,
  runForecast,
} from "@betterwealth/shared";
import {
  ALEX_IDS,
  alexAccounts,
  alexEnvelopes,
  alexFixture,
  alexForecastScenarios,
  alexGoals,
  alexTransactions,
  fixtureUlid,
} from "@betterwealth/testkit";
import { eq } from "drizzle-orm";

export const ALEX_DEMO_EMAIL = "alex@example.com";
export const ALEX_DEMO_PASSWORD = "WealthBy30!2026";

const FIXTURE_INSTITUTION_ID = fixtureUlid(4);
const INCOME_SOURCE_ID = fixtureUlid(200);
const PAY_CYCLE_ID = fixtureUlid(201);
const BUDGET_PERIOD_ID = fixtureUlid(202);
const UNCATEGORIZED_CATEGORY_ID = fixtureUlid(47);
const VEHICLE_ASSET_ID = fixtureUlid(900);
const FIXTURE_AS_OF = "2026-08-01T11:55:00.000Z";
const FIXTURE_CREATED_AT = "2026-08-01T12:00:00.000Z";

export interface AlexSeedResult {
  readonly userId: string;
  readonly householdId: string;
  readonly email: string;
  readonly accountCount: number;
  readonly transactionCount: number;
  readonly envelopeCount: number;
  readonly billCount: number;
  readonly ruleCount: number;
  readonly goalCount: number;
  readonly assetCount: number;
  readonly scenarioCount: number;
}

function accountGroup(type: (typeof alexAccounts)[number]["type"]) {
  switch (type) {
    case "checking":
    case "savings":
    case "cash":
      return "cash" as const;
    case "creditCard":
      return "credit" as const;
    case "loan":
    case "mortgage":
    case "otherLiability":
      return "loan" as const;
    case "investment":
    case "retirement":
      return "investment" as const;
    case "property":
      return "property" as const;
    case "vehicle":
      return "vehicle" as const;
    case "otherAsset":
      return "custom" as const;
  }
}

function rolloverPolicy(policy: (typeof alexEnvelopes)[number]["rolloverPolicy"]) {
  return policy === "full" ? ("all" as const) : policy;
}

function transactionStatus(status: (typeof alexTransactions)[number]["status"]) {
  if (status === "removedUpstream") return "removed" as const;
  if (status === "stale") return "void" as const;
  return status;
}

function goalStatus(status: (typeof alexGoals)[number]["status"]) {
  if (status === "achieved") return "completed" as const;
  if (status === "archived") return "cancelled" as const;
  return status;
}

function categoryDefinition(id: string) {
  const definitions: Record<
    string,
    {
      name: string;
      slug: string;
      kind: "income" | "expense" | "transfer" | "debt";
      color: string;
      icon: string;
    }
  > = {
    [ALEX_IDS.categoryIncome]: {
      name: "Income",
      slug: "income",
      kind: "income",
      color: "#1F9D72",
      icon: "payments",
    },
    [ALEX_IDS.categoryHousing]: {
      name: "Housing",
      slug: "housing",
      kind: "expense",
      color: "#4A7FD1",
      icon: "home",
    },
    [ALEX_IDS.categoryGroceries]: {
      name: "Groceries",
      slug: "groceries",
      kind: "expense",
      color: "#D98B2B",
      icon: "shopping_cart",
    },
    [ALEX_IDS.categoryDining]: {
      name: "Dining",
      slug: "dining",
      kind: "expense",
      color: "#C06A4A",
      icon: "restaurant",
    },
    [ALEX_IDS.categoryDebt]: {
      name: "Debt payments",
      slug: "debt-payments",
      kind: "debt",
      color: "#8B6CCF",
      icon: "credit_score",
    },
    [ALEX_IDS.categoryFitness]: {
      name: "Fitness",
      slug: "fitness",
      kind: "expense",
      color: "#DD625B",
      icon: "fitness_center",
    },
    [ALEX_IDS.categoryTransfer]: {
      name: "Transfers",
      slug: "transfers",
      kind: "transfer",
      color: "#6B7280",
      icon: "swap_horiz",
    },
    [UNCATEGORIZED_CATEGORY_ID]: {
      name: "Uncategorized",
      slug: "uncategorized",
      kind: "expense",
      color: "#8A9099",
      icon: "help_outline",
    },
  };
  const definition = definitions[id];
  if (!definition) throw new Error(`Missing Alex category definition for ${id}`);
  return definition;
}

function merchantDefinition(id: string) {
  const definitions: Record<string, { name: string; categoryId: string }> = {
    [ALEX_IDS.merchantEmployer]: { name: "Acme Digital", categoryId: ALEX_IDS.categoryIncome },
    [ALEX_IDS.merchantLandlord]: {
      name: "River Walk Apartments",
      categoryId: ALEX_IDS.categoryHousing,
    },
    [ALEX_IDS.merchantGrocer]: {
      name: "Fresh Market",
      categoryId: ALEX_IDS.categoryGroceries,
    },
    [ALEX_IDS.merchantCoffee]: { name: "Corner Coffee", categoryId: ALEX_IDS.categoryDining },
    [ALEX_IDS.merchantGym]: { name: "City Fit Club", categoryId: ALEX_IDS.categoryFitness },
  };
  const definition = definitions[id];
  if (!definition) throw new Error(`Missing Alex merchant definition for ${id}`);
  return definition;
}

function historicalBalance(accountId: string, ending: bigint, index: number): bigint {
  const starts: Record<string, bigint> = {
    [ALEX_IDS.checking]: 240_000n,
    [ALEX_IDS.savings]: 320_000n,
    [ALEX_IDS.brokerage]: 150_000n,
    [ALEX_IDS.retirement]: 520_000n,
    [ALEX_IDS.studentLoan]: -1_700_000n,
    [ALEX_IDS.creditCard]: -50_000n,
  };
  const starting = starts[accountId];
  if (starting === undefined) throw new Error(`Missing historical balance for ${accountId}`);
  return starting + ((ending - starting) * BigInt(index)) / 11n;
}

function fixtureAsOf(index: number): string {
  const dates = [
    "2025-09-01",
    "2025-10-01",
    "2025-11-01",
    "2025-12-01",
    "2026-01-01",
    "2026-02-01",
    "2026-03-01",
    "2026-04-01",
    "2026-05-01",
    "2026-06-01",
    "2026-07-01",
    "2026-08-01",
  ];
  return index === 11 ? FIXTURE_AS_OF : `${dates[index]}T11:55:00.000Z`;
}

function jsonSafeObject<T>(value: T): Record<string, unknown> {
  const parsed = JSON.parse(
    JSON.stringify(value, (_key, candidate) =>
      typeof candidate === "bigint" ? candidate.toString() : candidate,
    ),
  ) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function goalType(type: (typeof alexGoals)[number]["type"]) {
  switch (type) {
    case "emergencyFund":
      return "emergency_fund" as const;
    case "purchase":
      return "purchase" as const;
    case "debtFree":
      return "debt_payoff" as const;
    case "netWorth":
      return "investment_milestone" as const;
    default:
      return "custom" as const;
  }
}

function scenarioPreset(id: string) {
  if (id.includes("conservative")) return "conservative" as const;
  if (id.includes("accelerated")) return "ambitious" as const;
  return "baseline" as const;
}

function canonicalForecastScenario(scenario: ForecastScenario, index: number): ForecastScenario {
  const accountIds: Record<string, string> = {
    checking: ALEX_IDS.checking,
    emergency: ALEX_IDS.savings,
    brokerage: ALEX_IDS.brokerage,
    retirement: ALEX_IDS.retirement,
  };
  const accountId = (id: string) => {
    const mapped = accountIds[id];
    if (!mapped) throw new Error(`Missing canonical forecast account mapping for ${id}`);
    return mapped;
  };

  return {
    ...scenario,
    id: fixtureUlid(700 + index),
    primaryCashAccountId: accountId(scenario.primaryCashAccountId),
    accounts: scenario.accounts.map((account) => ({
      ...account,
      id: accountId(account.id),
    })),
    cashFlows: scenario.cashFlows.map((cashFlow, cashFlowIndex) => ({
      ...cashFlow,
      id: fixtureUlid(710 + cashFlowIndex),
      ...(cashFlow.accountId ? { accountId: accountId(cashFlow.accountId) } : {}),
    })),
    ...(scenario.debts
      ? {
          debts: scenario.debts.map((debt, debtIndex) => ({
            ...debt,
            id: debt.id === "student-loan" ? ALEX_IDS.studentLoan : fixtureUlid(730 + debtIndex),
            ...(debt.paymentAccountId
              ? { paymentAccountId: accountId(debt.paymentAccountId) }
              : {}),
          })),
        }
      : {}),
    ...(scenario.contributions
      ? {
          contributions: scenario.contributions.map((contribution, contributionIndex) => ({
            ...contribution,
            id: fixtureUlid(720 + contributionIndex),
            ...(contribution.fromAccountId
              ? { fromAccountId: accountId(contribution.fromAccountId) }
              : {}),
            toAccountId: accountId(contribution.toAccountId),
          })),
        }
      : {}),
  };
}

const BILL_FIXTURES = [
  {
    id: fixtureUlid(800),
    name: "River Walk rent",
    envelopeId: ALEX_IDS.envelopeRent,
    amountMin: 145_000n,
    amountMax: 145_000n,
    dueRule: { cadence: "monthly", dayOfMonth: 1, businessDayAdjustment: "none" },
    nextDueDate: "2026-09-01",
    confidenceBps: 10_000,
  },
  {
    id: fixtureUlid(801),
    name: "Electric and internet",
    envelopeId: ALEX_IDS.envelopeUtilities,
    amountMin: 18_000n,
    amountMax: 22_000n,
    dueRule: { cadence: "monthly", dayOfMonth: 20, businessDayAdjustment: "next" },
    nextDueDate: "2026-08-20",
    confidenceBps: 8_500,
  },
  {
    id: fixtureUlid(802),
    name: "Federal student loan payment",
    envelopeId: ALEX_IDS.envelopeDebt,
    amountMin: 55_000n,
    amountMax: 55_000n,
    dueRule: { cadence: "monthly", dayOfMonth: 29, businessDayAdjustment: "previous" },
    nextDueDate: "2026-08-29",
    confidenceBps: 10_000,
  },
] as const;

const RULE_FIXTURES: readonly {
  id: string;
  name: string;
  priority: number;
  origin: "user" | "system" | "ai";
  condition: RuleCondition;
  actions: readonly RuleAction[];
  matchCount: number;
  lastMatchedAt: string;
  envelopeId?: string;
}[] = [
  {
    id: fixtureUlid(820),
    name: "Payroll is income",
    priority: 1_000,
    origin: "system",
    condition: {
      all: [
        {
          field: "description",
          operator: "contains",
          value: "PAYROLL",
          caseSensitive: false,
        },
        { field: "direction", operator: "exact", value: "inflow" },
      ],
    },
    actions: [
      { type: "setCategory", categoryId: ALEX_IDS.categoryIncome },
      { type: "setFlag", flag: "income", value: true },
    ],
    matchCount: 12,
    lastMatchedAt: "2026-07-31T12:00:00.000Z",
  },
  {
    id: fixtureUlid(821),
    name: "River Walk is rent",
    priority: 900,
    origin: "user",
    condition: {
      field: "merchant",
      operator: "exact",
      value: "River Walk Apartments",
      caseSensitive: false,
    },
    actions: [
      { type: "setCategory", categoryId: ALEX_IDS.categoryHousing },
      { type: "setEnvelope", envelopeId: ALEX_IDS.envelopeRent },
    ],
    matchCount: 8,
    lastMatchedAt: "2026-08-01T12:00:00.000Z",
    envelopeId: ALEX_IDS.envelopeRent,
  },
  {
    id: fixtureUlid(822),
    name: "Fresh Market groceries",
    priority: 800,
    origin: "ai",
    condition: {
      field: "merchant",
      operator: "exact",
      value: "Fresh Market",
      caseSensitive: false,
    },
    actions: [
      { type: "setCategory", categoryId: ALEX_IDS.categoryGroceries },
      { type: "setEnvelope", envelopeId: ALEX_IDS.envelopeGroceries },
    ],
    matchCount: 6,
    lastMatchedAt: "2026-07-30T12:00:00.000Z",
    envelopeId: ALEX_IDS.envelopeGroceries,
  },
];

const SAFE_TO_SPEND_SETTING = {
  spendableAccountIds: [ALEX_IDS.checking],
  minimumBufferMinorUnits: "100000",
  reservedBillsMinorUnits: "145000",
  envelopeCommitmentMinorUnits: "50000",
  goalContributionMinorUnits: "30000",
  targetLiquidNetWorthMinorUnits: "25000000",
} as const;

/**
 * Seed the canonical age-22-to-30 story into a real database.
 *
 * Every row uses a stable fixture identity and an upsert, so rerunning the seed restores the
 * canonical facts without duplicating data. The disabled SimpleFIN connection intentionally holds
 * no usable credential and cannot make a network call.
 */
export async function seedCanonicalAlex(
  db: BetterWealthDatabase,
  options: { password?: string } = {},
): Promise<AlexSeedResult> {
  const password = options.password ?? ALEX_DEMO_PASSWORD;
  const existingEmailOwner = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.normalizedEmail, ALEX_DEMO_EMAIL))
    .get();
  if (existingEmailOwner && existingEmailOwner.id !== ALEX_IDS.user) {
    throw new Error(`${ALEX_DEMO_EMAIL} already belongs to a non-fixture user`);
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 4_096,
    timeCost: 2,
  });
  const now = FIXTURE_CREATED_AT;

  await db
    .insert(users)
    .values({
      id: ALEX_IDS.user,
      email: ALEX_DEMO_EMAIL,
      normalizedEmail: ALEX_DEMO_EMAIL,
      passwordHash,
      displayName: alexFixture.profile.name,
      birthDate: alexFixture.profile.birthDate,
      targetAge: alexFixture.profile.targetAge,
      status: "active",
      emailVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: ALEX_DEMO_EMAIL,
        normalizedEmail: ALEX_DEMO_EMAIL,
        passwordHash,
        displayName: alexFixture.profile.name,
        birthDate: alexFixture.profile.birthDate,
        targetAge: alexFixture.profile.targetAge,
        status: "active",
        emailVerifiedAt: now,
        updatedAt: now,
      },
    });
  await db
    .insert(households)
    .values({
      id: ALEX_IDS.household,
      name: "Alex's wealth plan",
      baseCurrency: alexFixture.profile.baseCurrency,
      locale: "en-US",
      timezone: alexFixture.profile.timezone,
      registrationPolicy: "open",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: households.id,
      set: {
        name: "Alex's wealth plan",
        baseCurrency: alexFixture.profile.baseCurrency,
        locale: "en-US",
        timezone: alexFixture.profile.timezone,
        registrationPolicy: "open",
        status: "active",
        updatedAt: now,
      },
    });
  await db
    .insert(householdMembers)
    .values({
      householdId: ALEX_IDS.household,
      userId: ALEX_IDS.user,
      role: "owner",
      status: "active",
      joinedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [householdMembers.householdId, householdMembers.userId],
      set: { role: "owner", status: "active", updatedAt: now },
    });
  await db
    .insert(settings)
    .values({
      id: fixtureUlid(950),
      householdId: ALEX_IDS.household,
      userId: null,
      scopeKey: "household",
      key: "planning.safe_to_spend",
      value: SAFE_TO_SPEND_SETTING,
      isSecret: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: settings.id,
      set: { value: SAFE_TO_SPEND_SETTING, isSecret: false, updatedAt: now },
    });

  const categoryIds = [
    ALEX_IDS.categoryIncome,
    ALEX_IDS.categoryHousing,
    ALEX_IDS.categoryGroceries,
    ALEX_IDS.categoryDining,
    ALEX_IDS.categoryDebt,
    ALEX_IDS.categoryFitness,
    ALEX_IDS.categoryTransfer,
    UNCATEGORIZED_CATEGORY_ID,
  ];
  for (const [sortOrder, id] of categoryIds.entries()) {
    const definition = categoryDefinition(id);
    await db
      .insert(categories)
      .values({
        id,
        householdId: ALEX_IDS.household,
        ...definition,
        isActive: true,
        isSystem: true,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: categories.id,
        set: { ...definition, isActive: true, isSystem: true, sortOrder, updatedAt: now },
      });
  }

  const merchantIds = [
    ALEX_IDS.merchantEmployer,
    ALEX_IDS.merchantLandlord,
    ALEX_IDS.merchantGrocer,
    ALEX_IDS.merchantCoffee,
    ALEX_IDS.merchantGym,
  ];
  for (const id of merchantIds) {
    const definition = merchantDefinition(id);
    await db
      .insert(merchants)
      .values({
        id,
        householdId: ALEX_IDS.household,
        name: definition.name,
        normalizedName: definition.name.toLowerCase(),
        defaultCategoryId: definition.categoryId,
        metadata: { fixture: "alex-age-22" },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: merchants.id,
        set: {
          name: definition.name,
          normalizedName: definition.name.toLowerCase(),
          defaultCategoryId: definition.categoryId,
          metadata: { fixture: "alex-age-22" },
          updatedAt: now,
        },
      });
  }

  await db
    .insert(connections)
    .values({
      id: ALEX_IDS.connection,
      householdId: ALEX_IDS.household,
      ownerUserId: ALEX_IDS.user,
      provider: "simplefin",
      displayName: "SimpleFIN demo snapshot",
      credentialsCiphertext: Buffer.from("disabled-demo-credential"),
      credentialsNonce: Buffer.alloc(12),
      credentialsAuthTag: Buffer.alloc(16),
      credentialsKeyVersion: "fixture-v1",
      credentialsAad: `connection:${ALEX_IDS.connection}:fixture`,
      status: "disabled",
      capabilities: ["accounts", "balances", "transactions", "pending"],
      lastAttemptAt: FIXTURE_AS_OF,
      lastSuccessAt: FIXTURE_AS_OF,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: connections.id,
      set: {
        displayName: "SimpleFIN demo snapshot",
        status: "disabled",
        capabilities: ["accounts", "balances", "transactions", "pending"],
        lastAttemptAt: FIXTURE_AS_OF,
        lastSuccessAt: FIXTURE_AS_OF,
        updatedAt: now,
      },
    });
  await db
    .insert(providerInstitutions)
    .values({
      id: FIXTURE_INSTITUTION_ID,
      householdId: ALEX_IDS.household,
      connectionId: ALEX_IDS.connection,
      externalId: "better-bank",
      name: "Better Bank",
      url: "https://example.invalid/better-bank",
      metadata: { fixture: true },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: providerInstitutions.id,
      set: { name: "Better Bank", metadata: { fixture: true }, updatedAt: now },
    });

  for (const account of alexAccounts) {
    const group = accountGroup(account.type);
    const isLiability = group === "credit" || group === "loan";
    await db
      .insert(accounts)
      .values({
        id: account.id,
        householdId: ALEX_IDS.household,
        connectionId: ALEX_IDS.connection,
        institutionId: FIXTURE_INSTITUTION_ID,
        externalId: `alex-${account.id}`,
        name: account.name,
        officialName: account.name,
        mask: account.mask,
        group,
        type: account.type,
        subtype: account.subtype,
        currency: account.currency,
        ownership: "individual",
        ownerUserId: ALEX_IDS.user,
        includeInNetWorth: account.includeInNetWorth,
        includeInBudget: account.includeInBudget,
        isLiability,
        isManual: false,
        status: "active",
        providerMetadata: { fixture: "alex-age-22" },
        lastReconciledAt: account.lastSyncedAt ?? FIXTURE_AS_OF,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })
      .onConflictDoUpdate({
        target: accounts.id,
        set: {
          name: account.name,
          officialName: account.name,
          mask: account.mask,
          group,
          type: account.type,
          subtype: account.subtype,
          currency: account.currency,
          ownership: "individual",
          ownerUserId: ALEX_IDS.user,
          includeInNetWorth: account.includeInNetWorth,
          includeInBudget: account.includeInBudget,
          isLiability,
          isManual: false,
          status: "active",
          providerMetadata: { fixture: "alex-age-22" },
          lastReconciledAt: account.lastSyncedAt ?? FIXTURE_AS_OF,
          updatedAt: account.updatedAt,
        },
      });

    const ending = BigInt(account.currentBalance.minorUnits);
    for (let index = 0; index < 12; index += 1) {
      const current = historicalBalance(account.id, ending, index);
      let available: bigint | null = null;
      if (account.id === ALEX_IDS.checking) available = current - 4_250n;
      if (account.id === ALEX_IDS.creditCard) available = 500_000n + current;
      if (index === 11 && account.availableBalance) {
        available = BigInt(account.availableBalance.minorUnits);
      }
      await db
        .insert(balanceSnapshots)
        .values({
          id: fixtureUlid(300 + alexAccounts.indexOf(account) * 20 + index),
          householdId: ALEX_IDS.household,
          accountId: account.id,
          ledgerBalance: current,
          currentBalance: current,
          availableBalance: available,
          currency: account.currency,
          asOf: fixtureAsOf(index),
          source: "provider",
          createdAt: fixtureAsOf(index),
        })
        .onConflictDoUpdate({
          target: balanceSnapshots.id,
          set: {
            ledgerBalance: current,
            currentBalance: current,
            availableBalance: available,
            currency: account.currency,
            asOf: fixtureAsOf(index),
            source: "provider",
          },
        });
    }
  }

  for (const envelope of alexEnvelopes) {
    const required = ["requiredBills", "coreLiving", "minimumDebt", "buffer"].includes(
      envelope.priorityClass,
    );
    await db
      .insert(envelopes)
      .values({
        id: envelope.id,
        householdId: ALEX_IDS.household,
        parentId: envelope.parentId,
        categoryId: envelope.categoryId,
        name: envelope.name,
        cadence: envelope.cadence,
        cadenceConfig: { anchor: "paycheck", priorityClass: envelope.priorityClass },
        rolloverPolicy: rolloverPolicy(envelope.rolloverPolicy),
        priority: envelope.priority,
        minimumAmount: BigInt(envelope.minimum.minorUnits),
        targetAmount: BigInt(envelope.target.minorUnits),
        currency: envelope.target.currency,
        isRequired: required,
        isActive: !envelope.archived,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: envelopes.id,
        set: {
          categoryId: envelope.categoryId,
          name: envelope.name,
          cadence: envelope.cadence,
          cadenceConfig: { anchor: "paycheck", priorityClass: envelope.priorityClass },
          rolloverPolicy: rolloverPolicy(envelope.rolloverPolicy),
          priority: envelope.priority,
          minimumAmount: BigInt(envelope.minimum.minorUnits),
          targetAmount: BigInt(envelope.target.minorUnits),
          currency: envelope.target.currency,
          isRequired: required,
          isActive: !envelope.archived,
          updatedAt: now,
        },
      });
    if (envelope.categoryId) {
      await db
        .insert(envelopeCategoryLinks)
        .values({
          householdId: ALEX_IDS.household,
          envelopeId: envelope.id,
          categoryId: envelope.categoryId,
          createdAt: now,
        })
        .onConflictDoNothing();
    }
  }

  await db
    .insert(incomeSources)
    .values({
      id: INCOME_SOURCE_ID,
      householdId: ALEX_IDS.household,
      name: "Acme Digital paycheck",
      merchantId: ALEX_IDS.merchantEmployer,
      accountId: ALEX_IDS.checking,
      cadence: "biweekly",
      cadenceConfig: { weekday: "Friday", anchorDate: "2026-07-31" },
      typicalAmount: 260_000n,
      currency: "USD",
      nextExpectedDate: "2026-08-14",
      variabilityBps: 0,
      isActive: true,
      detectionRule: { descriptionContains: "PAYROLL", direction: "inflow" },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: incomeSources.id,
      set: {
        typicalAmount: 260_000n,
        nextExpectedDate: "2026-08-14",
        isActive: true,
        updatedAt: now,
      },
    });
  await db
    .insert(payCycles)
    .values({
      id: PAY_CYCLE_ID,
      householdId: ALEX_IDS.household,
      incomeSourceId: INCOME_SOURCE_ID,
      startsOn: "2026-07-31",
      endsOn: "2026-08-13",
      expectedIncome: 260_000n,
      actualIncome: 260_000n,
      currency: "USD",
      status: "open",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: payCycles.id,
      set: {
        expectedIncome: 260_000n,
        actualIncome: 260_000n,
        status: "open",
        updatedAt: now,
      },
    });
  await db
    .insert(budgetPeriods)
    .values({
      id: BUDGET_PERIOD_ID,
      householdId: ALEX_IDS.household,
      payCycleId: PAY_CYCLE_ID,
      kind: "pay_cycle",
      startsOn: "2026-07-31",
      endsOn: "2026-08-13",
      currency: "USD",
      expectedIncome: 260_000n,
      actualIncome: 260_000n,
      status: "open",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: budgetPeriods.id,
      set: {
        expectedIncome: 260_000n,
        actualIncome: 260_000n,
        status: "open",
        updatedAt: now,
      },
    });
  for (const [index, envelope] of alexEnvelopes.entries()) {
    const activity = -BigInt(envelope.activity.minorUnits);
    await db
      .insert(envelopeAllocations)
      .values({
        id: fixtureUlid(220 + index),
        householdId: ALEX_IDS.household,
        budgetPeriodId: BUDGET_PERIOD_ID,
        envelopeId: envelope.id,
        planned: BigInt(envelope.planned.minorUnits),
        funded: BigInt(envelope.funded.minorUnits),
        activity,
        transferredIn: 0n,
        transferredOut: 0n,
        availableSnapshot: BigInt(envelope.available.minorUnits),
        currency: envelope.available.currency,
        calculatedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: envelopeAllocations.id,
        set: {
          planned: BigInt(envelope.planned.minorUnits),
          funded: BigInt(envelope.funded.minorUnits),
          activity,
          transferredIn: 0n,
          transferredOut: 0n,
          availableSnapshot: BigInt(envelope.available.minorUnits),
          calculatedAt: now,
          updatedAt: now,
        },
      });
  }

  for (const bill of BILL_FIXTURES) {
    await db
      .insert(bills)
      .values({
        id: bill.id,
        householdId: ALEX_IDS.household,
        name: bill.name,
        envelopeId: bill.envelopeId,
        autopayAccountId: ALEX_IDS.checking,
        dueRule: bill.dueRule,
        amountMin: bill.amountMin,
        amountMax: bill.amountMax,
        currency: "USD",
        recurrenceConfidenceBps: bill.confidenceBps,
        nextDueDate: bill.nextDueDate,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: bills.id,
        set: {
          name: bill.name,
          envelopeId: bill.envelopeId,
          autopayAccountId: ALEX_IDS.checking,
          dueRule: bill.dueRule,
          amountMin: bill.amountMin,
          amountMax: bill.amountMax,
          recurrenceConfidenceBps: bill.confidenceBps,
          nextDueDate: bill.nextDueDate,
          isRequired: true,
          isActive: true,
          updatedAt: now,
        },
      });
  }

  for (const transaction of alexTransactions) {
    const postedAt =
      transaction.status === "pending" ? null : `${transaction.postedDate}T12:00:00.000Z`;
    await db
      .insert(transactions)
      .values({
        id: transaction.id,
        householdId: ALEX_IDS.household,
        accountId: transaction.accountId,
        connectionId: ALEX_IDS.connection,
        externalId: transaction.externalId,
        amount: BigInt(transaction.amount.minorUnits),
        currency: transaction.amount.currency,
        authorizedAt: `${transaction.authorizedDate ?? transaction.postedDate}T10:00:00.000Z`,
        postedAt,
        transactedOn: transaction.postedDate,
        rawDescription: transaction.rawDescription,
        normalizedDescription: transaction.normalizedDescription,
        merchantId: transaction.merchantId,
        categoryId: transaction.categoryId,
        categoryOrigin: transaction.categoryId ? "user" : "none",
        envelopeId: transaction.envelopeId,
        status: transactionStatus(transaction.status),
        source: "provider",
        reviewState: transaction.needsReview ? "needs_review" : "reviewed",
        isExcluded: transaction.excludedFromBudget || transaction.excludedFromReports,
        isTransfer: transaction.isTransfer,
        isIncome: transaction.isIncome,
        note: transaction.note,
        providerMetadata: { fixture: "alex-age-22", source: "simplefin" },
        fingerprint: `alex-fixture:${transaction.id}`,
        firstSeenAt: transaction.createdAt,
        lastSeenAt: transaction.updatedAt,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
      })
      .onConflictDoUpdate({
        target: transactions.id,
        set: {
          amount: BigInt(transaction.amount.minorUnits),
          currency: transaction.amount.currency,
          authorizedAt: `${transaction.authorizedDate ?? transaction.postedDate}T10:00:00.000Z`,
          postedAt,
          transactedOn: transaction.postedDate,
          rawDescription: transaction.rawDescription,
          normalizedDescription: transaction.normalizedDescription,
          merchantId: transaction.merchantId,
          categoryId: transaction.categoryId,
          categoryOrigin: transaction.categoryId ? "user" : "none",
          envelopeId: transaction.envelopeId,
          status: transactionStatus(transaction.status),
          source: "provider",
          reviewState: transaction.needsReview ? "needs_review" : "reviewed",
          isExcluded: transaction.excludedFromBudget || transaction.excludedFromReports,
          isTransfer: transaction.isTransfer,
          isIncome: transaction.isIncome,
          note: transaction.note,
          providerMetadata: { fixture: "alex-age-22", source: "simplefin" },
          fingerprint: `alex-fixture:${transaction.id}`,
          lastSeenAt: transaction.updatedAt,
          updatedAt: transaction.updatedAt,
        },
      });
  }
  await db
    .insert(transfers)
    .values({
      id: ALEX_IDS.transfer,
      householdId: ALEX_IDS.household,
      outflowTransactionId: ALEX_IDS.txTransferOut,
      inflowTransactionId: ALEX_IDS.txTransferIn,
      confidenceBps: 10_000,
      status: "confirmed",
      matchedBy: "fingerprint",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: transfers.id,
      set: { confidenceBps: 10_000, status: "confirmed", updatedAt: now },
    });

  for (const rule of RULE_FIXTURES) {
    const conditions = rule.condition as Record<string, unknown>;
    const actions = rule.actions as unknown as Record<string, unknown>;
    await db
      .insert(rules)
      .values({
        id: rule.id,
        householdId: ALEX_IDS.household,
        name: rule.name,
        priority: rule.priority,
        isEnabled: true,
        origin: rule.origin,
        conditions,
        actions,
        specificityScore: ruleSpecificity(rule.condition),
        matchCount: rule.matchCount,
        lastMatchedAt: rule.lastMatchedAt,
        createdByUserId: ALEX_IDS.user,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: rules.id,
        set: {
          name: rule.name,
          priority: rule.priority,
          isEnabled: true,
          origin: rule.origin,
          conditions,
          actions,
          specificityScore: ruleSpecificity(rule.condition),
          matchCount: rule.matchCount,
          lastMatchedAt: rule.lastMatchedAt,
          updatedAt: now,
        },
      });
    if (rule.envelopeId) {
      await db
        .insert(envelopeRuleLinks)
        .values({
          householdId: ALEX_IDS.household,
          envelopeId: rule.envelopeId,
          ruleId: rule.id,
          createdAt: now,
        })
        .onConflictDoNothing();
    }
  }

  for (const goal of alexGoals) {
    const mappedType = goalType(goal.type);
    const linkedDebtAccountId = mappedType === "debt_payoff" ? ALEX_IDS.studentLoan : null;
    const fundingAccountId =
      mappedType === "investment_milestone"
        ? ALEX_IDS.brokerage
        : mappedType === "debt_payoff"
          ? ALEX_IDS.checking
          : ALEX_IDS.savings;
    await db
      .insert(goals)
      .values({
        id: goal.id,
        householdId: ALEX_IDS.household,
        name: goal.name,
        type: mappedType,
        targetAmount: BigInt(goal.targetAmount.minorUnits),
        fundedAmount: BigInt(goal.currentAmount.minorUnits),
        currency: goal.targetAmount.currency,
        targetDate: goal.targetDate,
        priority: goal.priority,
        fundingAccountId,
        linkedDebtAccountId,
        contributionPolicy: {
          cadence: "monthly",
          amount: goal.monthlyContribution,
          monthlyAmountMinorUnits: goal.monthlyContribution.minorUnits,
          automatic: false,
        },
        bufferPolicy: {
          kind: goal.bufferPolicy,
          customBuffer: goal.customBuffer,
        },
        liquidityConstraint:
          mappedType === "emergency_fund" || mappedType === "purchase"
            ? "cash"
            : mappedType === "investment_milestone"
              ? "investable"
              : "liquid",
        status: goalStatus(goal.status),
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      })
      .onConflictDoUpdate({
        target: goals.id,
        set: {
          name: goal.name,
          type: mappedType,
          targetAmount: BigInt(goal.targetAmount.minorUnits),
          fundedAmount: BigInt(goal.currentAmount.minorUnits),
          currency: goal.targetAmount.currency,
          targetDate: goal.targetDate,
          priority: goal.priority,
          fundingAccountId,
          linkedDebtAccountId,
          contributionPolicy: {
            cadence: "monthly",
            amount: goal.monthlyContribution,
            monthlyAmountMinorUnits: goal.monthlyContribution.minorUnits,
            automatic: false,
          },
          bufferPolicy: { kind: goal.bufferPolicy, customBuffer: goal.customBuffer },
          status: goalStatus(goal.status),
          updatedAt: goal.updatedAt,
        },
      });
  }

  await db
    .insert(assets)
    .values({
      id: VEHICLE_ASSET_ID,
      householdId: ALEX_IDS.household,
      name: "2019 Honda Civic",
      type: "vehicle",
      liquidityClass: "illiquid",
      currency: "USD",
      ownerUserId: ALEX_IDS.user,
      metadata: {
        year: 2019,
        make: "Honda",
        model: "Civic",
        valuationMethod: "manual fair-market estimate",
        reminderCadenceMonths: 3,
      },
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: assets.id,
      set: {
        name: "2019 Honda Civic",
        type: "vehicle",
        liquidityClass: "illiquid",
        currency: "USD",
        ownerUserId: ALEX_IDS.user,
        metadata: {
          year: 2019,
          make: "Honda",
          model: "Civic",
          valuationMethod: "manual fair-market estimate",
          reminderCadenceMonths: 3,
        },
        isActive: true,
        updatedAt: now,
      },
    });
  const vehicleValuations = [
    { id: fixtureUlid(901), valuedOn: "2026-01-01", amount: 1_050_000n, confidenceBps: 6_500 },
    { id: fixtureUlid(902), valuedOn: "2026-04-01", amount: 990_000n, confidenceBps: 7_000 },
    { id: fixtureUlid(903), valuedOn: "2026-07-01", amount: 950_000n, confidenceBps: 7_500 },
  ] as const;
  for (const valuation of vehicleValuations) {
    await db
      .insert(assetValuations)
      .values({
        id: valuation.id,
        householdId: ALEX_IDS.household,
        assetId: VEHICLE_ASSET_ID,
        amount: valuation.amount,
        currency: "USD",
        valuedOn: valuation.valuedOn,
        source: "manual",
        confidenceBps: valuation.confidenceBps,
        providerReference: "owner-estimate",
        metadata: { comparablesReviewed: true, fixture: "alex-age-22" },
        createdAt: `${valuation.valuedOn}T12:00:00.000Z`,
      })
      .onConflictDoUpdate({
        target: assetValuations.id,
        set: {
          amount: valuation.amount,
          valuedOn: valuation.valuedOn,
          confidenceBps: valuation.confidenceBps,
          metadata: { comparablesReviewed: true, fixture: "alex-age-22" },
        },
      });
  }

  for (const [index, scenario] of alexForecastScenarios.entries()) {
    const preset = scenarioPreset(scenario.id ?? "");
    const canonicalScenario = canonicalForecastScenario(scenario, index);
    const result = runForecast(canonicalScenario);
    const scenarioId = fixtureUlid(700 + index);
    const uiAssumptions =
      preset === "conservative"
        ? {
            incomeGrowth: 1,
            inflation: 3.5,
            investmentReturn: 4,
            cashYield: 2,
            monthlyInvesting: { minorUnits: "70000", currency: "USD" },
          }
        : preset === "ambitious"
          ? {
              incomeGrowth: 5,
              inflation: 2,
              investmentReturn: 8.5,
              cashYield: 4,
              monthlyInvesting: { minorUnits: "100000", currency: "USD" },
            }
          : {
              incomeGrowth: 3,
              inflation: 2.5,
              investmentReturn: 7,
              cashYield: 3.5,
              monthlyInvesting: { minorUnits: "85000", currency: "USD" },
            };
    const storedAssumptions = jsonSafeObject({
      scenario: canonicalScenario,
      uiAssumptions,
      monteCarlo: {
        assumptions: [
          {
            assetClass: "stocks",
            meanAnnualReturnBps: Math.round(uiAssumptions.investmentReturn * 100),
            annualVolatilityBps: 1_800,
          },
        ],
      },
    });
    await db
      .insert(forecastScenarios)
      .values({
        id: scenarioId,
        householdId: ALEX_IDS.household,
        name: scenario.name ?? `Alex ${preset} path`,
        preset,
        assumptions: storedAssumptions,
        seed: String(300_122 + index),
        horizonMonths: canonicalScenario.horizonMonths,
        reportingCurrency: canonicalScenario.baseCurrency,
        isBase: preset === "baseline",
        isActive: true,
        createdByUserId: ALEX_IDS.user,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: forecastScenarios.id,
        set: {
          name: scenario.name ?? `Alex ${preset} path`,
          preset,
          assumptions: storedAssumptions,
          seed: String(300_122 + index),
          horizonMonths: canonicalScenario.horizonMonths,
          reportingCurrency: canonicalScenario.baseCurrency,
          isBase: preset === "baseline",
          isActive: true,
          updatedAt: now,
        },
      });
    await db
      .insert(forecastRuns)
      .values({
        id: fixtureUlid(500 + index),
        householdId: ALEX_IDS.household,
        scenarioId,
        inputVersionHash: result.inputHash,
        engineVersion: result.engineVersion,
        state: "succeeded",
        runCount: 1,
        outputs: jsonSafeObject(forecastResultToJson(result)),
        readiness: {
          score: 92,
          missingInputs: ["Confirm the next credit-card statement"],
          confidenceLabel: "High",
        },
        startedAt: now,
        finishedAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: forecastRuns.id,
        set: {
          inputVersionHash: result.inputHash,
          engineVersion: result.engineVersion,
          state: "succeeded",
          runCount: 1,
          outputs: jsonSafeObject(forecastResultToJson(result)),
          readiness: {
            score: 92,
            missingInputs: ["Confirm the next credit-card statement"],
            confidenceLabel: "High",
          },
          startedAt: now,
          finishedAt: now,
        },
      });
  }

  return {
    userId: ALEX_IDS.user,
    householdId: ALEX_IDS.household,
    email: ALEX_DEMO_EMAIL,
    accountCount: alexAccounts.length,
    transactionCount: alexTransactions.length,
    envelopeCount: alexEnvelopes.length,
    billCount: BILL_FIXTURES.length,
    ruleCount: RULE_FIXTURES.length,
    goalCount: alexGoals.length,
    assetCount: 1,
    scenarioCount: alexForecastScenarios.length,
  };
}
