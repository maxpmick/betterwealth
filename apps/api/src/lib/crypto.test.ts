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

  test("rejects tampered ciphertext and tampered auth tags", () => {
    const encrypted = cipher.encrypt("account-balance", "connection:abc");
    const parts = encrypted.split(".");

    // Flip one character in the base64url ciphertext segment.
    const ciphertext = parts[4] ?? "";
    const flippedChar = ciphertext[0] === "A" ? "B" : "A";
    const tamperedCiphertext = [...parts.slice(0, 4), flippedChar + ciphertext.slice(1)].join(".");
    expect(() => cipher.decrypt(tamperedCiphertext, "connection:abc")).toThrow();

    // Flip one character in the auth tag segment.
    const tag = parts[3] ?? "";
    const flippedTagChar = tag[0] === "A" ? "B" : "A";
    const tamperedTag = [...parts.slice(0, 3), flippedTagChar + tag.slice(1), parts[4]].join(".");
    expect(() => cipher.decrypt(tamperedTag, "connection:abc")).toThrow();
  });

  test("hash and constant-time equality helpers behave", () => {
    expect(sha256("same")).toBe(sha256("same"));
    expect(secureEqual("same", "same")).toBe(true);
    expect(secureEqual("same", "different")).toBe(false);
  });
});
