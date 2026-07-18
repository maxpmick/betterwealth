import type { MoneyJson } from "@betterwealth/shared";

/** Serialize checked minor units to the wire's base-10 money shape. */
export function moneyJson(minorUnits: bigint, currency: string): MoneyJson {
  return { minorUnits: minorUnits.toString(), currency };
}
