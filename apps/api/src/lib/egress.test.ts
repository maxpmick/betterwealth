import { describe, expect, test } from "bun:test";
import { isPublicAddress, readLimitedText } from "./egress";

test("egress blocks private address ranges", () => {
  expect(isPublicAddress("127.0.0.1")).toBe(false);
  expect(isPublicAddress("10.1.2.3")).toBe(false);
  expect(isPublicAddress("192.168.1.2")).toBe(false);
  expect(isPublicAddress("169.254.169.254")).toBe(false);
  expect(isPublicAddress("100.64.0.1")).toBe(false);
  expect(isPublicAddress("192.0.2.1")).toBe(false);
  expect(isPublicAddress("198.18.0.1")).toBe(false);
  expect(isPublicAddress("198.51.100.1")).toBe(false);
  expect(isPublicAddress("203.0.113.1")).toBe(false);
  expect(isPublicAddress("::1")).toBe(false);
  expect(isPublicAddress("fc00::1")).toBe(false);
  expect(isPublicAddress("fe80::1")).toBe(false);
  expect(isPublicAddress("ff02::1")).toBe(false);
  expect(isPublicAddress("2001:db8::1")).toBe(false);
  expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  expect(isPublicAddress("::ffff:ac10:1")).toBe(false);
  expect(isPublicAddress("2002:7f00:1::1")).toBe(false);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
});

describe("bounded provider responses", () => {
  test("reads a response incrementally within the byte budget", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("safe "));
          controller.enqueue(new TextEncoder().encode("response"));
          controller.close();
        },
      }),
    );
    expect(await readLimitedText(response, 13)).toBe("safe response");
  });

  test("cancels a chunked response as soon as it exceeds the byte budget", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(readLimitedText(response, 10)).rejects.toMatchObject({
      code: "provider_too_large",
    });
    expect(cancelled).toBe(true);
  });
});
