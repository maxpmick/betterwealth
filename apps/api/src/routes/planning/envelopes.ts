import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  allocationEntries,
  budgetPeriods,
  categories,
  envelopeAllocations,
  envelopeCategoryLinks,
  envelopes,
} from "@betterwealth/db/schema";
import { MoneyJsonSchema } from "@betterwealth/shared";
import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCsrf } from "../../auth/middleware";
import type { AppConfig } from "../../config";
import { AppError, ConflictError, NotFoundError } from "../../lib/errors";
import type { AppEnv } from "../../types";
import {
  budgetDtos,
  calculateBudgetActivity,
  currencySchema,
  dateSchema,
  dbJsonOrNull,
  type MoneyJson,
  minorUnitsSchema,
  moneyJson,
  nowIso,
  optionalMoney,
  page,
  requireEnvelope,
} from "./shared";

async function requireCategories(
  db: BetterWealthDatabase,
  householdId: string,
  categoryIds: readonly string[],
) {
  const uniqueIds = [...new Set(categoryIds)];
  if (!uniqueIds.length) return;
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), inArray(categories.id, uniqueIds)));
  if (rows.length !== uniqueIds.length) throw new NotFoundError("Category");
}

async function requireBudgetPeriod(
  db: BetterWealthDatabase,
  householdId: string,
  periodId: string,
) {
  const period = await db
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.householdId, householdId), eq(budgetPeriods.id, periodId)))
    .get();
  if (!period) throw new NotFoundError("Budget period");
  return period;
}

const envelopeCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    parentId: z.string().optional(),
    categoryId: z.string().nullable().optional(),
    categoryIds: z.array(z.string()).max(50).optional(),
    cadence: z.string().trim().min(1).max(80).default("monthly"),
    cadenceConfig: z.unknown().optional(),
    rolloverPolicy: z.enum(["none", "positive", "all", "cap", "monthly_reset"]).default("positive"),
    rolloverCapMinorUnits: minorUnitsSchema.optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
    minimumAmountMinorUnits: minorUnitsSchema.default("0"),
    targetAmountMinorUnits: minorUnitsSchema.default("0"),
    planned: MoneyJsonSchema.optional(),
    funded: MoneyJsonSchema.optional(),
    pacing: z.enum(["on_track", "watch", "over"]).optional(),
    currency: currencySchema.default("USD"),
    isRequired: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.rolloverPolicy === "cap" && input.rolloverCapMinorUnits === undefined) {
      context.addIssue({
        code: "custom",
        path: ["rolloverCapMinorUnits"],
        message: "A rollover cap is required for capped envelopes",
      });
    }
  });

const envelopePatchSchema = z.object(envelopeCreateSchema.shape).partial().strict();

function dbRolloverPolicy(
  policy: z.infer<typeof envelopeCreateSchema>["rolloverPolicy"],
): "none" | "positive" | "all" | "cap" {
  return policy === "monthly_reset" ? "none" : policy;
}

function standaloneEnvelopeDto(
  row: typeof envelopes.$inferSelect,
  linkedCategoryIds: readonly string[] = row.categoryId ? [row.categoryId] : [],
) {
  const categoryIds = [
    ...new Set([...(row.categoryId ? [row.categoryId] : []), ...linkedCategoryIds]),
  ];
  return {
    id: row.id,
    name: row.name,
    planned: moneyJson(row.targetAmount, row.currency),
    funded: moneyJson(0n, row.currency),
    activity: moneyJson(0n, row.currency),
    available: moneyJson(0n, row.currency),
    cadence: row.cadence,
    pacing: "on_track" as const,
    rolloverPolicy: row.rolloverPolicy,
    parentId: row.parentId,
    categoryId: row.categoryId,
    categoryIds,
    priority: row.priority,
    minimumAmount: moneyJson(row.minimumAmount, row.currency),
    targetAmount: moneyJson(row.targetAmount, row.currency),
    isRequired: row.isRequired,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const budgetWriteSchema = z
  .object({
    periodKind: z.enum(["pay_cycle", "month", "plan"]).optional(),
    kind: z.enum(["pay_cycle", "month", "custom"]).optional(),
    startDate: dateSchema.optional(),
    startsOn: dateSchema.optional(),
    endDate: dateSchema.optional(),
    endsOn: dateSchema.optional(),
    plannedIncome: MoneyJsonSchema.optional(),
    funded: MoneyJsonSchema.optional(),
    expectedIncomeMinorUnits: minorUnitsSchema.optional(),
    actualIncome: MoneyJsonSchema.optional(),
    actualIncomeMinorUnits: minorUnitsSchema.optional(),
    currency: currencySchema.optional(),
    status: z.enum(["draft", "planned", "open", "closed", "archived"]).optional(),
    payCycleId: z.string().optional(),
    envelopes: z
      .array(
        z.object({
          id: z.string(),
          planned: MoneyJsonSchema.optional(),
          plannedMinorUnits: minorUnitsSchema.optional(),
          funded: MoneyJsonSchema.optional(),
          fundedMinorUnits: minorUnitsSchema.optional(),
        }),
      )
      .max(500)
      .optional(),
  })
  .strict();

const monthlyPlanSchema = z
  .object({
    paychecksPerYear: z.union([z.literal(12), z.literal(24), z.literal(26), z.literal(52)]),
    monthlyIncome: MoneyJsonSchema.optional(),
    items: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(160),
            monthlyAmount: MoneyJsonSchema,
            categoryId: z.string().nullable().optional(),
            priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
            isRequired: z.boolean().default(false),
            rolloverPolicy: z.enum(["none", "positive", "all", "cap"]).default("positive"),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((input, context) => {
    const names = new Set<string>();
    for (const [index, item] of input.items.entries()) {
      const key = item.name.toLocaleLowerCase();
      if (names.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "name"],
          message: "Envelope names must be unique",
        });
      }
      names.add(key);
      if (BigInt(item.monthlyAmount.minorUnits) < 0n) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "monthlyAmount"],
          message: "Monthly spending cannot be negative",
        });
      }
    }
    if (input.monthlyIncome && BigInt(input.monthlyIncome.minorUnits) < 0n) {
      context.addIssue({
        code: "custom",
        path: ["monthlyIncome"],
        message: "Monthly income cannot be negative",
      });
    }
  });

