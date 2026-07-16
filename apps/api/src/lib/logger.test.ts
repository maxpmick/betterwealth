import { expect, test } from "bun:test";
import { redact } from "./logger";

test("redacts credentials recursively", () => {
  expect(
    redact({
      apiKey: "sk-example-long-secret-value",
      nested: {
        accessUrl: "https://user:pass@example.com/simplefin",
        safe: "visible",
        message: "upstream said Bearer abcdefghijklmnopqrstuvwxyz012345",
      },
    }),
  ).toEqual({
    apiKey: "[REDACTED]",
    nested: {
      accessUrl: "[REDACTED]",
      safe: "visible",
      message: "upstream said Bearer [REDACTED]",
    },
  });
});
