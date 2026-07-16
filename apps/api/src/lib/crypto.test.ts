import { describe, expect, test } from "bun:test";
import { FieldCipher, secureEqual, sha256 } from "./crypto";

describe("field encryption", () => {
  const cipher = new FieldCipher("11".repeat(32));

  test("round trips authenticated values", () => {
    const encrypted = cipher.encrypt("https://user:secret@example.com/simplefin", "connection:abc");
    expect(encrypted).not.toContain("secret");
    expect(cipher.decrypt(encrypted, "connection:abc")).toBe(
      "https://user:secret@example.com/simplefin",
    );
  });

  test("rejects the wrong associated context", () => {
    const encrypted = cipher.encrypt("private", "user:one");
    expect(() => cipher.decrypt(encrypted, "user:two")).toThrow();
  });

  test("hash and constant-time equality helpers behave", () => {
    expect(sha256("same")).toBe(sha256("same"));
    expect(secureEqual("same", "same")).toBe(true);
    expect(secureEqual("same", "different")).toBe(false);
  });
});
