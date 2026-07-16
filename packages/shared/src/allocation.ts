import { z } from "zod";

import {
  addMoney,
  assertSameCurrency,
  type CurrencyCode,
  CurrencyCodeSchema,
  checkedInt64,
  type Money,
  type MoneyJson,
  MoneyJsonSchema,
  money,
  moneyFromJson,
  moneyToJson,
  subtractMoney,
  sumMoney,
  zeroMoney,
} from "./money.ts";

export const AllocationBucketSchema = z
  .string()
  .regex(
    /^(?:external|unassigned|released|envelope|goal|debt|investing|buffer):[A-Za-z0-9_-]+$/,
    "Invalid allocation bucket",
  );
export type AllocationBucket = z.infer<typeof AllocationBucketSchema>;

export const UNASSIGNED_BUCKET: AllocationBucket = "unassigned:cash";
export const RELEASED_BUCKET: AllocationBucket = "released:cash";

export const AllocationEntryJsonSchema = z
  .object({
    id: z.string().min(1).max(128),
    occurredAt: z.string().datetime({ offset: true }),
    from: AllocationBucketSchema,
    to: AllocationBucketSchema,
    amount: MoneyJsonSchema,
    kind: z.enum(["paycheck", "fund", "transfer", "spend", "release", "adjustment"]),
    paycheckId: z.string().min(1).max(128).optional(),
    memo: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.from === entry.to)
      context.addIssue({ code: "custom", path: ["to"], message: "Buckets must differ" });
    if (BigInt(entry.amount.minorUnits) <= 0n) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "Allocation amount must be positive",
      });
    }
  });

export type AllocationEntryJson = z.infer<typeof AllocationEntryJsonSchema>;

export interface AllocationEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly from: AllocationBucket;
  readonly to: AllocationBucket;
  readonly amount: Money;
  readonly kind: "paycheck" | "fund" | "transfer" | "spend" | "release" | "adjustment";
  readonly paycheckId?: string;
  readonly memo?: string;
}

export function allocationEntryFromJson(input: unknown): AllocationEntry {
  const entry = AllocationEntryJsonSchema.parse(input);
  return Object.freeze({
    id: entry.id,
    occurredAt: entry.occurredAt,
    from: entry.from,
    to: entry.to,
    amount: moneyFromJson(entry.amount),
    kind: entry.kind,
    ...(entry.paycheckId === undefined ? {} : { paycheckId: entry.paycheckId }),
    ...(entry.memo === undefined ? {} : { memo: entry.memo }),
  });
}

export function allocationEntryToJson(entry: AllocationEntry): AllocationEntryJson {
  return AllocationEntryJsonSchema.parse({ ...entry, amount: moneyToJson(entry.amount) });
}

export function allocationBalances(
  entries: readonly AllocationEntry[],
  currency: string,
  openingBalances: Readonly<Record<string, bigint>> = {},
): Readonly<Record<string, Money>> {
  const normalizedCurrency = CurrencyCodeSchema.parse(currency);
  const balances = new Map<string, bigint>();
  const entryIds = new Set<string>();
  for (const [bucket, balance] of Object.entries(openingBalances)) {
    AllocationBucketSchema.parse(bucket);
    balances.set(bucket, checkedInt64(balance));
  }
  for (const entry of entries) {
    if (!entry.id || entry.id.length > 128 || entryIds.has(entry.id))
      throw new TypeError(`Duplicate or invalid allocation entry id: ${entry.id}`);
    entryIds.add(entry.id);
    z.string().datetime({ offset: true }).parse(entry.occurredAt);
    AllocationBucketSchema.parse(entry.from);
    AllocationBucketSchema.parse(entry.to);
    if (entry.from === entry.to)
      throw new TypeError("Allocation source and destination must differ");
    if (entry.amount.currency !== normalizedCurrency)
      throw new TypeError("Allocation ledger currency mismatch");
    if (entry.amount.minorUnits <= 0n) throw new RangeError("Allocation amounts must be positive");
    balances.set(
      entry.from,
      checkedInt64((balances.get(entry.from) ?? 0n) - entry.amount.minorUnits),
    );
    balances.set(entry.to, checkedInt64((balances.get(entry.to) ?? 0n) + entry.amount.minorUnits));
  }
  return Object.freeze(
    Object.fromEntries(
      [...balances].map(([bucket, balance]) => [bucket, money(balance, normalizedCurrency)]),
    ),
  );
}

/** Every immutable entry debits exactly one bucket and credits exactly one bucket. */
export function assertAllocationConservation(
  entries: readonly AllocationEntry[],
  currency: string,
  openingBalances: Readonly<Record<string, bigint>> = {},
): true {
  const openingTotal = Object.values(openingBalances).reduce((sum, balance) => sum + balance, 0n);
  const closingTotal = Object.values(allocationBalances(entries, currency, openingBalances)).reduce(
    (sum, balance) => sum + balance.minorUnits,
    0n,
  );
  if (openingTotal !== closingTotal) throw new Error("Allocation ledger is not conserved");
  return true;
}

