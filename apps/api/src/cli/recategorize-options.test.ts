import { describe, expect, test } from "bun:test";
import { parseRecategorizeArgs } from "./recategorize-options";

describe("recategorize CLI options", () => {
  test("defaults to a bounded dry run", () => {
    expect(parseRecategorizeArgs([])).toEqual({
      mode: "dry-run",
      batches: 40,
      aiLimit: 25,
      help: false,
    });
  });

  test("parses an explicitly targeted resume without implying a reset", () => {
    expect(
      parseRecategorizeArgs([
        "--resume",
        "--user-email",
        " Max@Example.com ",
        "--batches=80",
        "--ai-limit",
        "30",
      ]),
    ).toEqual({
      mode: "resume",
      batches: 80,
      aiLimit: 30,
      userEmail: "max@example.com",
      help: false,
    });
  });

  test("rejects an implicit resume target and conflicting modes", () => {
    expect(() => parseRecategorizeArgs(["--resume"])).toThrow(
      "--resume requires an explicit --user-email or --household target",
    );
    expect(() => parseRecategorizeArgs(["--resume", "--household=household-1", "--apply"])).toThrow(
      "Choose exactly one",
    );
    expect(() => parseRecategorizeArgs(["--apply", "--dry-run"])).toThrow("Choose exactly one");
  });

  test("keeps batch and provider-call limits bounded", () => {
    expect(() => parseRecategorizeArgs(["--batches=101"])).toThrow("--batches");
    expect(() => parseRecategorizeArgs(["--ai-limit=51"])).toThrow("--ai-limit");
  });
});
