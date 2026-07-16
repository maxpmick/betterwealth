import { describe, expect, test } from "bun:test";
import { decodeSetupToken } from "./simplefin";

describe("SimpleFIN setup token", () => {
  test("decodes a valid HTTPS claim URL", () => {
    const token = Buffer.from("https://bridge.simplefin.org/simplefin/claim/demo").toString(
      "base64",
    );
    expect(decodeSetupToken(token).hostname).toBe("bridge.simplefin.org");
    const betaToken = Buffer.from(
      "https://beta-bridge.simplefin.org/simplefin/claim/demo",
    ).toString("base64");
    expect(decodeSetupToken(betaToken).hostname).toBe("beta-bridge.simplefin.org");
  });

  test("rejects non-HTTPS and non-claim URLs", () => {
    expect(() =>
      decodeSetupToken(Buffer.from("http://example.com/claim/nope").toString("base64")),
    ).toThrow();
    expect(() =>
      decodeSetupToken(Buffer.from("https://example.com/accounts").toString("base64")),
    ).toThrow();
    expect(() =>
      decodeSetupToken(Buffer.from("https://example.com/simplefin/claim/nope").toString("base64")),
    ).toThrow();
  });
});