export class AllocationLedger {
  public readonly currency: CurrencyCode;
  public readonly entries: readonly AllocationEntry[];

  public constructor(currency: string, entries: readonly AllocationEntry[] = []) {
    this.currency = CurrencyCodeSchema.parse(currency);
    this.entries = Object.freeze([...entries]);
    assertAllocationConservation(this.entries, this.currency);
  }

  public post(entry: AllocationEntry): AllocationLedger {
    return new AllocationLedger(this.currency, [...this.entries, entry]);
  }

  public balances(): Readonly<Record<string, Money>> {
    return allocationBalances(this.entries, this.currency);
  }

  public balance(bucket: AllocationBucket): Money {
    return this.balances()[bucket] ?? zeroMoney(this.currency);
  }
}

export const EnvelopePrioritySchema = z.enum([
  "requiredBills",
  "minimumDebt",
  "coreLiving",
  "buffer",
  "goals",
  "investing",
  "flexible",
]);
export type EnvelopePriority = z.infer<typeof EnvelopePrioritySchema>;

const priorityOrder: Readonly<Record<EnvelopePriority, number>> = {
  requiredBills: 0,
  minimumDebt: 1,
  coreLiving: 2,
  buffer: 3,
  goals: 4,
  investing: 5,
  flexible: 6,
};

export interface EnvelopeFundingRequest {
  readonly envelopeId: string;
  readonly target: Money;
  readonly alreadyFunded?: Money;
  readonly priorityClass: EnvelopePriority;
  readonly priority?: number;
  readonly required?: boolean;
}

export interface EnvelopeFundingResult {
  readonly envelopeId: string;
  readonly requested: Money;
  readonly funded: Money;
  readonly shortfall: Money;
  readonly fullyFunded: boolean;
}

export interface PaycheckAllocationResult {
  readonly paycheckId: string;
  readonly income: Money;
  readonly entries: readonly AllocationEntry[];
  readonly envelopeFunding: readonly EnvelopeFundingResult[];
  readonly unassigned: Money;
}

export function allocatePaycheck(input: {
  readonly paycheckId: string;
  readonly amount: Money;
  readonly occurredAt: string;
  readonly requests: readonly EnvelopeFundingRequest[];
  readonly entryId?: (index: number, envelopeId?: string) => string;
}): PaycheckAllocationResult {
  if (input.amount.minorUnits <= 0n) throw new RangeError("Paycheck amount must be positive");
  const parsedDate = z.string().datetime({ offset: true }).parse(input.occurredAt);
  const sorted = input.requests
    .map((request, index) => ({ request, index }))
    .sort(
      (left, right) =>
        priorityOrder[left.request.priorityClass] - priorityOrder[right.request.priorityClass] ||
        (right.request.priority ?? 0) - (left.request.priority ?? 0) ||
        left.index - right.index,
    );
  const makeId = input.entryId ?? ((index: number) => `${input.paycheckId}:allocation:${index}`);
  const entries: AllocationEntry[] = [
    {
      id: makeId(0),
      occurredAt: parsedDate,
      from: `external:${input.paycheckId}`,
      to: UNASSIGNED_BUCKET,
      amount: input.amount,
      kind: "paycheck",
      paycheckId: input.paycheckId,
    },
  ];
  const funding: EnvelopeFundingResult[] = [];
  let remaining = input.amount.minorUnits;
  let entryIndex = 1;

  for (const { request } of sorted) {
    assertSameCurrency(input.amount, request.target);
    if (request.target.minorUnits < 0n) throw new RangeError("Envelope target cannot be negative");
    const alreadyFunded = request.alreadyFunded ?? zeroMoney(input.amount.currency);
    assertSameCurrency(input.amount, alreadyFunded);
    const needed =
      request.target.minorUnits > alreadyFunded.minorUnits
        ? request.target.minorUnits - alreadyFunded.minorUnits
        : 0n;
    const amount = needed < remaining ? needed : remaining;
    if (amount > 0n) {
      entries.push({
        id: makeId(entryIndex++, request.envelopeId),
        occurredAt: parsedDate,
        from: UNASSIGNED_BUCKET,
        to: `envelope:${request.envelopeId}`,
        amount: money(amount, input.amount.currency),
        kind: "fund",
        paycheckId: input.paycheckId,
      });
      remaining -= amount;
    }
    funding.push(
      Object.freeze({
        envelopeId: request.envelopeId,
        requested: money(needed, input.amount.currency),
        funded: money(amount, input.amount.currency),
        shortfall: money(needed - amount, input.amount.currency),
        fullyFunded: amount === needed,
      }),
    );
  }

  assertAllocationConservation(entries, input.amount.currency);
  return Object.freeze({
    paycheckId: input.paycheckId,
    income: input.amount,
    entries: Object.freeze(entries),
    envelopeFunding: Object.freeze(funding),
    unassigned: money(remaining, input.amount.currency),
  });
}