function monthlyToPaycheck(monthlyMinorUnits: bigint, paychecksPerYear: 12 | 24 | 26 | 52) {
  const annual = monthlyMinorUnits * 12n;
  const divisor = BigInt(paychecksPerYear);
  return (annual + divisor / 2n) / divisor;
}

const allocationWriteSchema = z
  .object({
    envelopeId: z.string(),
    planned: MoneyJsonSchema.optional(),
    plannedMinorUnits: minorUnitsSchema.optional(),
    funded: MoneyJsonSchema.optional(),
    fundedMinorUnits: minorUnitsSchema.optional(),
    activityMinorUnits: minorUnitsSchema.optional(),
    transferredInMinorUnits: minorUnitsSchema.optional(),
    transferredOutMinorUnits: minorUnitsSchema.optional(),
  })
  .strict();

function normalizePeriodStatus(status: z.infer<typeof budgetWriteSchema>["status"]) {
  return status === "planned" ? ("draft" as const) : status;
}

async function writeAllocation(
  db: BetterWealthDatabase,
  householdId: string,
  periodId: string,
  input: z.infer<typeof allocationWriteSchema>,
) {
  const [period, envelope] = await Promise.all([
    requireBudgetPeriod(db, householdId, periodId),
    requireEnvelope(db, householdId, input.envelopeId),
  ]);
  if (period.currency !== envelope.currency) {
    throw new ConflictError(
      "Envelope and budget period currencies must match",
      "currency_mismatch",
    );
  }
  const existing = await db
    .select()
    .from(envelopeAllocations)
    .where(
      and(
        eq(envelopeAllocations.householdId, householdId),
        eq(envelopeAllocations.budgetPeriodId, periodId),
        eq(envelopeAllocations.envelopeId, input.envelopeId),
      ),
    )
    .get();
  const planned = optionalMoney(
    input.planned,
    input.plannedMinorUnits ?? existing?.planned.toString() ?? envelope.targetAmount.toString(),
    period.currency,
  );
  const funded = optionalMoney(
    input.funded,
    input.fundedMinorUnits ?? existing?.funded.toString() ?? "0",
    period.currency,
  );
  if (planned.currency !== period.currency || funded.currency !== period.currency) {
    throw new ConflictError(
      "Allocation currency must match its budget period",
      "currency_mismatch",
    );
  }
  const activity = BigInt(input.activityMinorUnits ?? existing?.activity.toString() ?? "0");
  const transferredIn = BigInt(
    input.transferredInMinorUnits ?? existing?.transferredIn.toString() ?? "0",
  );
  const transferredOut = BigInt(
    input.transferredOutMinorUnits ?? existing?.transferredOut.toString() ?? "0",
  );
  const available = funded.minor + activity + transferredIn - transferredOut;
  const values = {
    planned: planned.minor,
    funded: funded.minor,
    activity,
    transferredIn,
    transferredOut,
    availableSnapshot: available,
    currency: period.currency,
    calculatedAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (existing) {
    await db
      .update(envelopeAllocations)
      .set(values)
      .where(
        and(
          eq(envelopeAllocations.householdId, householdId),
          eq(envelopeAllocations.id, existing.id),
        ),
      );
    return existing.id;
  }
  const id = ulid();
  await db.insert(envelopeAllocations).values({
    id,
    householdId,
    budgetPeriodId: periodId,
    envelopeId: input.envelopeId,
    ...values,
  });
  return id;
}

export function createEnvelopeRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();

  // Envelope budgets -------------------------------------------------------

  routes.get("/envelopes", async (context) => {
    const auth = context.get("auth");
    const [rows, links] = await Promise.all([
      db
        .select()
        .from(envelopes)
        .where(eq(envelopes.householdId, auth.householdId))
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name)),
      db
        .select()
        .from(envelopeCategoryLinks)
        .where(eq(envelopeCategoryLinks.householdId, auth.householdId)),
    ]);
    const categoriesByEnvelope = new Map<string, string[]>();
    for (const link of links) {
      const values = categoriesByEnvelope.get(link.envelopeId) ?? [];
      values.push(link.categoryId);
      categoriesByEnvelope.set(link.envelopeId, values);
    }
    return context.json(
      page(rows.map((row) => standaloneEnvelopeDto(row, categoriesByEnvelope.get(row.id)))),
    );
  });

  routes.post("/envelopes", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = envelopeCreateSchema.parse(await context.req.json());
    if (input.parentId) await requireEnvelope(db, auth.householdId, input.parentId);
    const categoryIds = [
      ...(input.categoryId ? [input.categoryId] : []),
      ...(input.categoryIds ?? []),
    ];
    await requireCategories(db, auth.householdId, categoryIds);
    const id = ulid();
    db.transaction((transaction) => {
      transaction
        .insert(envelopes)
        .values({
          id,
          householdId: auth.householdId,
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ...(input.categoryId ? { categoryId: input.categoryId } : {}),
          name: input.name,
          cadence: input.cadence,
          ...(input.cadenceConfig === undefined
            ? {}
            : { cadenceConfig: dbJsonOrNull(input.cadenceConfig) }),
          rolloverPolicy: dbRolloverPolicy(input.rolloverPolicy),
          ...(input.rolloverCapMinorUnits === undefined
            ? {}
            : { rolloverCap: BigInt(input.rolloverCapMinorUnits) }),
          priority: input.priority,
          minimumAmount: BigInt(input.minimumAmountMinorUnits),
          targetAmount: input.planned
            ? BigInt(input.planned.minorUnits)
            : BigInt(input.targetAmountMinorUnits),
          currency: input.currency,
          isRequired: input.isRequired,
          isActive: input.isActive,
        })
        .run();
      if (categoryIds.length) {
        transaction
          .insert(envelopeCategoryLinks)
          .values(
            [...new Set(categoryIds)].map((categoryId) => ({
              householdId: auth.householdId,
              envelopeId: id,
              categoryId,
            })),
          )
          .run();
      }
    });
    const row = await db
      .select()
      .from(envelopes)
      .where(and(eq(envelopes.householdId, auth.householdId), eq(envelopes.id, id)))
      .get();
    if (!row) throw new NotFoundError("Envelope");
    return context.json(
      {
        ...standaloneEnvelopeDto(row, categoryIds),
        ...(input.funded ? { funded: input.funded, available: input.funded } : {}),
      },
      201,
    );
  });

  routes.patch("/envelopes/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await requireEnvelope(db, auth.householdId, context.req.param("id"));
    const input = envelopePatchSchema.parse(await context.req.json());
    if (input.parentId) {
      if (input.parentId === current.id) {
        throw new ConflictError("An envelope cannot contain itself", "invalid_parent");
      }
      await requireEnvelope(db, auth.householdId, input.parentId);
    }
    const categoryIds =
      input.categoryId === undefined && input.categoryIds === undefined
        ? undefined
        : [...(input.categoryId ? [input.categoryId] : []), ...(input.categoryIds ?? [])];
    if (categoryIds) await requireCategories(db, auth.householdId, categoryIds);
    db.transaction((transaction) => {
      transaction
        .update(envelopes)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          ...(input.cadence === undefined ? {} : { cadence: input.cadence }),
          ...(input.cadenceConfig === undefined
            ? {}
            : { cadenceConfig: dbJsonOrNull(input.cadenceConfig) }),
          ...(input.rolloverPolicy === undefined
            ? {}
            : { rolloverPolicy: dbRolloverPolicy(input.rolloverPolicy) }),
          ...(input.rolloverCapMinorUnits === undefined
            ? {}
            : { rolloverCap: BigInt(input.rolloverCapMinorUnits) }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.minimumAmountMinorUnits === undefined
            ? {}
            : { minimumAmount: BigInt(input.minimumAmountMinorUnits) }),
          ...(input.planned
            ? { targetAmount: BigInt(input.planned.minorUnits), currency: input.planned.currency }
            : input.targetAmountMinorUnits === undefined
              ? {}
              : { targetAmount: BigInt(input.targetAmountMinorUnits) }),
          ...(input.currency === undefined ? {} : { currency: input.currency }),
          ...(input.isRequired === undefined ? {} : { isRequired: input.isRequired }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          updatedAt: nowIso(),
        })
        .where(and(eq(envelopes.householdId, auth.householdId), eq(envelopes.id, current.id)))
        .run();
      if (categoryIds) {
        transaction
          .delete(envelopeCategoryLinks)
          .where(
            and(
              eq(envelopeCategoryLinks.householdId, auth.householdId),
              eq(envelopeCategoryLinks.envelopeId, current.id),
            ),
          )
          .run();
        if (categoryIds.length) {
          transaction
            .insert(envelopeCategoryLinks)
            .values(
              [...new Set(categoryIds)].map((categoryId) => ({
                householdId: auth.householdId,
                envelopeId: current.id,
                categoryId,
              })),
            )
            .run();
        }
      }
      if (input.planned || input.targetAmountMinorUnits !== undefined) {
        const planned = input.planned
          ? BigInt(input.planned.minorUnits)
          : BigInt(input.targetAmountMinorUnits!);
        transaction
          .update(envelopeAllocations)
          .set({ planned, updatedAt: nowIso() })
          .where(
            and(
              eq(envelopeAllocations.householdId, auth.householdId),
              eq(envelopeAllocations.envelopeId, current.id),
            ),
          )
          .run();
      }
    });
    const updated = await requireEnvelope(db, auth.householdId, current.id);
    const updatedLinks = await db
      .select({ categoryId: envelopeCategoryLinks.categoryId })
      .from(envelopeCategoryLinks)
      .where(
        and(
          eq(envelopeCategoryLinks.householdId, auth.householdId),
          eq(envelopeCategoryLinks.envelopeId, current.id),
        ),
      );
    return context.json(
      standaloneEnvelopeDto(
        updated,
        updatedLinks.map((link) => link.categoryId),
      ),
    );
  });

  routes.delete("/envelopes/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const row = await requireEnvelope(db, auth.householdId, context.req.param("id"));
    await db
      .update(envelopes)
      .set({ isActive: false, updatedAt: nowIso() })
      .where(and(eq(envelopes.householdId, auth.householdId), eq(envelopes.id, row.id)));
    return context.body(null, 204);
  });

  routes.get("/budgets", async (context) => {
    const auth = context.get("auth");
    const requestedView = context.req.query("view");
    const data = await budgetDtos(db, auth.householdId);
    return context.json(
      page(
        requestedView && requestedView !== "plan"
          ? data.filter((period) => period.periodKind === requestedView)
          : data,
      ),
    );
  });

  routes.post("/budgets", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = budgetWriteSchema.parse(await context.req.json());
    const startsOn = input.startDate ?? input.startsOn;
    const endsOn = input.endDate ?? input.endsOn;
    if (!startsOn || !endsOn) {
      throw new AppError("Budget start and end dates are required", 422, "invalid_budget");
    }
    if (startsOn > endsOn) {
      throw new AppError("Budget start date must not be after its end date", 422, "invalid_budget");
    }
    const kind =
      input.kind ?? (input.periodKind === "plan" ? "custom" : input.periodKind) ?? "month";
    const expected = optionalMoney(
      input.plannedIncome,
      input.expectedIncomeMinorUnits,
      input.currency ?? "USD",
    );
    const actual = optionalMoney(
      input.actualIncome,
      input.actualIncomeMinorUnits,
      expected.currency,
    );
    if (expected.currency !== actual.currency) {
      throw new ConflictError("Budget income currencies must match", "currency_mismatch");
    }
    const id = ulid();
    await db.insert(budgetPeriods).values({
      id,
      householdId: auth.householdId,
      ...(input.payCycleId ? { payCycleId: input.payCycleId } : {}),
      kind,
      startsOn,
      endsOn,
      currency: expected.currency,
      expectedIncome: expected.minor,
      actualIncome: actual.minor,
      status: normalizePeriodStatus(input.status) ?? "draft",
    });
    for (const allocation of input.envelopes ?? []) {
      await writeAllocation(db, auth.householdId, id, {
        envelopeId: allocation.id,
        ...(allocation.planned ? { planned: allocation.planned } : {}),
        ...(allocation.plannedMinorUnits
          ? { plannedMinorUnits: allocation.plannedMinorUnits }
          : {}),
        ...(allocation.funded ? { funded: allocation.funded } : {}),
        ...(allocation.fundedMinorUnits ? { fundedMinorUnits: allocation.fundedMinorUnits } : {}),
      });
    }
    return context.json((await budgetDtos(db, auth.householdId, id))[0]!, 201);
  });

  routes.patch("/budgets/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await requireBudgetPeriod(db, auth.householdId, context.req.param("id"));
    const input = budgetWriteSchema.parse(await context.req.json());
    const expected = input.plannedIncome
      ? BigInt(input.plannedIncome.minorUnits)
      : input.expectedIncomeMinorUnits === undefined
        ? undefined
        : BigInt(input.expectedIncomeMinorUnits);
    const actual = input.actualIncome
      ? BigInt(input.actualIncome.minorUnits)
      : input.actualIncomeMinorUnits === undefined
        ? undefined
        : BigInt(input.actualIncomeMinorUnits);
    const nextCurrency =
      input.plannedIncome?.currency ??
      input.actualIncome?.currency ??
      input.currency ??
      current.currency;
    await db
      .update(budgetPeriods)
      .set({
        ...(input.periodKind || input.kind
          ? {
              kind:
                input.kind ??
                (input.periodKind === "plan" ? "custom" : input.periodKind) ??
                current.kind,
            }
          : {}),
        ...(input.startDate || input.startsOn
          ? { startsOn: input.startDate ?? input.startsOn }
          : {}),
        ...(input.endDate || input.endsOn ? { endsOn: input.endDate ?? input.endsOn } : {}),
        ...(expected === undefined ? {} : { expectedIncome: expected }),
        ...(actual === undefined ? {} : { actualIncome: actual }),
        currency: nextCurrency,
        ...(input.status === undefined ? {} : { status: normalizePeriodStatus(input.status) }),
        updatedAt: nowIso(),
      })
      .where(
        and(eq(budgetPeriods.householdId, auth.householdId), eq(budgetPeriods.id, current.id)),
      );
    if (input.funded && !input.envelopes) {
      const requestedFunding = BigInt(input.funded.minorUnits);
      const fundingPeriod = await requireBudgetPeriod(db, auth.householdId, current.id);
      if (
        input.funded.currency !== nextCurrency ||
        requestedFunding < 0n ||
        requestedFunding > fundingPeriod.expectedIncome
      ) {
        throw new AppError(
          "Funding must be between zero and the period's expected income and use its currency",
          422,
          "invalid_budget_funding",
        );
      }
      const persisted = await db
        .select({ allocation: envelopeAllocations, envelope: envelopes })
        .from(envelopeAllocations)
        .innerJoin(envelopes, eq(envelopes.id, envelopeAllocations.envelopeId))
        .where(
          and(
            eq(envelopeAllocations.householdId, auth.householdId),
            eq(envelopeAllocations.budgetPeriodId, current.id),
            eq(envelopes.householdId, auth.householdId),
          ),
        )
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name));
      const existingIds = new Set(persisted.map((item) => item.envelope.id));
      const activeRows = await db
        .select()
        .from(envelopes)
        .where(
          and(
            eq(envelopes.householdId, auth.householdId),
            eq(envelopes.isActive, true),
            eq(envelopes.currency, fundingPeriod.currency),
          ),
        )
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name));
      for (const envelope of activeRows) {
        if (existingIds.has(envelope.id)) continue;
        await writeAllocation(db, auth.householdId, fundingPeriod.id, {
          envelopeId: envelope.id,
          plannedMinorUnits: envelope.targetAmount.toString(),
          fundedMinorUnits: "0",
        });
      }
      const allocations = await db
        .select({ allocation: envelopeAllocations, envelope: envelopes })
        .from(envelopeAllocations)
        .innerJoin(envelopes, eq(envelopes.id, envelopeAllocations.envelopeId))
        .where(
          and(
            eq(envelopeAllocations.householdId, auth.householdId),
            eq(envelopeAllocations.budgetPeriodId, fundingPeriod.id),
            eq(envelopes.householdId, auth.householdId),
          ),
        )
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name));
      const activityByEnvelope = await calculateBudgetActivity(
        db,
        auth.householdId,
        fundingPeriod,
        allocations.map((item) => item.envelope),
      );
      let remainingFunding = requestedFunding;
      const desired = allocations.map((item) => {
        const fundedAmount =
          remainingFunding > item.allocation.planned ? item.allocation.planned : remainingFunding;
        remainingFunding -= fundedAmount;
        return { ...item, fundedAmount };
      });
      const batchId = ulid();
      db.transaction((transaction) => {
        let sequence = 0;
        for (const { allocation, envelope, fundedAmount } of desired) {
          const liveActivity = activityByEnvelope.get(envelope.id) ?? 0n;
          transaction
            .update(envelopeAllocations)
            .set({
              funded: fundedAmount,
              activity: liveActivity,
              availableSnapshot:
                fundedAmount + liveActivity + allocation.transferredIn - allocation.transferredOut,
              calculatedAt: nowIso(),
              updatedAt: nowIso(),
            })
            .where(
              and(
                eq(envelopeAllocations.householdId, auth.householdId),
                eq(envelopeAllocations.id, allocation.id),
              ),
            )
            .run();
          const delta = fundedAmount - allocation.funded;
          if (delta === 0n) continue;
          transaction
            .insert(allocationEntries)
            .values({
              id: ulid(),
              householdId: auth.householdId,
              budgetPeriodId: fundingPeriod.id,
              batchId,
              sequence: sequence++,
              fromBucketType: delta > 0n ? "unassigned" : "envelope",
              fromBucketId: delta > 0n ? "cash" : envelope.id,
              toBucketType: delta > 0n ? "envelope" : "unassigned",
              toBucketId: delta > 0n ? envelope.id : "cash",
              amount: delta > 0n ? delta : -delta,
              currency: fundingPeriod.currency,
              kind: delta > 0n ? "fund" : "release",
              sourceType: "paycheck_plan",
              memo: `Fund ${envelope.name} by priority`,
              createdByUserId: auth.user.id,
            })
            .run();
        }
      });
    }
    for (const allocation of input.envelopes ?? []) {
      await writeAllocation(db, auth.householdId, current.id, {
        envelopeId: allocation.id,
        ...(allocation.planned ? { planned: allocation.planned } : {}),
        ...(allocation.plannedMinorUnits
          ? { plannedMinorUnits: allocation.plannedMinorUnits }
          : {}),
        ...(allocation.funded ? { funded: allocation.funded } : {}),
        ...(allocation.fundedMinorUnits ? { fundedMinorUnits: allocation.fundedMinorUnits } : {}),
      });
    }
    return context.json((await budgetDtos(db, auth.householdId, current.id))[0]!);
  });

  routes.post("/budgets/:id/build-from-monthly-spend", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const period = await requireBudgetPeriod(db, auth.householdId, context.req.param("id"));
    if (period.status === "closed" || period.status === "archived") {
      throw new ConflictError("A closed budget plan cannot be rebuilt", "budget_closed");
    }
    const input = monthlyPlanSchema.parse(await context.req.json());
    const currencies = [
      ...(input.monthlyIncome ? [input.monthlyIncome.currency] : []),
      ...input.items.map((item) => item.monthlyAmount.currency),
    ];
    if (currencies.some((currency) => currency !== period.currency)) {
      throw new ConflictError(
        "Monthly plan amounts must use the budget currency",
        "currency_mismatch",
      );
    }
    await requireCategories(
      db,
      auth.householdId,
      input.items.flatMap((item) => (item.categoryId ? [item.categoryId] : [])),
    );
    const [existingEnvelopes, existingAllocations] = await Promise.all([
      db.select().from(envelopes).where(eq(envelopes.householdId, auth.householdId)),
      db
        .select()
        .from(envelopeAllocations)
        .where(
          and(
            eq(envelopeAllocations.householdId, auth.householdId),
            eq(envelopeAllocations.budgetPeriodId, period.id),
          ),
        ),
    ]);
    const envelopeByName = new Map(
      existingEnvelopes.map((envelope) => [envelope.name.toLocaleLowerCase(), envelope]),
    );
    const allocationByEnvelope = new Map(
      existingAllocations.map((allocation) => [allocation.envelopeId, allocation]),
    );
    const conversions: Array<{
      envelopeId: string;
      name: string;
      monthlyAmount: MoneyJson;
      perPaycheckAmount: MoneyJson;
    }> = [];
    db.transaction((transaction) => {
      if (input.monthlyIncome) {
        transaction
          .update(budgetPeriods)
          .set({
            expectedIncome: monthlyToPaycheck(
              BigInt(input.monthlyIncome.minorUnits),
              input.paychecksPerYear,
            ),
            updatedAt: nowIso(),
          })
          .where(
            and(eq(budgetPeriods.householdId, auth.householdId), eq(budgetPeriods.id, period.id)),
          )
          .run();
      }
      for (const item of input.items) {
        const target = monthlyToPaycheck(
          BigInt(item.monthlyAmount.minorUnits),
          input.paychecksPerYear,
        );
        const existing = envelopeByName.get(item.name.toLocaleLowerCase());
        const envelopeId = existing?.id ?? ulid();
        if (existing) {
          transaction
            .update(envelopes)
            .set({
              name: item.name,
              categoryId: item.categoryId ?? null,
              cadence: "paycheck",
              cadenceConfig: {
                source: "monthly_spend_builder",
                monthlyAmountMinorUnits: item.monthlyAmount.minorUnits,
                paychecksPerYear: input.paychecksPerYear,
              },
              rolloverPolicy: item.rolloverPolicy,
              priority: item.priority,
              minimumAmount: item.isRequired ? target : 0n,
              targetAmount: target,
              isRequired: item.isRequired,
              isActive: true,
              updatedAt: nowIso(),
            })
            .where(and(eq(envelopes.householdId, auth.householdId), eq(envelopes.id, envelopeId)))
            .run();
        } else {
          transaction
            .insert(envelopes)
            .values({
              id: envelopeId,
              householdId: auth.householdId,
              name: item.name,
              categoryId: item.categoryId ?? null,
              cadence: "paycheck",
              cadenceConfig: {
                source: "monthly_spend_builder",
                monthlyAmountMinorUnits: item.monthlyAmount.minorUnits,
                paychecksPerYear: input.paychecksPerYear,
              },
              rolloverPolicy: item.rolloverPolicy,
              priority: item.priority,
              minimumAmount: item.isRequired ? target : 0n,
              targetAmount: target,
              currency: period.currency,
              isRequired: item.isRequired,
              isActive: true,
            })
            .run();
        }
        transaction
          .delete(envelopeCategoryLinks)
          .where(
            and(
              eq(envelopeCategoryLinks.householdId, auth.householdId),
              eq(envelopeCategoryLinks.envelopeId, envelopeId),
            ),
          )
          .run();
        if (item.categoryId) {
          transaction
            .insert(envelopeCategoryLinks)
            .values({
              householdId: auth.householdId,
              envelopeId,
              categoryId: item.categoryId,
            })
            .run();
        }
        const allocation = allocationByEnvelope.get(envelopeId);
        if (allocation) {
          transaction
            .update(envelopeAllocations)
            .set({ planned: target, updatedAt: nowIso() })
            .where(
              and(
                eq(envelopeAllocations.householdId, auth.householdId),
                eq(envelopeAllocations.id, allocation.id),
              ),
            )
            .run();
        } else {
          transaction
            .insert(envelopeAllocations)
            .values({
              id: ulid(),
              householdId: auth.householdId,
              budgetPeriodId: period.id,
              envelopeId,
              planned: target,
              funded: 0n,
              activity: 0n,
              transferredIn: 0n,
              transferredOut: 0n,
              availableSnapshot: 0n,
              currency: period.currency,
              calculatedAt: nowIso(),
            })
            .run();
        }
        conversions.push({
          envelopeId,
          name: item.name,
          monthlyAmount: moneyJson(BigInt(item.monthlyAmount.minorUnits), period.currency),
          perPaycheckAmount: moneyJson(target, period.currency),
        });
      }
    });
    return context.json({
      budget: (await budgetDtos(db, auth.householdId, period.id))[0]!,
      conversions,
    });
  });

  routes.delete("/budgets/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await requireBudgetPeriod(db, auth.householdId, context.req.param("id"));
    await db
      .update(budgetPeriods)
      .set({ status: "archived", updatedAt: nowIso() })
      .where(
        and(eq(budgetPeriods.householdId, auth.householdId), eq(budgetPeriods.id, current.id)),
      );
    return context.body(null, 204);
  });

  routes.post("/allocations", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        budgetId: z.string(),
        from: z.string().trim().min(1).max(160).optional(),
        to: z.string().trim().min(1).max(160).optional(),
        fromEnvelopeId: z.string().nullable().optional(),
        toEnvelopeId: z.string().optional(),
        amount: MoneyJsonSchema,
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .superRefine((value, issueContext) => {
        if (!value.toEnvelopeId && !value.to) {
          issueContext.addIssue({
            code: "custom",
            path: ["toEnvelopeId"],
            message: "A destination envelope is required",
          });
        }
        if (value.fromEnvelopeId === undefined && !value.from) {
          issueContext.addIssue({
            code: "custom",
            path: ["fromEnvelopeId"],
            message: "Choose unassigned income or a source envelope",
          });
        }
      })
      .parse(await context.req.json());
    const period = await requireBudgetPeriod(db, auth.householdId, input.budgetId);
    if (input.amount.currency !== period.currency || BigInt(input.amount.minorUnits) <= 0n) {
      throw new AppError(
        "Allocation must be positive and use the budget currency",
        422,
        "invalid_allocation",
      );
    }
    const requestedIds = [
      ...(input.toEnvelopeId ? [input.toEnvelopeId] : []),
      ...(input.fromEnvelopeId ? [input.fromEnvelopeId] : []),
    ];
    const envelopeRows = requestedIds.length
      ? await db
          .select()
          .from(envelopes)
          .where(
            and(eq(envelopes.householdId, auth.householdId), inArray(envelopes.id, requestedIds)),
          )
      : await db
          .select()
          .from(envelopes)
          .where(
            and(
              eq(envelopes.householdId, auth.householdId),
              or(
                input.from ? eq(envelopes.name, input.from) : undefined,
                input.to ? eq(envelopes.name, input.to) : undefined,
              ),
            ),
          );
    const toEnvelope = input.toEnvelopeId
      ? envelopeRows.find((envelope) => envelope.id === input.toEnvelopeId)
      : envelopeRows.find((envelope) => envelope.name === input.to);
    if (!toEnvelope) throw new NotFoundError("Destination envelope");
    const fromEnvelope = input.fromEnvelopeId
      ? envelopeRows.find((envelope) => envelope.id === input.fromEnvelopeId)
      : input.fromEnvelopeId === null || input.from === "Unassigned income"
        ? undefined
        : envelopeRows.find((envelope) => envelope.name === input.from);
    if (input.fromEnvelopeId && !fromEnvelope) throw new NotFoundError("Source envelope");
    if (fromEnvelope?.id === toEnvelope.id) {
      throw new ConflictError("Source and destination must be different", "same_envelope");
    }
    const amount = BigInt(input.amount.minorUnits);
    const currentAllocations = await db
      .select()
      .from(envelopeAllocations)
      .where(
        and(
          eq(envelopeAllocations.householdId, auth.householdId),
          eq(envelopeAllocations.budgetPeriodId, period.id),
          inArray(envelopeAllocations.envelopeId, [
            toEnvelope.id,
            ...(fromEnvelope ? [fromEnvelope.id] : []),
          ]),
        ),
      );
    const byEnvelope = new Map(
      currentAllocations.map((allocation) => [allocation.envelopeId, allocation]),
    );
    const toAllocation = byEnvelope.get(toEnvelope.id);
    let fromAllocation = fromEnvelope ? byEnvelope.get(fromEnvelope.id) : undefined;
    const liveBudget = (await budgetDtos(db, auth.householdId, period.id))[0];
    if (!liveBudget) throw new NotFoundError("Budget period");
    const fromLive = fromEnvelope
      ? liveBudget.envelopes.find((envelope) => envelope.id === fromEnvelope.id)
      : undefined;
    const toLive = liveBudget.envelopes.find((envelope) => envelope.id === toEnvelope.id);
    const sourceAvailable = fromEnvelope
      ? BigInt(fromLive?.available.minorUnits ?? "0")
      : BigInt(liveBudget.unassigned.minorUnits);
    if (sourceAvailable < amount) {
      throw new ConflictError(
        fromEnvelope
          ? "Source envelope does not have enough available"
          : "Unassigned income does not have enough available",
        "insufficient_funds",
      );
    }
    if (fromEnvelope && !fromAllocation) {
      await writeAllocation(db, auth.householdId, period.id, {
        envelopeId: fromEnvelope.id,
        plannedMinorUnits: fromEnvelope.targetAmount.toString(),
        fundedMinorUnits: "0",
        activityMinorUnits: fromLive?.activity.minorUnits ?? "0",
      });
      fromAllocation = await db
        .select()
        .from(envelopeAllocations)
        .where(
          and(
            eq(envelopeAllocations.householdId, auth.householdId),
            eq(envelopeAllocations.budgetPeriodId, period.id),
            eq(envelopeAllocations.envelopeId, fromEnvelope.id),
          ),
        )
        .get();
    }
    const entryId = ulid();
    const batchId = ulid();
    db.transaction((transaction) => {
      transaction
        .insert(allocationEntries)
        .values({
          id: entryId,
          householdId: auth.householdId,
          budgetPeriodId: period.id,
          batchId,
          sequence: 0,
          fromBucketType: fromEnvelope ? "envelope" : "unassigned",
          fromBucketId: fromEnvelope?.id ?? "cash",
          toBucketType: "envelope",
          toBucketId: toEnvelope.id,
          amount,
          currency: period.currency,
          kind: fromEnvelope ? "transfer" : "fund",
          sourceType: "user_allocation",
          memo: input.reason,
          createdByUserId: auth.user.id,
        })
        .run();
      if (fromEnvelope && fromAllocation) {
        transaction
          .update(envelopeAllocations)
          .set({
            transferredOut: fromAllocation.transferredOut + amount,
            activity: BigInt(fromLive?.activity.minorUnits ?? "0"),
            availableSnapshot: sourceAvailable - amount,
            calculatedAt: nowIso(),
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(envelopeAllocations.householdId, auth.householdId),
              eq(envelopeAllocations.id, fromAllocation.id),
            ),
          )
          .run();
      }
      if (toAllocation) {
        const currentToAvailable = BigInt(toLive?.available.minorUnits ?? "0");
        transaction
          .update(envelopeAllocations)
          .set({
            ...(fromEnvelope
              ? { transferredIn: toAllocation.transferredIn + amount }
              : { funded: toAllocation.funded + amount }),
            activity: BigInt(toLive?.activity.minorUnits ?? "0"),
            availableSnapshot: currentToAvailable + amount,
            calculatedAt: nowIso(),
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(envelopeAllocations.householdId, auth.householdId),
              eq(envelopeAllocations.id, toAllocation.id),
            ),
          )
          .run();
      } else {
        const liveActivity = BigInt(toLive?.activity.minorUnits ?? "0");
        const liveAvailable = BigInt(toLive?.available.minorUnits ?? "0");
        transaction
          .insert(envelopeAllocations)
          .values({
            id: ulid(),
            householdId: auth.householdId,
            budgetPeriodId: period.id,
            envelopeId: toEnvelope.id,
            planned: toEnvelope.targetAmount,
            funded: fromEnvelope ? 0n : amount,
            activity: liveActivity,
            transferredIn: fromEnvelope ? amount : 0n,
            transferredOut: 0n,
            availableSnapshot: liveAvailable + amount,
            currency: period.currency,
            calculatedAt: nowIso(),
          })
          .run();
      }
    });
    return context.json(
      {
        id: entryId,
        reversibleBatchId: batchId,
        budget: (await budgetDtos(db, auth.householdId, period.id))[0],
      },
      201,
    );
  });

  return routes;
}
