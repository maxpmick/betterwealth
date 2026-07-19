import { CURRENCY_METADATA, formatMinorUnits } from "@betterwealth/shared";

/**
 * Web money display helpers. The API transports money as base-10 minor-unit
 * strings; these helpers are the only places that may scale them for display.
 * Charts may consume numbers (plotting is inherently approximate), but the
 * scale must come from the currency metadata, never a hardcoded /100.
 */

export function fractionDigitsFor(currency: string): number {
  return CURRENCY_METADATA[currency.toUpperCase()]?.fractionDigits ?? 2;
}

export function currencySymbol(currency: string): string {
  return CURRENCY_METADATA[currency.toUpperCase()]?.symbol ?? `${currency.toUpperCase()} `;
}

/** Exact minor-unit string -> major-unit number for display/chart input. */
export function minorToMajor(minorUnits: string | bigint, currency: string): number {
  const raw = typeof minorUnits === "bigint" ? minorUnits.toString(10) : minorUnits;
  return Number(formatMinorUnits(BigInt(raw), fractionDigitsFor(currency)));
}

/**
 * Exact minor-unit string -> formatted display string. The fraction part never
 * passes through a float; grouping uses Intl with the currency's own metadata.
 */
export function formatMoneyExact(
  minorUnits: string | bigint,
  currency = "USD",
  options: { compact?: boolean } = {},
): string {
  const raw = typeof minorUnits === "bigint" ? minorUnits.toString(10) : minorUnits;
  const digits = fractionDigitsFor(currency);
  const exact = formatMinorUnits(BigInt(raw), digits);
  const iso = CURRENCY_METADATA[currency.toUpperCase()];

  if (options.compact || iso) {
    // Intl knows the ISO codes and their symbols/rounding; BTC and unknown
    // codes only ever take the non-compact manual path.
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
        notation: options.compact ? "compact" : "standard",
        maximumFractionDigits: options.compact ? 1 : digits,
      }).format(Number(exact));
    } catch {
      // Fall through to the manual path for codes Intl rejects.
    }
  }

  const negative = exact.startsWith("-");
  const unsigned = negative ? exact.slice(1) : exact;
  const [whole = "0", fraction] = unsigned.split(".");
  const grouped = new Intl.NumberFormat("en-US", { useGrouping: true }).format(BigInt(whole));
  const symbol = currencySymbol(currency);
  const rendered =
    fraction && !/^0+$/.test(fraction) ? `${symbol}${grouped}.${fraction}` : `${symbol}${grouped}`;
  return negative ? `-${rendered}` : rendered;
}

/** Shared chart tick formatter: compact, currency-aware, no hardcoded symbols. */
export function chartTickFormatter(currency: string) {
  return (value: number | null | undefined) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(Number(value ?? 0));
}
