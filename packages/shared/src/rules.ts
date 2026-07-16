import { z } from "zod";

import { MinorUnitsStringSchema, type Money, type MoneyJson, money, moneyToJson } from "./money.ts";

export const MAX_REGEX_LENGTH = 256;
export const MAX_REGEX_INPUT_LENGTH = 4_096;

const idSchema = z.string().min(1).max(128);

const descriptionConditionSchema = z
  .object({
    field: z.enum(["description", "rawDescription", "normalizedDescription"]),
    operator: z.enum(["exact", "contains", "startsWith", "endsWith", "regex"]),
    value: z.string().min(1).max(MAX_REGEX_INPUT_LENGTH),
    caseSensitive: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((condition, context) => {
    if (condition.operator !== "regex") return;
    const result = validateSafeRegex(condition.value);
    if (!result.safe) context.addIssue({ code: "custom", path: ["value"], message: result.reason });
  });

const textExactConditionSchema = z
  .object({
    field: z.enum([
      "merchant",
      "merchantAlias",
      "accountId",
      "accountGroup",
      "accountType",
      "institutionId",
      "currency",
      "recurringSeriesId",
      "importSource",
    ]),
    operator: z.enum(["exact", "in"]),
    value: z.union([
      z.string().min(1).max(256),
      z.array(z.string().min(1).max(256)).min(1).max(100),
    ]),
    caseSensitive: z.boolean().optional().default(false),
  })
  .strict();

const amountConditionSchema = z
  .object({
    field: z.literal("amount"),
    operator: z.enum(["exact", "between", "absoluteBetween"]),
    value: MinorUnitsStringSchema.optional(),
    minimum: MinorUnitsStringSchema.optional(),
    maximum: MinorUnitsStringSchema.optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    if (condition.operator === "exact") {
      if (condition.value === undefined) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "Exact amount requires a value",
        });
      }
      if (condition.minimum !== undefined || condition.maximum !== undefined) {
        context.addIssue({ code: "custom", message: "Exact amount does not accept a range" });
      }
      return;
    }
    if (condition.value !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Amount range does not accept a value",
      });
    }
    if (condition.minimum === undefined || condition.maximum === undefined) {
      context.addIssue({ code: "custom", message: "Amount range requires minimum and maximum" });
      return;
    }
    if (BigInt(condition.minimum) > BigInt(condition.maximum)) {
      context.addIssue({ code: "custom", message: "Amount range minimum cannot exceed maximum" });
    }
    if (condition.operator === "absoluteBetween" && BigInt(condition.minimum) < 0n) {
      context.addIssue({
        code: "custom",
        path: ["minimum"],
        message: "Absolute amount minimum cannot be negative",
      });
    }
  });

const dateConditionSchema = z
  .object({
    field: z.enum(["date", "dayOfWeek", "dayOfMonth"]),
    operator: z.enum(["exact", "between", "in"]),
    value: z
      .union([
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        z.number().int().min(0).max(31),
        z.array(z.number().int().min(0).max(31)).min(1).max(31),
      ])
      .optional(),
    minimum: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    maximum: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    if (condition.field === "date") {
      if (condition.operator === "between") {
        if (!condition.minimum || !condition.maximum) {
          context.addIssue({ code: "custom", message: "Date range requires minimum and maximum" });
        } else if (condition.minimum > condition.maximum) {
          context.addIssue({ code: "custom", message: "Date minimum cannot exceed maximum" });
        }
      } else if (typeof condition.value !== "string") {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "Date condition requires a date string",
        });
      }
      return;
    }
    if (condition.operator === "between") {
      context.addIssue({
        code: "custom",
        path: ["operator"],
        message: "Day fields do not support between",
      });
      return;
    }
    const numbers = Array.isArray(condition.value) ? condition.value : [condition.value];
    const minimum = condition.field === "dayOfWeek" ? 0 : 1;
    const maximum = condition.field === "dayOfWeek" ? 6 : 31;
    if (numbers.some((value) => typeof value !== "number" || value < minimum || value > maximum)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `${condition.field} values must be ${minimum}-${maximum}`,
      });
    }
  });

