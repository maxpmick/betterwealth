import { z } from "zod";

import {
  type CurrencyCode,
  CurrencyCodeSchema,
  checkedInt64,
  divideAndRound,
  formatMinorUnits,
  MAX_DECIMAL_PRECISION,
  type Money,
  money,
  normalizeCurrency,
  parseDecimal,
  parseDecimalToMinorUnits,
  pow10,
} from "./money.ts";

export const CurrencyMetadataSchema = z
  .object({
    code: CurrencyCodeSchema,
    fractionDigits: z.number().int().min(0).max(MAX_DECIMAL_PRECISION),
    symbol: z.string().min(1).max(8),
    name: z.string().min(1).max(80),
  })
  .strict();

export type CurrencyMetadata = z.infer<typeof CurrencyMetadataSchema>;

const metadata = [
  { code: "USD", fractionDigits: 2, symbol: "$", name: "US Dollar" },
  { code: "EUR", fractionDigits: 2, symbol: "€", name: "Euro" },
  { code: "GBP", fractionDigits: 2, symbol: "£", name: "Pound Sterling" },
  { code: "CAD", fractionDigits: 2, symbol: "CA$", name: "Canadian Dollar" },
  { code: "AUD", fractionDigits: 2, symbol: "A$", name: "Australian Dollar" },
  { code: "NZD", fractionDigits: 2, symbol: "NZ$", name: "New Zealand Dollar" },
  { code: "CHF", fractionDigits: 2, symbol: "CHF", name: "Swiss Franc" },
  { code: "CNY", fractionDigits: 2, symbol: "¥", name: "Chinese Yuan" },
  { code: "INR", fractionDigits: 2, symbol: "₹", name: "Indian Rupee" },
  { code: "SEK", fractionDigits: 2, symbol: "kr", name: "Swedish Krona" },
  { code: "NOK", fractionDigits: 2, symbol: "kr", name: "Norwegian Krone" },
  { code: "DKK", fractionDigits: 2, symbol: "kr", name: "Danish Krone" },
  { code: "JPY", fractionDigits: 0, symbol: "¥", name: "Japanese Yen" },
  { code: "KRW", fractionDigits: 0, symbol: "₩", name: "South Korean Won" },
  { code: "KWD", fractionDigits: 3, symbol: "KD", name: "Kuwaiti Dinar" },
  { code: "BHD", fractionDigits: 3, symbol: "BD", name: "Bahraini Dinar" },
  { code: "BTC", fractionDigits: 8, symbol: "₿", name: "Bitcoin" },
] as const satisfies readonly CurrencyMetadata[];

export const CURRENCY_METADATA: Readonly<Record<string, CurrencyMetadata>> = Object.freeze(
  Object.fromEntries(metadata.map((entry) => [entry.code, Object.freeze({ ...entry })])),
);

export function getCurrencyMetadata(
  code: string,
  customCurrencies: Readonly<Record<string, CurrencyMetadata>> = {},
): CurrencyMetadata {
  const normalized = normalizeCurrency(code);
  const value = customCurrencies[normalized] ?? CURRENCY_METADATA[normalized];
  if (!value) throw new RangeError(`Unsupported currency: ${normalized}`);
  const parsed = CurrencyMetadataSchema.parse(value);
  if (parsed.code !== normalized)
    throw new TypeError(`Currency metadata key/code mismatch for ${normalized}`);
  return parsed;
}

export function parseMajorToMinor(
  value: string,
  currency: string,
  options: {
    readonly rounding?: "reject" | "half-even" | "half-up" | "down" | "up";
    readonly customCurrencies?: Readonly<Record<string, CurrencyMetadata>>;
  } = {},
): Money {
  const currencyMetadata = getCurrencyMetadata(currency, options.customCurrencies);
  return money(
    parseDecimalToMinorUnits(value, currencyMetadata.fractionDigits, options.rounding ?? "reject"),
    currencyMetadata.code,
  );
}

export function minorToMajorString(
  value: Money,
  customCurrencies: Readonly<Record<string, CurrencyMetadata>> = {},
): string {
  return formatMinorUnits(
    value.minorUnits,
    getCurrencyMetadata(value.currency, customCurrencies).fractionDigits,
  );
}

export const ExchangeRateJsonSchema = z
  .object({
    baseCurrency: CurrencyCodeSchema,
    quoteCurrency: CurrencyCodeSchema,
    rate: z.string().regex(/^\d+(?:\.\d+)?$/, "Rate must be a positive plain decimal string"),
    effectiveAt: z.string().datetime({ offset: true }).optional(),
    source: z.string().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      if (parseDecimal(value.rate).numerator <= 0n) {
        context.addIssue({
          code: "custom",
          path: ["rate"],
          message: "Rate must be greater than zero",
        });
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["rate"],
        message: error instanceof Error ? error.message : "Invalid rate",
      });
    }
  });

export type ExchangeRateJson = z.infer<typeof ExchangeRateJsonSchema>;

export interface RationalExchangeRate {
  readonly baseCurrency: CurrencyCode;
  readonly quoteCurrency: CurrencyCode;
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function exchangeRateFromJson(input: unknown): RationalExchangeRate {
  const parsed = ExchangeRateJsonSchema.parse(input);
  const decimal = parseDecimal(parsed.rate);
  const denominator = pow10(decimal.scale);
  const divisor = greatestCommonDivisor(decimal.numerator, denominator);
  return Object.freeze({
    baseCurrency: parsed.baseCurrency,
    quoteCurrency: parsed.quoteCurrency,
    numerator: decimal.numerator / divisor,
    denominator: denominator / divisor,
  });
}

export function invertExchangeRate(rate: RationalExchangeRate): RationalExchangeRate {
  if (rate.numerator <= 0n || rate.denominator <= 0n) throw new RangeError("Rate must be positive");
  return Object.freeze({
    baseCurrency: rate.quoteCurrency,
    quoteCurrency: rate.baseCurrency,
    numerator: rate.denominator,
    denominator: rate.numerator,
  });
}

/** Converts at an explicit rational rate and uses banker's rounding at the target minor-unit boundary. */
export function convertMoney(
  value: Money,
  rate: RationalExchangeRate | ExchangeRateJson,
  options: {
    readonly rounding?: "half-even" | "half-up" | "down" | "up";
    readonly customCurrencies?: Readonly<Record<string, CurrencyMetadata>>;
  } = {},
): Money {
  const rational = "rate" in rate ? exchangeRateFromJson(rate) : rate;
  if (value.currency !== rational.baseCurrency) {
    throw new TypeError(
      `Exchange rate starts in ${rational.baseCurrency}, received ${value.currency}`,
    );
  }
  if (rational.numerator <= 0n || rational.denominator <= 0n)
    throw new RangeError("Rate must be positive");

  const sourceDigits = getCurrencyMetadata(value.currency, options.customCurrencies).fractionDigits;
  const targetDigits = getCurrencyMetadata(
    rational.quoteCurrency,
    options.customCurrencies,
  ).fractionDigits;
  const numerator = value.minorUnits * rational.numerator * pow10(targetDigits);
  const denominator = rational.denominator * pow10(sourceDigits);
  const converted = divideAndRound(numerator, denominator, options.rounding ?? "half-even");
  return money(checkedInt64(converted, "converted minor units"), rational.quoteCurrency);
}
