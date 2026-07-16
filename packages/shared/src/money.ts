import { z } from "zod";

export const MIN_INT64 = -(1n << 63n);
export const MAX_INT64 = (1n << 63n) - 1n;
export const MAX_DECIMAL_PRECISION = 18;

export const CurrencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{2,11}$/, "Invalid currency code")
  .transform((value) => value.toUpperCase());

export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

export interface Money {
  readonly minorUnits: bigint;
  readonly currency: CurrencyCode;
}

const canonicalIntegerPattern = /^(?:0|-?[1-9]\d*)$/;

export const MinorUnitsStringSchema = z
  .string()
  .regex(canonicalIntegerPattern, "Minor units must be a canonical base-10 integer string")
  .refine((value) => {
    try {
      const parsed = BigInt(value);
      return parsed >= MIN_INT64 && parsed <= MAX_INT64;
    } catch {
      return false;
    }
  }, "Minor units exceed the signed 64-bit range");

export const MoneyJsonSchema = z
  .object({
    minorUnits: MinorUnitsStringSchema,
    currency: CurrencyCodeSchema,
  })
  .strict();

export type MoneyJson = z.infer<typeof MoneyJsonSchema>;
export type SerializedMoney = MoneyJson;

export const MoneySchema = z
  .object({
    minorUnits: z.bigint().refine(isInt64, "Minor units exceed the signed 64-bit range"),
    currency: CurrencyCodeSchema,
  })
  .strict();

export type RoundingMode = "half-even" | "half-up" | "down" | "up" | "reject";

export function isInt64(value: bigint): boolean {
  return value >= MIN_INT64 && value <= MAX_INT64;
}

export function checkedInt64(value: bigint, label = "minor units"): bigint {
  if (!isInt64(value)) {
    throw new RangeError(`${label} exceed the signed 64-bit range`);
  }
  return value;
}

export function normalizeCurrency(currency: string): CurrencyCode {
  return CurrencyCodeSchema.parse(currency);
}

export function money(minorUnits: bigint, currency: string): Money {
  return Object.freeze({
    minorUnits: checkedInt64(minorUnits),
    currency: normalizeCurrency(currency),
  });
}

export function zeroMoney(currency: string): Money {
  return money(0n, currency);
}

export function moneyFromJson(input: unknown): Money {
  const parsed = MoneyJsonSchema.parse(input);
  return money(BigInt(parsed.minorUnits), parsed.currency);
}

export const deserializeMoney = moneyFromJson;

export function moneyToJson(value: Money): MoneyJson {
  const parsed = MoneySchema.parse(value);
  return {
    minorUnits: parsed.minorUnits.toString(),
    currency: parsed.currency,
  };
}

export const serializeMoney = moneyToJson;

export function assertSameCurrency(left: Money, right: Money): CurrencyCode {
  if (left.currency !== right.currency) {
    throw new TypeError(`Currency mismatch: ${left.currency} and ${right.currency}`);
  }
  return left.currency;
}

export function addMoney(left: Money, right: Money): Money {
  const currency = assertSameCurrency(left, right);
  return money(checkedInt64(left.minorUnits + right.minorUnits), currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  const currency = assertSameCurrency(left, right);
  return money(checkedInt64(left.minorUnits - right.minorUnits), currency);
}

export function negateMoney(value: Money): Money {
  if (value.minorUnits === MIN_INT64) {
    throw new RangeError("Cannot negate the minimum signed 64-bit value");
  }
  return money(-value.minorUnits, value.currency);
}

export function absMoney(value: Money): Money {
  return value.minorUnits < 0n ? negateMoney(value) : value;
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  return left.minorUnits < right.minorUnits ? -1 : left.minorUnits > right.minorUnits ? 1 : 0;
}

export function minMoney(...values: readonly Money[]): Money {
  if (values.length === 0) throw new TypeError("minMoney requires at least one value");
  return values.reduce((best, current) => (compareMoney(current, best) < 0 ? current : best));
}

export function maxMoney(...values: readonly Money[]): Money {
  if (values.length === 0) throw new TypeError("maxMoney requires at least one value");
  return values.reduce((best, current) => (compareMoney(current, best) > 0 ? current : best));
}

export function sumMoney(values: readonly Money[], currency?: string): Money {
  if (values.length === 0) {
    if (currency === undefined)
      throw new TypeError("Currency is required when summing an empty list");
    return zeroMoney(currency);
  }
  const expected = normalizeCurrency(currency ?? values[0]!.currency);
  let total = 0n;
  for (const value of values) {
    if (value.currency !== expected) {
      throw new TypeError(`Currency mismatch: expected ${expected}, received ${value.currency}`);
    }
    total = checkedInt64(total + value.minorUnits);
  }
  return money(total, expected);
}

export function pow10(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > MAX_DECIMAL_PRECISION) {
    throw new RangeError(`Decimal precision must be an integer from 0 to ${MAX_DECIMAL_PRECISION}`);
  }
  return 10n ** BigInt(exponent);
}

