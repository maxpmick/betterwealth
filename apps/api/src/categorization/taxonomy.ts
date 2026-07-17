import type { BetterWealthDatabase } from "@betterwealth/db";
import { categories } from "@betterwealth/db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";

/**
 * The canonical BetterWealth starter taxonomy. AI categorization is only as trustworthy as the
 * category list it chooses from, so this tree is hardcoded, stable, and shared by registration,
 * bootstrap, and rebuild flows instead of being grown organically per household.
 */
export type StarterCategoryKind = "income" | "expense" | "transfer" | "debt" | "investment";

export type StarterCategoryChild = {
  slug: string;
  name: string;
  color: string;
  icon: string;
};

export type StarterCategory = StarterCategoryChild & {
  kind: StarterCategoryKind;
  children: readonly StarterCategoryChild[];
};

export const STARTER_CATEGORIES: readonly StarterCategory[] = [
  {
    slug: "income",
    name: "Income",
    kind: "income",
    color: "#1F9D72",
    icon: "payments",
    children: [
      { slug: "paycheck", name: "Paycheck", color: "#16815F", icon: "payments" },
      { slug: "other-income", name: "Other income", color: "#2D9874", icon: "add_card" },
    ],
  },
  {
    slug: "housing",
    name: "Housing",
    kind: "expense",
    color: "#4A7FD1",
    icon: "home",
    children: [
      { slug: "rent-mortgage", name: "Rent & mortgage", color: "#3C6FB6", icon: "apartment" },
      {
        slug: "home-services",
        name: "Home services",
        color: "#5D8BCB",
        icon: "home_repair_service",
      },
    ],
  },
  {
    slug: "food",
    name: "Food",
    kind: "expense",
    color: "#D98B2B",
    icon: "restaurant",
    children: [
      { slug: "groceries", name: "Groceries", color: "#D68625", icon: "shopping_cart" },
      { slug: "dining-coffee", name: "Dining & coffee", color: "#C76C45", icon: "restaurant" },
    ],
  },
  {
    slug: "transportation",
    name: "Transportation",
    kind: "expense",
    color: "#7B61B3",
    icon: "directions_car",
    children: [
      { slug: "gas", name: "Gas", color: "#7253AA", icon: "local_gas_station" },
      { slug: "auto-maintenance", name: "Auto maintenance", color: "#8265B9", icon: "car_repair" },
      { slug: "transit-rides", name: "Transit & rides", color: "#9278C2", icon: "train" },
    ],
  },
  {
    slug: "utilities",
    name: "Utilities",
    kind: "expense",
    color: "#4E8597",
    icon: "bolt",
    children: [
      { slug: "phone-internet", name: "Phone & internet", color: "#387789", icon: "wifi" },
      { slug: "home-utilities", name: "Home utilities", color: "#4E8B9C", icon: "bolt" },
    ],
  },
  {
    slug: "health",
    name: "Health",
    kind: "expense",
    color: "#DD625B",
    icon: "favorite",
    children: [
      { slug: "medical", name: "Medical", color: "#CF5049", icon: "medical_services" },
      { slug: "fitness", name: "Fitness", color: "#DE716B", icon: "fitness_center" },
    ],
  },
  {
    slug: "personal",
    name: "Personal",
    kind: "expense",
    color: "#A66B8D",
    icon: "person",
    children: [
      { slug: "insurance", name: "Insurance", color: "#8B5E7C", icon: "verified_user" },
      { slug: "shopping", name: "Shopping", color: "#9B5D83", icon: "shopping_bag" },
      { slug: "personal-care", name: "Personal care", color: "#AD7897", icon: "self_improvement" },
      { slug: "gifts-giving", name: "Gifts & giving", color: "#B07A95", icon: "redeem" },
      { slug: "education", name: "Education", color: "#765D91", icon: "school" },
    ],
  },
  {
    slug: "fun",
    name: "Fun & entertainment",
    kind: "expense",
    color: "#8C6A43",
    icon: "celebration",
    children: [
      { slug: "subscriptions", name: "Subscriptions", color: "#7A593A", icon: "subscriptions" },
      { slug: "entertainment", name: "Entertainment", color: "#906F4D", icon: "theaters" },
      { slug: "travel", name: "Travel", color: "#A58562", icon: "flight" },
    ],
  },
  {
    slug: "debt",
    name: "Debt payments",
    kind: "debt",
    color: "#C46A4A",
    icon: "credit_score",
    children: [
      { slug: "loan-payments", name: "Loan payments", color: "#BA5C3F", icon: "credit_score" },
    ],
  },
  {
    slug: "investing",
    name: "Investing",
    kind: "investment",
    color: "#287E69",
    icon: "trending_up",
    children: [
      {
        slug: "brokerage-contributions",
        name: "Brokerage contributions",
        color: "#20735F",
        icon: "trending_up",
      },
    ],
  },
  {
    slug: "transfers",
    name: "Transfers",
    kind: "transfer",
    color: "#6B7280",
    icon: "swap_horiz",
    children: [],
  },
  {
    slug: "uncategorized",
    name: "Uncategorized",
    kind: "expense",
    color: "#8A9099",
    icon: "help_outline",
    children: [],
  },
] as const;

/**
 * Idempotently materializes the starter taxonomy for a household. Existing active categories are
 * matched by slug at the same hierarchy level and left untouched; only missing rows are created.
 * Returns the number of rows created.
 */
export async function ensureStarterTaxonomy(
  db: BetterWealthDatabase,
  householdId: string,
): Promise<{ created: number }> {
  let created = 0;
  for (const [sortOrder, starter] of STARTER_CATEGORIES.entries()) {
    const existingTop = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.householdId, householdId),
          eq(categories.slug, starter.slug),
          isNull(categories.parentId),
          eq(categories.isActive, true),
        ),
      )
      .get();
    let topId = existingTop?.id;
    if (!topId) {
      topId = ulid();
      await db.insert(categories).values({
        id: topId,
        householdId,
        slug: starter.slug,
        name: starter.name,
        kind: starter.kind,
        color: starter.color,
        icon: starter.icon,
        isActive: true,
        isSystem: true,
        sortOrder,
      });
      created += 1;
    }
    for (const [childSortOrder, child] of starter.children.entries()) {
      const existingChild = await db
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(
            eq(categories.householdId, householdId),
            eq(categories.slug, child.slug),
            eq(categories.parentId, topId),
            eq(categories.isActive, true),
          ),
        )
        .get();
      if (existingChild) continue;
      await db.insert(categories).values({
        id: ulid(),
        householdId,
        slug: child.slug,
        name: child.name,
        kind: starter.kind,
        color: child.color,
        icon: child.icon,
        parentId: topId,
        isActive: true,
        isSystem: true,
        sortOrder: (sortOrder + 1) * 100 + childSortOrder,
      });
      created += 1;
    }
  }
  return { created };
}

/** Lists the active taxonomy as parent / child display paths, e.g. for diagnostics. */
export async function listTaxonomyPaths(db: BetterWealthDatabase, householdId: string) {
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      kind: categories.kind,
    })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), eq(categories.isActive, true)))
    .orderBy(asc(categories.sortOrder), asc(categories.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rows.map((row) => ({
    id: row.id,
    path: row.parentId ? `${byId.get(row.parentId)?.name ?? "?"} / ${row.name}` : row.name,
    kind: row.kind,
  }));
}
