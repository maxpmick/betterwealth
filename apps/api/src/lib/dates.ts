/**
 * Household-local date derivation. Money transactions are stored as UTC
 * instants, but people budget in local months: a paycheck landing at 10pm in
 * New York belongs to that local day, not to "tomorrow" in UTC. Every place
 * that buckets by day or month derives it from the household timezone.
 */

function partsFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Local calendar date for an instant in a household timezone, as YYYY-MM-DD. */
export function localDateKey(instant: Date, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(instant);
}

/** Local calendar month for an instant in a household timezone, as YYYY-MM. */
export function localMonthKey(instant: Date, timeZone = "UTC"): string {
  return localDateKey(instant, timeZone).slice(0, 7);
}

/** Shift a YYYY-MM month key by whole months without timezone surprises. */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const total = (year ?? 0) * 12 + (month ?? 1) - 1 + delta;
  const shiftedYear = Math.floor(total / 12);
  const shiftedMonth = (total % 12) + 1;
  return `${shiftedYear}-${String(shiftedMonth).padStart(2, "0")}`;
}

/**
 * The UTC instant of local midnight on the 1st of a YYYY-MM month, computed
 * from the zone's offset at that moment (DST-safe within a one-hour edge).
 */
export function localMonthStartInstant(monthKey: string, timeZone = "UTC"): Date {
  const [year, month] = monthKey.split("-").map(Number);
  const guess = Date.UTC(year ?? 0, (month ?? 1) - 1, 1, 0, 0, 0);
  const parts = Object.fromEntries(
    partsFormatter(timeZone)
      .formatToParts(new Date(guess))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = localAsUtc - guess;
  return new Date(guess - offsetMs);
}