/** Integer division with an explicit rounding policy. The divisor must be positive. */
export function divideAndRound(
  numerator: bigint,
  denominator: bigint,
  mode: Exclude<RoundingMode, "reject"> = "half-even",
): bigint {
  if (denominator <= 0n) throw new RangeError("Denominator must be positive");
  if (numerator === 0n) return 0n;

  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder === 0n) return sign * quotient;

  let increment = false;
  switch (mode) {
    case "down":
      increment = false;
      break;
    case "up":
      increment = true;
      break;
    case "half-up":
      increment = remainder * 2n >= denominator;
      break;
    case "half-even": {
      const doubled = remainder * 2n;
      increment = doubled > denominator || (doubled === denominator && quotient % 2n !== 0n);
      break;
    }
  }
  return sign * (quotient + (increment ? 1n : 0n));
}

export function multiplyMoneyByRatio(
  value: Money,
  numerator: bigint,
  denominator: bigint,
  rounding: Exclude<RoundingMode, "reject"> = "half-even",
): Money {
  if (denominator <= 0n) throw new RangeError("Denominator must be positive");
  return money(
    checkedInt64(divideAndRound(value.minorUnits * numerator, denominator, rounding)),
    value.currency,
  );
}

const decimalPattern = /^([+-]?)(\d+)(?:\.(\d+))?$/;

export interface ParsedDecimal {
  readonly numerator: bigint;
  readonly scale: number;
}

/** Parses a plain decimal without ever passing through a JavaScript number. */
export function parseDecimal(value: string, maxPrecision = MAX_DECIMAL_PRECISION): ParsedDecimal {
  const trimmed = value.trim();
  const match = decimalPattern.exec(trimmed);
  if (!match) throw new TypeError("Expected a plain base-10 decimal string");
  const fraction = match[3] ?? "";
  if (fraction.length > maxPrecision) {
    throw new RangeError(`Decimal has more than ${maxPrecision} fractional digits`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
  return { numerator: sign * BigInt(digits), scale: fraction.length };
}

export function parseDecimalToMinorUnits(
  value: string,
  fractionDigits: number,
  rounding: RoundingMode = "reject",
): bigint {
  const parsed = parseDecimal(value);
  if (
    !Number.isSafeInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > MAX_DECIMAL_PRECISION
  ) {
    throw new RangeError(`Fraction digits must be an integer from 0 to ${MAX_DECIMAL_PRECISION}`);
  }
  if (parsed.scale <= fractionDigits) {
    return checkedInt64(parsed.numerator * pow10(fractionDigits - parsed.scale));
  }

  const denominator = pow10(parsed.scale - fractionDigits);
  if (rounding === "reject") {
    if (parsed.numerator % denominator !== 0n) {
      throw new RangeError("Decimal cannot be represented exactly in minor units");
    }
    return checkedInt64(parsed.numerator / denominator);
  }
  return checkedInt64(divideAndRound(parsed.numerator, denominator, rounding));
}

export function formatMinorUnits(minorUnits: bigint, fractionDigits: number): string {
  checkedInt64(minorUnits);
  const factor = pow10(fractionDigits);
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  const whole = absolute / factor;
  if (fractionDigits === 0) return `${negative ? "-" : ""}${whole}`;
  const fraction = (absolute % factor).toString().padStart(fractionDigits, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function clampMoney(value: Money, minimum: Money, maximum: Money): Money {
  assertSameCurrency(value, minimum);
  assertSameCurrency(value, maximum);
  if (compareMoney(minimum, maximum) > 0) throw new RangeError("Minimum cannot exceed maximum");
  return compareMoney(value, minimum) < 0
    ? minimum
    : compareMoney(value, maximum) > 0
      ? maximum
      : value;
}
