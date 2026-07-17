import { describe, expect, test } from "bun:test";
import { assertSeedAllowed, parseSeedArgs, SEED_DEMO_OVERRIDE_FLAG } from "./seed-options";

describe("seed CLI options", () => {
  test("defaults to no production override", () => {
    expect(parseSeedArgs([])).toEqual({ allowProductionDemoData: false, help: false });
  });

  test("accepts the explicit demo-data override and help", () => {
    expect(parseSeedArgs([SEED_DEMO_OVERRIDE_FLAG])).toEqual({
      allowProductionDemoData: true,
      help: false,
    });
    expect(parseSeedArgs(["--help"])).toEqual({ allowProductionDemoData: false, help: true });
  });

  test("rejects unknown arguments", () => {
    expect(() => parseSeedArgs(["--force"])).toThrow("Unknown argument: --force");
  });

  test("allows seeding outside production without the flag", () => {
    expect(() => assertSeedAllowed(false, parseSeedArgs([]))).not.toThrow();
  });

  test("refuses to seed known-credential demo data into production by default", () => {
    expect(() => assertSeedAllowed(true, parseSeedArgs([]))).toThrow(/Refusing to seed/);
  });

  test("permits production seeding only with the explicit override", () => {
    expect(() => assertSeedAllowed(true, parseSeedArgs([SEED_DEMO_OVERRIDE_FLAG]))).not.toThrow();
  });
});