const simpleConditionSchema = z.discriminatedUnion("field", [
  z
    .object({
      field: z.literal("direction"),
      operator: z.literal("exact"),
      value: z.enum(["inflow", "outflow", "zero"]),
    })
    .strict(),
  z
    .object({
      field: z.literal("status"),
      operator: z.literal("exact"),
      value: z.enum(["pending", "posted"]),
    })
    .strict(),
  z.object({ field: z.literal("pending"), operator: z.literal("is"), value: z.boolean() }).strict(),
  z
    .object({
      field: z.literal("hasCategory"),
      operator: z.literal("is"),
      value: z.boolean(),
      categoryId: idSchema.optional(),
    })
    .strict(),
  z
    .object({
      field: z.literal("hasTag"),
      operator: z.literal("is"),
      value: z.boolean(),
      tagId: idSchema,
    })
    .strict(),
]);

export type RuleCondition =
  | z.infer<typeof descriptionConditionSchema>
  | z.infer<typeof textExactConditionSchema>
  | z.infer<typeof amountConditionSchema>
  | z.infer<typeof dateConditionSchema>
  | z.infer<typeof simpleConditionSchema>
  | { readonly all: readonly RuleCondition[] }
  | { readonly any: readonly RuleCondition[] }
  | { readonly not: RuleCondition };

export const RuleConditionSchema: z.ZodType<RuleCondition> = z.lazy(() =>
  z.union([
    descriptionConditionSchema,
    textExactConditionSchema,
    amountConditionSchema,
    dateConditionSchema,
    simpleConditionSchema,
    z.object({ all: z.array(RuleConditionSchema).min(1).max(50) }).strict(),
    z.object({ any: z.array(RuleConditionSchema).min(1).max(50) }).strict(),
    z.object({ not: RuleConditionSchema }).strict(),
  ]),
);

const fixedSplitSchema = z
  .object({
    amountMinor: MinorUnitsStringSchema,
    categoryId: idSchema,
    envelopeId: idSchema.optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();

const percentageSplitSchema = z
  .object({
    basisPoints: z.number().int().positive().max(10_000),
    categoryId: idSchema,
    envelopeId: idSchema.optional(),
    memo: z.string().max(500).optional(),
  })
  .strict();

export const RuleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("setCategory"), categoryId: idSchema }).strict(),
  z.object({ type: z.literal("setEnvelope"), envelopeId: idSchema }).strict(),
  z
    .object({ type: z.literal("normalizeMerchant"), merchant: z.string().trim().min(1).max(256) })
    .strict(),
  z.object({ type: z.literal("addTags"), tagIds: z.array(idSchema).min(1).max(100) }).strict(),
  z.object({ type: z.literal("removeTags"), tagIds: z.array(idSchema).min(1).max(100) }).strict(),
  z
    .object({
      type: z.literal("setFlag"),
      flag: z.enum(["transfer", "income", "reimbursement", "reportingExcluded"]),
      value: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("attachRecurringSeries"), recurringSeriesId: idSchema }).strict(),
  z.object({ type: z.literal("prefixNote"), prefix: z.string().min(1).max(500) }).strict(),
  z
    .object({
      type: z.literal("createFixedSplits"),
      splits: z.array(fixedSplitSchema).min(2).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("createPercentageSplits"),
      splits: z.array(percentageSplitSchema).min(2).max(100),
    })
    .strict()
    .refine(
      (action) => action.splits.reduce((sum, split) => sum + split.basisPoints, 0) === 10_000,
      {
        message: "Percentage splits must total 10,000 basis points",
        path: ["splits"],
      },
    ),
  z.object({ type: z.literal("requestReview"), value: z.boolean().default(true) }).strict(),
]);

export type RuleAction = z.infer<typeof RuleActionSchema>;

export const CategorizationRuleSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(160),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    enabled: z.boolean().default(true),
    origin: z.enum(["user", "approvedAi", "system"]).default("user"),
    condition: RuleConditionSchema,
    actions: z.array(RuleActionSchema).min(1).max(50),
    createdAt: z.string().datetime({ offset: true }).optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CategorizationRule = z.infer<typeof CategorizationRuleSchema>;

export interface RuleTransaction {
  readonly id: string;
  readonly rawDescription: string;
  readonly normalizedDescription: string;
  readonly merchant?: string;
  readonly merchantAliases?: readonly string[];
  readonly accountId: string;
  readonly accountGroup?: string;
  readonly accountType?: string;
  readonly institutionId?: string;
  readonly amount: Money;
  readonly date: string;
  readonly status: "pending" | "posted";
  readonly recurringSeriesId?: string;
  readonly importSource?: string;
  readonly categoryId?: string;
  readonly tagIds?: readonly string[];
  readonly note?: string;
}