export interface EnvelopeAvailabilityInput {
  readonly openingBalance: Money;
  readonly funded: Money;
  readonly transferredIn?: Money;
  readonly transferredOut?: Money;
  /** Spending is positive here; refunds may be represented as negative activity. */
  readonly activity: Money;
}

export function calculateEnvelopeAvailability(input: EnvelopeAvailabilityInput): Money {
  const transferredIn = input.transferredIn ?? zeroMoney(input.openingBalance.currency);
  const transferredOut = input.transferredOut ?? zeroMoney(input.openingBalance.currency);
  for (const value of [input.funded, transferredIn, transferredOut, input.activity]) {
    assertSameCurrency(input.openingBalance, value);
  }
  return subtractMoney(
    subtractMoney(
      addMoney(addMoney(input.openingBalance, input.funded), transferredIn),
      transferredOut,
    ),
    input.activity,
  );
}

export interface SafeToSpendInput {
  readonly availableCash: Money;
  readonly reservedBills: Money;
  readonly envelopeCommitments: Money;
  readonly goalContributions: Money;
  readonly minimumBuffer: Money;
  readonly clampAtZero?: boolean;
  readonly provisional?: boolean;
}

export interface SafeToSpendResult {
  readonly safeToSpend: Money;
  readonly rawSafeToSpend: Money;
  readonly availableCash: Money;
  readonly totalReserved: Money;
  readonly reservedBills: Money;
  readonly envelopeCommitments: Money;
  readonly goalContributions: Money;
  readonly minimumBuffer: Money;
  readonly shortfall: Money;
  readonly provisional: boolean;
  readonly formula: "availableCash - reservedBills - envelopeCommitments - goalContributions - minimumBuffer";
}

export function calculateSafeToSpend(input: SafeToSpendInput): SafeToSpendResult {
  const deductions = [
    input.reservedBills,
    input.envelopeCommitments,
    input.goalContributions,
    input.minimumBuffer,
  ];
  for (const deduction of deductions) {
    assertSameCurrency(input.availableCash, deduction);
    if (deduction.minorUnits < 0n)
      throw new RangeError("Safe-to-spend deductions cannot be negative");
  }
  const totalReserved = sumMoney(deductions, input.availableCash.currency);
  const rawSafeToSpend = subtractMoney(input.availableCash, totalReserved);
  const clamped =
    (input.clampAtZero ?? true) && rawSafeToSpend.minorUnits < 0n
      ? zeroMoney(input.availableCash.currency)
      : rawSafeToSpend;
  const shortfall =
    rawSafeToSpend.minorUnits < 0n
      ? money(-rawSafeToSpend.minorUnits, input.availableCash.currency)
      : zeroMoney(input.availableCash.currency);
  return Object.freeze({
    safeToSpend: clamped,
    rawSafeToSpend,
    availableCash: input.availableCash,
    totalReserved,
    reservedBills: input.reservedBills,
    envelopeCommitments: input.envelopeCommitments,
    goalContributions: input.goalContributions,
    minimumBuffer: input.minimumBuffer,
    shortfall,
    provisional: input.provisional ?? false,
    formula:
      "availableCash - reservedBills - envelopeCommitments - goalContributions - minimumBuffer",
  });
}

export const safeToSpend = calculateSafeToSpend;

export const SafeToSpendJsonSchema = z
  .object({
    safeToSpend: MoneyJsonSchema,
    rawSafeToSpend: MoneyJsonSchema,
    availableCash: MoneyJsonSchema,
    totalReserved: MoneyJsonSchema,
    reservedBills: MoneyJsonSchema,
    envelopeCommitments: MoneyJsonSchema,
    goalContributions: MoneyJsonSchema,
    minimumBuffer: MoneyJsonSchema,
    shortfall: MoneyJsonSchema,
    provisional: z.boolean(),
    formula: z.literal(
      "availableCash - reservedBills - envelopeCommitments - goalContributions - minimumBuffer",
    ),
  })
  .strict();

export type SafeToSpendJson = z.infer<typeof SafeToSpendJsonSchema>;

export function safeToSpendToJson(result: SafeToSpendResult): SafeToSpendJson {
  return {
    safeToSpend: moneyToJson(result.safeToSpend),
    rawSafeToSpend: moneyToJson(result.rawSafeToSpend),
    availableCash: moneyToJson(result.availableCash),
    totalReserved: moneyToJson(result.totalReserved),
    reservedBills: moneyToJson(result.reservedBills),
    envelopeCommitments: moneyToJson(result.envelopeCommitments),
    goalContributions: moneyToJson(result.goalContributions),
    minimumBuffer: moneyToJson(result.minimumBuffer),
    shortfall: moneyToJson(result.shortfall),
    provisional: result.provisional,
    formula: result.formula,
  };
}

export interface PaycheckAllocationJson {
  readonly paycheckId: string;
  readonly income: MoneyJson;
  readonly entries: readonly AllocationEntryJson[];
  readonly unassigned: MoneyJson;
}
