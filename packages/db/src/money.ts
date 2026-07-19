import { MAX_INT64, MIN_INT64 } from "@betterwealth/shared";
import { customType } from "drizzle-orm/sqlite-core";

/** SQLite signed 64-bit bounds. Financial values are deliberately limited to this range. */
export const MIN_MINOR_UNITS = MIN_INT64;
export const MAX_MINOR_UNITS = MAX_INT64;

const CANONICAL_INTEGER = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;

export class MinorUnitRangeError extends RangeError {
  override readonly name = "MinorUnitRangeError";
}

/**
 * Parse a JSON/database minor-unit value without ever passing through a JavaScript number.
 * Non-canonical values (leading zeroes, plus signs, decimals, exponent notation) fail closed.
 */
export function parseMinorUnits(value: string | bigint): bigint {
  const serialized = typeof value === "bigint" ? value.toString(10) : value;
  if (!CANONICAL_INTEGER.test(serialized)) {
    throw new TypeError(`Invalid canonical minor-unit value: ${serialized}`);
  }

  const parsed = BigInt(serialized);
  if (parsed < MIN_MINOR_UNITS || parsed > MAX_MINOR_UNITS) {
    throw new MinorUnitRangeError(`Minor-unit value is outside signed 64-bit range: ${serialized}`);
  }
  return parsed;
}

/** Convert a checked signed 64-bit bigint into its canonical base-10 transport form. */
export function serializeMinorUnits(value: bigint): string {
  return parseMinorUnits(value).toString(10);
}

/** Checked addition for aggregates; throws instead of silently exceeding the persistence range. */
export function addMinorUnits(left: bigint, right: bigint): bigint {
  return parseMinorUnits(left + right);
}

/** Checked subtraction for aggregates; throws instead of silently exceeding the persistence range. */
export function subtractMinorUnits(left: bigint, right: bigint): bigint {
  return parseMinorUnits(left - right);
}

/** Checked absolute value. MIN_INT64 intentionally fails because its positive value is out of range. */
export function absMinorUnits(value: bigint): bigint {
  return parseMinorUnits(value < 0n ? -value : value);
}

/**
 * Drizzle column type backed by SQLite TEXT. Inserts/selects use bigint in TypeScript while the
 * driver only sees canonical base-10 strings, avoiding IEEE-754 precision loss.
 */
export const minorUnit = customType<{ data: bigint; driverData: string }>({
  dataType() {
    return "text";
  },
  fromDriver(value) {
    return parseMinorUnits(value);
  },
  toDriver(value) {
    return serializeMinorUnits(value);
  },
});