export interface TransactionSplit {
  readonly amount: Money;
  readonly categoryId: string;
  readonly envelopeId?: string;
  readonly memo?: string;
}

export interface TransactionRulePatch {
  readonly categoryId?: string;
  readonly envelopeId?: string;
  readonly merchant?: string;
  readonly tagIds: readonly string[];
  readonly flags: Readonly<
    Partial<Record<"transfer" | "income" | "reimbursement" | "reportingExcluded", boolean>>
  >;
  readonly recurringSeriesId?: string;
  readonly note?: string;
  readonly splits?: readonly TransactionSplit[];
  readonly needsReview?: boolean;
}

export interface TransactionRulePatchJson {
  readonly categoryId?: string;
  readonly envelopeId?: string;
  readonly merchant?: string;
  readonly tagIds: readonly string[];
  readonly flags: Readonly<
    Partial<Record<"transfer" | "income" | "reimbursement" | "reportingExcluded", boolean>>
  >;
  readonly recurringSeriesId?: string;
  readonly note?: string;
  readonly splits?: readonly {
    readonly amount: MoneyJson;
    readonly categoryId: string;
    readonly envelopeId?: string;
    readonly memo?: string;
  }[];
  readonly needsReview?: boolean;
}

export function transactionRulePatchToJson(patch: TransactionRulePatch): TransactionRulePatchJson {
  return Object.freeze({
    ...(patch.categoryId === undefined ? {} : { categoryId: patch.categoryId }),
    ...(patch.envelopeId === undefined ? {} : { envelopeId: patch.envelopeId }),
    ...(patch.merchant === undefined ? {} : { merchant: patch.merchant }),
    tagIds: Object.freeze([...patch.tagIds]),
    flags: patch.flags,
    ...(patch.recurringSeriesId === undefined
      ? {}
      : { recurringSeriesId: patch.recurringSeriesId }),
    ...(patch.note === undefined ? {} : { note: patch.note }),
    ...(patch.splits === undefined
      ? {}
      : {
          splits: Object.freeze(
            patch.splits.map((split) =>
              Object.freeze({
                amount: moneyToJson(split.amount),
                categoryId: split.categoryId,
                ...(split.envelopeId === undefined ? {} : { envelopeId: split.envelopeId }),
                ...(split.memo === undefined ? {} : { memo: split.memo }),
              }),
            ),
          ),
        }),
    ...(patch.needsReview === undefined ? {} : { needsReview: patch.needsReview }),
  });
}

export const serializeTransactionRulePatch = transactionRulePatchToJson;

export interface SafeRegexValidation {
  readonly safe: boolean;
  readonly reason: string;
}

