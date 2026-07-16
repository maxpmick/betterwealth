import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  convertMoney,
  exchangeRateFromJson,
  minorToMajorString,
  parseMajorToMinor,
} from "./currency.ts";
import {
  addMoney,
  divideAndRound,
  formatMinorUnits,
  MAX_INT64,
  MIN_INT64,
  MoneyJsonSchema,
  money,
  moneyFromJson,
  moneyToJson,
  parseDecimalToMinorUnits,
  subtractMoney,
} from "./money.ts";

describe("exact money", () => {
  test("keeps JSON boundaries canonical and string-only", () => {
    expect(moneyToJson(money(-123_45n, "usd"))).toEqual({ minorUnits: "-12345", currency: "USD" });
    expect(moneyFromJson({ minorUnits: "9223372036854775807", currency: "USD" }).minorUnits).toBe(
      MAX_INT64,
    );
    expect(() => moneyFromJson({ minorUnits: 100, currency: "USD" })).toThrow();
    expect(() => moneyFromJson({ minorUnits: "01", currency: "USD" })).toThrow();
    expect(() => moneyFromJson({ minorUnits: "-0", currency: "USD" })).toThrow();
    expect(() => money(MAX_INT64 + 1n, "USD")).toThrow(RangeError);
    expect(() => money(MIN_INT64 - 1n, "USD")).toThrow(RangeError);
  });

  test("round-trips every signed 64-bit value through JSON", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: MIN_INT64, max: MAX_INT64 }), (minorUnits) => {
        const value = money(minorUnits, "USD");
        const json = moneyToJson(value);
        expect(MoneyJsonSchema.parse(json)).toEqual(json);
        expect(moneyFromJson(json)).toEqual(value);
      }),
    );
  });

  test("addition and subtraction are inverse when results fit", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
        (left, right) => {
          const original = money(left, "EUR");
          expect(
            subtractMoney(addMoney(original, money(right, "EUR")), money(right, "EUR")),
          ).toEqual(original);
        },
      ),
    );
  });

  test("parses and formats decimals without floating point", () => {
    expect(parseMajorToMinor("12.30", "USD")).toEqual(money(1_230n, "USD"));
    expect(minorToMajorString(money(-5n, "JPY"))).toBe("-5");
    expect(formatMinorUnits(-1n, 2)).toBe("-0.01");
    expect(() => parseMajorToMinor("1.001", "USD")).toThrow("cannot be represented exactly");
    expect(parseDecimalToMinorUnits("1.025", 2, "half-even")).toBe(102n);
    expect(parseDecimalToMinorUnits("1.035", 2, "half-even")).toBe(104n);
    expect(() => parseMajorToMinor("1e3", "USD")).toThrow();
  });

  test("banker's rounding is symmetric across zero", () => {
    expect(divideAndRound(5n, 2n)).toBe(2n);
    expect(divideAndRound(7n, 2n)).toBe(4n);
    expect(divideAndRound(-5n, 2n)).toBe(-2n);
    expect(divideAndRound(-7n, 2n)).toBe(-4n);
  });

  test("converts currencies using an explicit decimal rational", () => {
    const rate = exchangeRateFromJson({
      baseCurrency: "USD",
      quoteCurrency: "JPY",
      rate: "149.505",
    });
    expect(convertMoney(money(10_000n, "USD"), rate)).toEqual(money(14_950n, "JPY"));
    expect(
      convertMoney(money(1n, "USD"), { baseCurrency: "USD", quoteCurrency: "EUR", rate: "0.5" }),
    ).toEqual(money(0n, "EUR"));
    expect(
      convertMoney(money(3n, "USD"), { baseCurrency: "USD", quoteCurrency: "EUR", rate: "0.5" }),
    ).toEqual(money(2n, "EUR"));
    expect(() => convertMoney(money(100n, "EUR"), rate)).toThrow("starts in USD");
  });
});
