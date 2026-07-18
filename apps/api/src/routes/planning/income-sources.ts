import type { BetterWealthDatabase } from "@betterwealth/db";
import { incomeSources } from "@betterwealth/db/schema";
import { MoneyJsonSchema } from "@betterwealth/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCsrf } from "../../auth/middleware";
import type { AppConfig } from "../../config";
import { NotFoundError } from "../../lib/errors";
import type { AppEnv } from "../../types";
import {
  currencySchema,
  dateSchema,
  dbJsonOrNull,
  minorUnitsSchema,
  moneyJson,
  nowIso,
  optionalMoney,
  page,
  requireAccount,
} from "./shared";

const incomeSourceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    merchantId: z.string().optional(),
    accountId: z.string().optional(),
    recurringSeriesId: z.string().optional(),
    cadence: z.string().trim().min(1).max(80).default("monthly"),
    cadenceConfig: z.unknown().optional(),
    typicalAmount: MoneyJsonSchema.optional(),
    typicalAmountMinorUnits: minorUnitsSchema.optional(),
    currency: currencySchema.default("USD"),
    nextExpectedDate: dateSchema.optional(),
    variabilityBps: z.number().int().min(0).max(100_000).default(0),
    isActive: z.boolean().default(true),
    detectionRule: z.unknown().optional(),
  })
  .strict();

const incomeSourcePatchSchema = incomeSourceCreateSchema.partial();

export function createIncomeSourceRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();

  // Income sources ---------------------------------------------------------

  routes.get("/income-sources", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(incomeSources)
      .where(eq(incomeSources.householdId, auth.householdId))
      .orderBy(desc(incomeSources.isActive), asc(incomeSources.name));
    return context.json(
      page(
        rows.map((row) => ({
          ...row,
          typicalAmount: moneyJson(row.typicalAmount, row.currency),
        })),
      ),
    );
  });

  routes.post("/income-sources", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = incomeSourceCreateSchema.parse(await context.req.json());
    if (input.accountId) await requireAccount(db, auth.householdId, input.accountId);
    const amount = optionalMoney(
      input.typicalAmount,
      input.typicalAmountMinorUnits,
      input.currency,
    );
    const id = ulid();
    await db.insert(incomeSources).values({
      id,
      householdId: auth.householdId,
      name: input.name,
      ...(input.merchantId ? { merchantId: input.merchantId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.recurringSeriesId ? { recurringSeriesId: input.recurringSeriesId } : {}),
      cadence: input.cadence,
      ...(input.cadenceConfig === undefined
        ? {}
        : { cadenceConfig: dbJsonOrNull(input.cadenceConfig) }),
      typicalAmount: amount.minor,
      currency: amount.currency,
      ...(input.nextExpectedDate ? { nextExpectedDate: input.nextExpectedDate } : {}),
      variabilityBps: input.variabilityBps,
      isActive: input.isActive,
      ...(input.detectionRule === undefined
        ? {}
        : { detectionRule: dbJsonOrNull(input.detectionRule) }),
    });
    return context.json(
      {
        id,
        name: input.name,
        cadence: input.cadence,
        typicalAmount: moneyJson(amount.minor, amount.currency),
        nextExpectedDate: input.nextExpectedDate,
        isActive: input.isActive,
      },
      201,
    );
  });

  routes.patch("/income-sources/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(incomeSources)
      .where(
        and(
          eq(incomeSources.householdId, auth.householdId),
          eq(incomeSources.id, context.req.param("id")),
        ),
      )
      .get();
    if (!current) throw new NotFoundError("Income source");
    const input = incomeSourcePatchSchema.parse(await context.req.json());
    if (input.accountId) await requireAccount(db, auth.householdId, input.accountId);
    await db
      .update(incomeSources)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.merchantId === undefined ? {} : { merchantId: input.merchantId }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.recurringSeriesId === undefined
          ? {}
          : { recurringSeriesId: input.recurringSeriesId }),
        ...(input.cadence === undefined ? {} : { cadence: input.cadence }),
        ...(input.cadenceConfig === undefined
          ? {}
          : { cadenceConfig: dbJsonOrNull(input.cadenceConfig) }),
        ...(input.typicalAmount
          ? {
              typicalAmount: BigInt(input.typicalAmount.minorUnits),
              currency: input.typicalAmount.currency,
            }
          : input.typicalAmountMinorUnits === undefined
            ? {}
            : { typicalAmount: BigInt(input.typicalAmountMinorUnits) }),
        ...(input.nextExpectedDate === undefined
          ? {}
          : { nextExpectedDate: input.nextExpectedDate }),
        ...(input.variabilityBps === undefined ? {} : { variabilityBps: input.variabilityBps }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        ...(input.detectionRule === undefined
          ? {}
          : { detectionRule: dbJsonOrNull(input.detectionRule) }),
        updatedAt: nowIso(),
      })
      .where(
        and(eq(incomeSources.householdId, auth.householdId), eq(incomeSources.id, current.id)),
      );
    const updated = await db
      .select()
      .from(incomeSources)
      .where(and(eq(incomeSources.householdId, auth.householdId), eq(incomeSources.id, current.id)))
      .get();
    return context.json({
      ...updated!,
      typicalAmount: moneyJson(updated!.typicalAmount, updated!.currency),
    });
  });

  routes.delete("/income-sources/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(incomeSources)
      .set({ isActive: false, updatedAt: nowIso() })
      .where(
        and(
          eq(incomeSources.householdId, auth.householdId),
          eq(incomeSources.id, context.req.param("id")),
        ),
      )
      .returning({ id: incomeSources.id })
      .get();
    if (!result) throw new NotFoundError("Income source");
    return context.body(null, 204);
  });

  return routes;
}
