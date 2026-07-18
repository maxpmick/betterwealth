import type { BetterWealthDatabase } from "@betterwealth/db";
import { bills } from "@betterwealth/db/schema";
import { MoneyJsonSchema } from "@betterwealth/shared";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCsrf } from "../../auth/middleware";
import type { AppConfig } from "../../config";
import { ConflictError, NotFoundError } from "../../lib/errors";
import type { AppEnv } from "../../types";
import {
  currencySchema,
  dateSchema,
  dbJson,
  minorUnitsSchema,
  moneyJson,
  nowIso,
  optionalMoney,
  page,
  requireAccount,
  requireEnvelope,
} from "./shared";

const billCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    recurringSeriesId: z.string().optional(),
    envelopeId: z.string().optional(),
    autopayAccountId: z.string().optional(),
    dueRule: z.unknown().default({ cadence: "monthly" }),
    amountMin: MoneyJsonSchema.optional(),
    amountMinMinorUnits: minorUnitsSchema.optional(),
    amountMax: MoneyJsonSchema.optional(),
    amountMaxMinorUnits: minorUnitsSchema.optional(),
    currency: currencySchema.default("USD"),
    recurrenceConfidenceBps: z.number().int().min(0).max(10_000).default(0),
    nextDueDate: dateSchema.optional(),
    isRequired: z.boolean().default(true),
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, context) => {
    const minimum = BigInt(input.amountMin?.minorUnits ?? input.amountMinMinorUnits ?? "0");
    const maximum = BigInt(input.amountMax?.minorUnits ?? input.amountMaxMinorUnits ?? minimum);
    if (minimum > maximum) {
      context.addIssue({
        code: "custom",
        path: ["amountMax"],
        message: "Maximum must not be below minimum",
      });
    }
  });

const billPatchSchema = z.object(billCreateSchema.shape).partial().strict();

function billDto(row: typeof bills.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    recurringSeriesId: row.recurringSeriesId,
    envelopeId: row.envelopeId,
    autopayAccountId: row.autopayAccountId,
    dueRule: row.dueRule,
    amountMin: moneyJson(row.amountMin, row.currency),
    amountMax: moneyJson(row.amountMax, row.currency),
    recurrenceConfidenceBps: row.recurrenceConfidenceBps,
    nextDueDate: row.nextDueDate,
    isRequired: row.isRequired,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createBillRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();

  // Bills ------------------------------------------------------------------

  routes.get("/bills", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(bills)
      .where(eq(bills.householdId, auth.householdId))
      .orderBy(asc(bills.nextDueDate), asc(bills.name));
    return context.json(page(rows.map(billDto)));
  });

  routes.post("/bills", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = billCreateSchema.parse(await context.req.json());
    if (input.envelopeId) await requireEnvelope(db, auth.householdId, input.envelopeId);
    if (input.autopayAccountId) await requireAccount(db, auth.householdId, input.autopayAccountId);
    const minimum = optionalMoney(input.amountMin, input.amountMinMinorUnits, input.currency);
    const maximum = optionalMoney(
      input.amountMax,
      input.amountMaxMinorUnits ?? minimum.minor.toString(),
      minimum.currency,
    );
    if (minimum.currency !== maximum.currency) {
      throw new ConflictError("Bill amount currencies must match", "currency_mismatch");
    }
    const id = ulid();
    await db.insert(bills).values({
      id,
      householdId: auth.householdId,
      name: input.name,
      ...(input.recurringSeriesId ? { recurringSeriesId: input.recurringSeriesId } : {}),
      ...(input.envelopeId ? { envelopeId: input.envelopeId } : {}),
      ...(input.autopayAccountId ? { autopayAccountId: input.autopayAccountId } : {}),
      dueRule: dbJson(input.dueRule),
      amountMin: minimum.minor,
      amountMax: maximum.minor,
      currency: minimum.currency,
      recurrenceConfidenceBps: input.recurrenceConfidenceBps,
      ...(input.nextDueDate ? { nextDueDate: input.nextDueDate } : {}),
      isRequired: input.isRequired,
      isActive: input.isActive,
    });
    const row = await db
      .select()
      .from(bills)
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, id)))
      .get();
    return context.json(billDto(row!), 201);
  });

  routes.patch("/bills/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(bills)
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, context.req.param("id"))))
      .get();
    if (!current) throw new NotFoundError("Bill");
    const input = billPatchSchema.parse(await context.req.json());
    await db
      .update(bills)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.envelopeId === undefined ? {} : { envelopeId: input.envelopeId }),
        ...(input.autopayAccountId === undefined
          ? {}
          : { autopayAccountId: input.autopayAccountId }),
        ...(input.dueRule === undefined ? {} : { dueRule: dbJson(input.dueRule) }),
        ...(input.amountMin
          ? { amountMin: BigInt(input.amountMin.minorUnits), currency: input.amountMin.currency }
          : input.amountMinMinorUnits === undefined
            ? {}
            : { amountMin: BigInt(input.amountMinMinorUnits) }),
        ...(input.amountMax
          ? { amountMax: BigInt(input.amountMax.minorUnits), currency: input.amountMax.currency }
          : input.amountMaxMinorUnits === undefined
            ? {}
            : { amountMax: BigInt(input.amountMaxMinorUnits) }),
        ...(input.recurrenceConfidenceBps === undefined
          ? {}
          : { recurrenceConfidenceBps: input.recurrenceConfidenceBps }),
        ...(input.nextDueDate === undefined ? {} : { nextDueDate: input.nextDueDate }),
        ...(input.isRequired === undefined ? {} : { isRequired: input.isRequired }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        updatedAt: nowIso(),
      })
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, current.id)));
    const updated = await db
      .select()
      .from(bills)
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, current.id)))
      .get();
    return context.json(billDto(updated!));
  });

  routes.delete("/bills/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(bills)
      .set({ isActive: false, updatedAt: nowIso() })
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, context.req.param("id"))))
      .returning({ id: bills.id })
      .get();
    if (!result) throw new NotFoundError("Bill");
    return context.body(null, 204);
  });

  return routes;
}
