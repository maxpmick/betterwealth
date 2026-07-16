import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
  assets,
  assetValuations,
  bills,
  budgetPeriods,
  closeDatabase,
  envelopeAllocations,
  forecastRuns,
  forecastScenarios,
  goals,
  openDatabase,
  rules,
  runMigrations,
  settings,
  transactions,
  users,
} from "@betterwealth/db";
import { ALEX_IDS, alexFixture, fixtureUlid } from "@betterwealth/testkit";
import { eq } from "drizzle-orm";
import { ALEX_DEMO_EMAIL, ALEX_DEMO_PASSWORD, seedCanonicalAlex } from "./canonical-alex";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

function database() {
  const db = openDatabase(":memory:", { wal: false });
  runMigrations(db);
  databases.push(db);
  return db;
}

describe("canonical Alex seed", () => {
  test("is idempotent and creates a login backed by the full planning story", async () => {
    const db = database();
    const first = await seedCanonicalAlex(db);
    const second = await seedCanonicalAlex(db);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      userId: ALEX_IDS.user,
      householdId: ALEX_IDS.household,
      email: ALEX_DEMO_EMAIL,
      accountCount: 6,
      transactionCount: 9,
      envelopeCount: 8,
      billCount: 3,
      ruleCount: 3,
      goalCount: 4,
      assetCount: 1,
      scenarioCount: 3,
    });

    const user = await db.select().from(users).where(eq(users.id, ALEX_IDS.user)).get();
    expect(user?.displayName).toBe("Alex Rivera");
    expect(user?.birthDate).toBe("2004-08-15");
    expect(await Bun.password.verify(ALEX_DEMO_PASSWORD, user?.passwordHash ?? "")).toBe(true);

    expect(await db.select().from(accounts)).toHaveLength(6);
    expect(await db.select().from(transactions)).toHaveLength(9);
    expect(await db.select().from(goals)).toHaveLength(4);
    expect(await db.select().from(bills)).toHaveLength(3);
    expect(await db.select().from(rules)).toHaveLength(3);
    expect(await db.select().from(assets)).toHaveLength(1);
    expect(await db.select().from(assetValuations)).toHaveLength(3);
    expect(await db.select().from(forecastScenarios)).toHaveLength(3);
    expect(await db.select().from(forecastRuns)).toHaveLength(3);
    expect(await db.select().from(budgetPeriods)).toHaveLength(1);
    expect(await db.select().from(envelopeAllocations)).toHaveLength(8);

    const safeToSpendSetting = await db
      .select()
      .from(settings)
      .where(eq(settings.key, "planning.safe_to_spend"))
      .get();
    expect(safeToSpendSetting?.value).toEqual({
      spendableAccountIds: [ALEX_IDS.checking],
      minimumBufferMinorUnits: "100000",
      reservedBillsMinorUnits: "145000",
      envelopeCommitmentMinorUnits: "50000",
      goalContributionMinorUnits: "30000",
      targetLiquidNetWorthMinorUnits: "25000000",
    });

    const baselineRun = await db
      .select()
      .from(forecastRuns)
      .where(eq(forecastRuns.scenarioId, fixtureUlid(700)))
      .get();
    const output = baselineRun?.outputs as
      | { months?: Array<{ netWorth?: { minorUnits?: string } }> }
      | undefined;
    expect(output?.months?.at(-1)?.netWorth?.minorUnits).toBe(
      alexFixture.expected.age30NetWorth.minorUnits,
    );
  });
});
