import { afterEach, expect, test } from "bun:test";
import { categories, closeDatabase, openDatabase, runMigrations } from "@betterwealth/db";
import { and, eq, isNull } from "drizzle-orm";
import { registerUser } from "../auth/service";
import { loadConfig } from "../config";
import { ensureStarterTaxonomy, listTaxonomyPaths, STARTER_CATEGORIES } from "./taxonomy";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

async function freshHousehold() {
  const db = openDatabase(":memory:", { wal: false });
  databases.push(db);
  runMigrations(db);
  const config = loadConfig({
    APP_ENV: "test",
    DATABASE_URL: ":memory:",
    ENCRYPTION_KEY: "a".repeat(64),
    WEB_ORIGIN: "http://localhost:5173",
    REGISTRATION_MODE: "open",
  });
  const registered = await registerUser(
    db,
    { email: "taxonomy@example.com", password: "StarterTaxonomy!2026", householdName: "Taxonomy" },
    config,
  );
  return { db, householdId: registered.householdId };
}

test("starter taxonomy is hardcoded, two-level, and kind-consistent", () => {
  expect(STARTER_CATEGORIES.length).toBeGreaterThanOrEqual(12);
  const slugs = new Set<string>();
  for (const top of STARTER_CATEGORIES) {
    expect(slugs.has(top.slug)).toBe(false);
    slugs.add(top.slug);
    for (const child of top.children) {
      expect(slugs.has(child.slug)).toBe(false);
      slugs.add(child.slug);
      expect(child.name.length).toBeGreaterThan(0);
    }
  }
});

test("ensureStarterTaxonomy fills in the canonical tree exactly once", async () => {
  const { db, householdId } = await freshHousehold();
  const topLevelsBefore = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), isNull(categories.parentId)));
  expect(topLevelsBefore.length).toBe(STARTER_CATEGORIES.length);

  const expectedChildren = STARTER_CATEGORIES.reduce((sum, top) => sum + top.children.length, 0);
  const first = await ensureStarterTaxonomy(db, householdId);
  expect(first.created).toBe(expectedChildren);

  const second = await ensureStarterTaxonomy(db, householdId);
  expect(second.created).toBe(0);

  const paths = (await listTaxonomyPaths(db, householdId)).map(({ path }) => path);
  expect(paths).toContain("Food / Groceries");
  expect(paths).toContain("Food / Dining & coffee");
  expect(paths).toContain("Income / Paycheck");
  expect(paths).toContain("Investing / Brokerage contributions");
  expect(paths).toContain("Transfers");
});
