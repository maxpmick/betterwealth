import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { rateLimit } from "./rate-limit";

function limitedApp(options: Parameters<typeof rateLimit>[0]) {
  const app = new Hono<AppEnv>();
  app.use("/limited", rateLimit(options));
  app.get("/limited", (context) => context.json({ ok: true }));
  return app;
}

function forwardedFor(ip: string) {
  return { "x-forwarded-for": ip };
}

describe("rate limiter", () => {
  test("rejects requests beyond the limit with a 429 contract error and RateLimit headers", async () => {
    const app = limitedApp({ limit: 2, windowMs: 60_000, keyPrefix: "test-limit" });

    const first = await app.request("/limited");
    expect(first.status).toBe(200);
    expect(first.headers.get("RateLimit-Limit")).toBe("2");
    expect(first.headers.get("RateLimit-Remaining")).toBe("1");
    expect(first.headers.get("RateLimit-Reset")).toMatch(/^\d+$/);

    const second = await app.request("/limited");
    expect(second.status).toBe(200);
    expect(second.headers.get("RateLimit-Remaining")).toBe("0");

    const third = await app.request("/limited");
    expect(third.status).toBe(429);
    expect(third.headers.get("RateLimit-Limit")).toBe("2");
    expect(third.headers.get("RateLimit-Remaining")).toBe("0");
    expect(third.headers.get("RateLimit-Reset")).toMatch(/^\d+$/);
    expect(await third.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests. Try again shortly." },
    });
  });

  test("allows requests again once the window expires", async () => {
    const app = limitedApp({ limit: 1, windowMs: 40, keyPrefix: "test-window" });

    expect((await app.request("/limited")).status).toBe(200);
    expect((await app.request("/limited")).status).toBe(429);

    await Bun.sleep(80);

    expect((await app.request("/limited")).status).toBe(200);
    expect((await app.request("/limited")).status).toBe(429);
  });

  test("tracks independent buckets per key", async () => {
    const app = limitedApp({
      limit: 1,
      windowMs: 60_000,
      keyPrefix: "test-keys",
      trustProxy: true,
    });

    expect((await app.request("/limited", { headers: forwardedFor("203.0.113.1") })).status).toBe(
      200,
    );
    expect((await app.request("/limited", { headers: forwardedFor("203.0.113.1") })).status).toBe(
      429,
    );
    // A different client address still has its own allowance.
    expect((await app.request("/limited", { headers: forwardedFor("203.0.113.2") })).status).toBe(
      200,
    );
  });

  test("ignores X-Forwarded-For unless trustProxy is enabled", async () => {
    const app = limitedApp({ limit: 2, windowMs: 60_000, keyPrefix: "test-proxy-off" });

    expect((await app.request("/limited", { headers: forwardedFor("203.0.113.10") })).status).toBe(
      200,
    );
    expect((await app.request("/limited", { headers: forwardedFor("203.0.113.11") })).status).toBe(
      200,
    );
    // Every spoofed address collapsed into the single direct-connection bucket.
    expect((await app.request("/limited", { headers: forwardedFor("203.0.113.12") })).status).toBe(
      429,
    );
  });

  test("honors the first X-Forwarded-For hop when trustProxy is enabled", async () => {
    const app = limitedApp({
      limit: 1,
      windowMs: 60_000,
      keyPrefix: "test-proxy-on",
      trustProxy: true,
    });

    expect(
      (await app.request("/limited", { headers: forwardedFor("203.0.113.20, 10.0.0.1") })).status,
    ).toBe(200);
    // Same client first hop behind a different upstream chain: still the same bucket.
    expect(
      (await app.request("/limited", { headers: forwardedFor("203.0.113.20, 10.9.9.9") })).status,
    ).toBe(429);
  });

  test("falls back to the direct address when forwarded headers are not valid IPs", async () => {
    const app = limitedApp({
      limit: 1,
      windowMs: 60_000,
      keyPrefix: "test-proxy-invalid",
      trustProxy: true,
    });

    expect((await app.request("/limited", { headers: forwardedFor("not-an-ip") })).status).toBe(
      200,
    );
    // Both junk headers fell back to the same unknown direct address.
    expect(
      (await app.request("/limited", { headers: forwardedFor("also-not-an-ip") })).status,
    ).toBe(429);
  });

  test("overflow bucket still rate-limits new keys once the bucket map is full", async () => {
    const app = limitedApp({
      limit: 2,
      windowMs: 600_000,
      keyPrefix: "test-overflow",
      trustProxy: true,
    });

    // Fill the bucket map to MAX_BUCKETS (10_000) with single-use keys.
    for (let index = 0; index < 10_000; index += 1) {
      const ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
      const response = await app.request("/limited", { headers: forwardedFor(ip) });
      expect(response.status).toBe(200);
    }

    // The map is full, so brand-new keys share one overflow bucket instead of
    // failing closed: the first overflow requests are still allowed...
    expect((await app.request("/limited", { headers: forwardedFor("192.0.2.1") })).status).toBe(
      200,
    );
    expect((await app.request("/limited", { headers: forwardedFor("192.0.2.2") })).status).toBe(
      200,
    );
    // ...but the overflow bucket counts too, so it does not fail open either:
    // the third new key inside the window trips the shared limit.
    expect((await app.request("/limited", { headers: forwardedFor("192.0.2.3") })).status).toBe(
      429,
    );
    // Keys that already own a bucket keep their own independent allowance.
    expect((await app.request("/limited", { headers: forwardedFor("10.0.0.0") })).status).toBe(200);
    expect((await app.request("/limited", { headers: forwardedFor("10.0.0.0") })).status).toBe(429);
  });
});
