import { describe, expect, test } from "bun:test";
import { localDateKey, localMonthKey, localMonthStartInstant, shiftMonthKey } from "./dates";

describe("household-local date derivation", () => {
  test("derives the local date for an instant in the household timezone", () => {
    const instant = new Date("2026-07-01T02:00:00.000Z");
    expect(localDateKey(instant, "UTC")).toBe("2026-07-01");
    expect(localDateKey(instant, "America/New_York")).toBe("2026-06-30");
    expect(localDateKey(instant, "Pacific/Auckland")).toBe("2026-07-01");
  });

  test("derives the local month for an instant near a month boundary", () => {
    const instant = new Date("2026-08-01T01:00:00.000Z");
    expect(localMonthKey(instant, "UTC")).toBe("2026-08");
    expect(localMonthKey(instant, "America/Los_Angeles")).toBe("2026-07");
  });

  test("shifts month keys across year boundaries", () => {
    expect(shiftMonthKey("2026-07", 1)).toBe("2026-08");
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-12", 2)).toBe("2027-02");
    expect(shiftMonthKey("2026-07", -11)).toBe("2025-08");
  });

  test("computes the UTC instant of a local month start", () => {
    expect(localMonthStartInstant("2026-07", "UTC").toISOString()).toBe("2026-07-01T00:00:00.000Z");
    // July in New York is EDT (UTC-4).
    expect(localMonthStartInstant("2026-07", "America/New_York").toISOString()).toBe(
      "2026-07-01T04:00:00.000Z",
    );
    // Auckland in July is NZST (UTC+12).
    expect(localMonthStartInstant("2026-07", "Pacific/Auckland").toISOString()).toBe(
      "2026-06-30T12:00:00.000Z",
    );
    // January in New York is EST (UTC-5), proving the offset is computed per date.
    expect(localMonthStartInstant("2026-01", "America/New_York").toISOString()).toBe(
      "2026-01-01T05:00:00.000Z",
    );
  });
});