export function validateSafeRegex(pattern: string): SafeRegexValidation {
  if (pattern.length === 0) return { safe: false, reason: "Regex cannot be empty" };
  if (pattern.length > MAX_REGEX_LENGTH) {
    return { safe: false, reason: `Regex cannot exceed ${MAX_REGEX_LENGTH} characters` };
  }
  if (/\\(?:[1-9]|k<)/.test(pattern))
    return { safe: false, reason: "Regex backreferences are not allowed" };
  if (/\(\?(?:[=!]|<[=!])/.test(pattern))
    return { safe: false, reason: "Regex lookarounds are not allowed" };
  if (/\(\?<[^=!]/.test(pattern))
    return { safe: false, reason: "Named capture groups are not allowed" };
  if (/\([^)]*\)[+*{]/.test(pattern))
    return { safe: false, reason: "Quantified groups are not allowed" };
  if (/(?:\.\*|\.\+|\[[^\]]+\][+*])/.test(pattern)) {
    return {
      safe: false,
      reason: "Unbounded wildcard or character-class repetition is not allowed",
    };
  }
  if (/(?:\*|\+|\?|\{\d+(?:,\d*)?\})(?:\*|\+|\?|\{)/.test(pattern)) {
    return { safe: false, reason: "Nested or consecutive quantifiers are not allowed" };
  }
  if ((pattern.match(/\|/g)?.length ?? 0) > 12)
    return { safe: false, reason: "Regex has too many alternatives" };
  try {
    new RegExp(pattern, "u");
  } catch {
    return { safe: false, reason: "Regex is not syntactically valid" };
  }
  return { safe: true, reason: "Regex is within the supported safe subset" };
}

export function compileSafeRegex(pattern: string, caseSensitive = false): RegExp {
  const result = validateSafeRegex(pattern);
  if (!result.safe) throw new TypeError(result.reason);
  return new RegExp(pattern, caseSensitive ? "u" : "iu");
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function compareText(actual: string, expected: string, caseSensitive: boolean): [string, string] {
  return caseSensitive ? [actual, expected] : [normalized(actual), normalized(expected)];
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

export function matchesRuleCondition(
  transaction: RuleTransaction,
  condition: RuleCondition,
): boolean {
  if ("all" in condition)
    return condition.all.every((child) => matchesRuleCondition(transaction, child));
  if ("any" in condition)
    return condition.any.some((child) => matchesRuleCondition(transaction, child));
  if ("not" in condition) return !matchesRuleCondition(transaction, condition.not);

  if (
    condition.field === "description" ||
    condition.field === "rawDescription" ||
    condition.field === "normalizedDescription"
  ) {
    const actual =
      condition.field === "rawDescription"
        ? transaction.rawDescription
        : transaction.normalizedDescription;
    if (condition.operator === "regex") {
      return compileSafeRegex(condition.value, condition.caseSensitive).test(
        actual.slice(0, MAX_REGEX_INPUT_LENGTH),
      );
    }
    const [left, right] = compareText(actual, condition.value, condition.caseSensitive);
    switch (condition.operator) {
      case "exact":
        return left === right;
      case "contains":
        return left.includes(right);
      case "startsWith":
        return left.startsWith(right);
      case "endsWith":
        return left.endsWith(right);
    }
  }

  if (condition.field === "amount") {
    const amount =
      condition.operator === "absoluteBetween" && transaction.amount.minorUnits < 0n
        ? -transaction.amount.minorUnits
        : transaction.amount.minorUnits;
    if (condition.operator === "exact") return amount === BigInt(condition.value!);
    return amount >= BigInt(condition.minimum!) && amount <= BigInt(condition.maximum!);
  }

  if (
    condition.field === "date" ||
    condition.field === "dayOfWeek" ||
    condition.field === "dayOfMonth"
  ) {
    const dateText = transaction.date.slice(0, 10);
    if (!isDate(dateText)) return false;
    if (condition.field === "date") {
      if (condition.operator === "between")
        return dateText >= condition.minimum! && dateText <= condition.maximum!;
      return dateText === condition.value;
    }
    const date = new Date(`${dateText}T00:00:00.000Z`);
    const actual = condition.field === "dayOfWeek" ? date.getUTCDay() : date.getUTCDate();
    const expected = Array.isArray(condition.value) ? condition.value : [condition.value];
    return expected.includes(actual);
  }

  if (condition.field === "direction") {
    const actual =
      transaction.amount.minorUnits > 0n
        ? "inflow"
        : transaction.amount.minorUnits < 0n
          ? "outflow"
          : "zero";
    return actual === condition.value;
  }
  if (condition.field === "status") return transaction.status === condition.value;
  if (condition.field === "pending") return (transaction.status === "pending") === condition.value;
  if (condition.field === "hasCategory") {
    const present = condition.categoryId
      ? transaction.categoryId === condition.categoryId
      : transaction.categoryId !== undefined;
    return present === condition.value;
  }
  if (condition.field === "hasTag")
    return (transaction.tagIds?.includes(condition.tagId) ?? false) === condition.value;

  let actual: string | readonly string[] | undefined;
  switch (condition.field) {
    case "merchant":
      actual = transaction.merchant;
      break;
    case "merchantAlias":
      actual = transaction.merchantAliases;
      break;
    case "accountId":
      actual = transaction.accountId;
      break;
    case "accountGroup":
      actual = transaction.accountGroup;
      break;
    case "accountType":
      actual = transaction.accountType;
      break;
    case "institutionId":
      actual = transaction.institutionId;
      break;
    case "currency":
      actual = transaction.amount.currency;
      break;
    case "recurringSeriesId":
      actual = transaction.recurringSeriesId;
      break;
    case "importSource":
      actual = transaction.importSource;
      break;
  }
  if (actual === undefined) return false;
  const actualValues = typeof actual === "string" ? [actual] : actual;
  const expectedValues = typeof condition.value === "string" ? [condition.value] : condition.value;
  return actualValues.some((left) =>
    expectedValues.some(
      (right) =>
        compareText(left, right, condition.caseSensitive)[0] ===
        compareText(left, right, condition.caseSensitive)[1],
    ),
  );
}

export function ruleSpecificity(condition: RuleCondition): number {
  if ("all" in condition)
    return (
      condition.all.reduce((score, child) => score + ruleSpecificity(child), 0) +
      condition.all.length
    );
  if ("any" in condition) return Math.max(...condition.any.map(ruleSpecificity));
  if ("not" in condition) return ruleSpecificity(condition.not);
  if (condition.field === "merchant" && condition.operator === "exact") return 1_000;
  if (condition.field === "accountId") return 950;
  if (
    (condition.field === "description" ||
      condition.field === "rawDescription" ||
      condition.field === "normalizedDescription") &&
    condition.operator === "exact"
  )
    return 900;
  if (condition.field === "institutionId" || condition.field === "recurringSeriesId") return 850;
  if (
    (condition.field === "description" ||
      condition.field === "rawDescription" ||
      condition.field === "normalizedDescription") &&
    condition.operator === "regex"
  ) {
    return condition.value.startsWith("^") && condition.value.endsWith("$") ? 750 : 650;
  }
  if (
    (condition.field === "description" ||
      condition.field === "rawDescription" ||
      condition.field === "normalizedDescription") &&
    (condition.operator === "startsWith" || condition.operator === "endsWith")
  )
    return 550;
  if (
    (condition.field === "description" ||
      condition.field === "rawDescription" ||
      condition.field === "normalizedDescription") &&
    condition.operator === "contains"
  )
    return 450;
  if (
    condition.field === "merchantAlias" ||
    condition.field === "accountGroup" ||
    condition.field === "accountType"
  )
    return 400;
  if (
    condition.field === "currency" ||
    condition.field === "status" ||
    condition.field === "pending" ||
    condition.field === "hasCategory" ||
    condition.field === "hasTag"
  )
    return 250;
  return 100;
}

function distributeByBasisPoints(total: bigint, basisPoints: readonly number[]): bigint[] {
  const sign = total < 0n ? -1n : 1n;
  const absolute = total < 0n ? -total : total;
  const allocations = basisPoints.map((points) => (absolute * BigInt(points)) / 10_000n);
  let remainder = absolute - allocations.reduce((sum, amount) => sum + amount, 0n);
  for (let index = 0; remainder > 0n; index = (index + 1) % allocations.length) {
    allocations[index] = allocations[index]! + 1n;
    remainder -= 1n;
  }
  return allocations.map((amount) => amount * sign);
}

export function applyRuleActions(
  transaction: RuleTransaction,
  actions: readonly RuleAction[],
): TransactionRulePatch {
  let categoryId: string | undefined;
  let envelopeId: string | undefined;
  let merchantName: string | undefined;
  let recurringSeriesId: string | undefined;
  let note = transaction.note;
  let splits: readonly TransactionSplit[] | undefined;
  let needsReview: boolean | undefined;
  const tags = new Set(transaction.tagIds ?? []);
  const flags: Partial<
    Record<"transfer" | "income" | "reimbursement" | "reportingExcluded", boolean>
  > = {};

  for (const action of actions) {
    switch (action.type) {
      case "setCategory":
        categoryId = action.categoryId;
        break;
      case "setEnvelope":
        envelopeId = action.envelopeId;
        break;
      case "normalizeMerchant":
        merchantName = action.merchant;
        break;
      case "addTags":
        for (const tagId of action.tagIds) tags.add(tagId);
        break;
      case "removeTags":
        for (const tagId of action.tagIds) tags.delete(tagId);
        break;
      case "setFlag":
        flags[action.flag] = action.value;
        break;
      case "attachRecurringSeries":
        recurringSeriesId = action.recurringSeriesId;
        break;
      case "prefixNote":
        note = note ? `${action.prefix}${note}` : action.prefix;
        break;
      case "requestReview":
        needsReview = action.value;
        break;
      case "createFixedSplits": {
        const total = action.splits.reduce((sum, split) => sum + BigInt(split.amountMinor), 0n);
        if (total !== transaction.amount.minorUnits) {
          throw new RangeError("Fixed splits must sum exactly to the transaction amount");
        }
        splits = action.splits.map((split) => ({
          amount: money(BigInt(split.amountMinor), transaction.amount.currency),
          categoryId: split.categoryId,
          ...(split.envelopeId === undefined ? {} : { envelopeId: split.envelopeId }),
          ...(split.memo === undefined ? {} : { memo: split.memo }),
        }));
        break;
      }
      case "createPercentageSplits": {
        const amounts = distributeByBasisPoints(
          transaction.amount.minorUnits,
          action.splits.map((split) => split.basisPoints),
        );
        splits = action.splits.map((split, index) => ({
          amount: money(amounts[index]!, transaction.amount.currency),
          categoryId: split.categoryId,
          ...(split.envelopeId === undefined ? {} : { envelopeId: split.envelopeId }),
          ...(split.memo === undefined ? {} : { memo: split.memo }),
        }));
        break;
      }
    }
  }

  return Object.freeze({
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(envelopeId === undefined ? {} : { envelopeId }),
    ...(merchantName === undefined ? {} : { merchant: merchantName }),
    tagIds: Object.freeze([...tags].sort()),
    flags: Object.freeze(flags),
    ...(recurringSeriesId === undefined ? {} : { recurringSeriesId }),
    ...(note === undefined ? {} : { note }),
    ...(splits === undefined ? {} : { splits: Object.freeze(splits) }),
    ...(needsReview === undefined ? {} : { needsReview }),
  });
}

export interface RuleEvaluation {
  readonly origin: "rule";
  readonly ruleId: string;
  readonly ruleName: string;
  readonly priority: number;
  readonly specificity: number;
  readonly competingRuleIds: readonly string[];
  readonly explanation: string;
  readonly patch: TransactionRulePatch;
}

export interface UserOverrideEvaluation {
  readonly origin: "userOverride";
  readonly explanation: string;
  readonly patch: TransactionRulePatch;
}

export type CategorizationEvaluation = UserOverrideEvaluation | RuleEvaluation;

export function evaluateRules(
  transaction: RuleTransaction,
  rules: readonly CategorizationRule[],
): RuleEvaluation | undefined {
  const matches = rules
    .map((rule) => CategorizationRuleSchema.parse(rule))
    .filter((rule) => rule.enabled && matchesRuleCondition(transaction, rule.condition))
    .map((rule) => ({ rule, specificity: ruleSpecificity(rule.condition) }))
    .sort(
      (left, right) =>
        right.rule.priority - left.rule.priority ||
        right.specificity - left.specificity ||
        right.rule.updatedAt.localeCompare(left.rule.updatedAt) ||
        left.rule.id.localeCompare(right.rule.id),
    );
  const winner = matches[0];
  if (!winner) return undefined;
  return Object.freeze({
    origin: "rule",
    ruleId: winner.rule.id,
    ruleName: winner.rule.name,
    priority: winner.rule.priority,
    specificity: winner.specificity,
    competingRuleIds: Object.freeze(matches.slice(1).map(({ rule }) => rule.id)),
    explanation: `Matched “${winner.rule.name}” at priority ${winner.rule.priority} and specificity ${winner.specificity}.`,
    patch: applyRuleActions(transaction, winner.rule.actions),
  });
}

/** Implements the top of the categorization precedence chain: a user override always beats rules. */
export function evaluateCategorization(
  transaction: RuleTransaction,
  rules: readonly CategorizationRule[],
  options: { readonly explicitOverride?: TransactionRulePatch } = {},
): CategorizationEvaluation | undefined {
  if (options.explicitOverride) {
    return Object.freeze({
      origin: "userOverride",
      explanation: "Applied the transaction's explicit user override before deterministic rules.",
      patch: options.explicitOverride,
    });
  }
  return evaluateRules(transaction, rules);
}

export interface RulePreviewItem {
  readonly transactionId: string;
  readonly before: RuleTransaction;
  readonly evaluation?: RuleEvaluation;
}

export function previewRules(
  transactions: readonly RuleTransaction[],
  rules: readonly CategorizationRule[],
): readonly RulePreviewItem[] {
  return Object.freeze(
    transactions.map((transaction) => {
      const evaluation = evaluateRules(transaction, rules);
      return Object.freeze({
        before: transaction,
        transactionId: transaction.id,
        ...(evaluation ? { evaluation } : {}),
      });
    }),
  );
}
