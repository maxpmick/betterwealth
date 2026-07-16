import { isIP } from "node:net";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

type Bucket = { count: number; resetAt: number };
const MAX_BUCKETS = 10_000;

export function rateLimit(options: {
  limit: number;
  windowMs: number;
  keyPrefix: string;
  trustProxy?: boolean;
}): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();
  let overflowBucket: Bucket | undefined;
  let requestsSincePrune = 0;
  return async (context, next) => {
    const now = Date.now();
    requestsSincePrune += 1;
    if (requestsSincePrune >= 100) {
      for (const [entryKey, entry] of buckets) {
        if (entry.resetAt <= now) buckets.delete(entryKey);
      }
      requestsSincePrune = 0;
    }
    const forwarded = options.trustProxy
      ? context.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      : undefined;
    const realIp = options.trustProxy ? context.req.header("x-real-ip")?.trim() : undefined;
    const proxyAddress =
      forwarded && isIP(forwarded) ? forwarded : realIp && isIP(realIp) ? realIp : undefined;
    const directAddress = context.env?.remoteAddress;
    const address =
      proxyAddress ?? (directAddress && isIP(directAddress) ? directAddress : "unknown");
    const key = `${options.keyPrefix}:${address}`;
    const current = buckets.get(key);
    const usesOverflow = current === undefined && buckets.size >= MAX_BUCKETS;
    const bucket = usesOverflow
      ? !overflowBucket || overflowBucket.resetAt <= now
        ? { count: 0, resetAt: now + options.windowMs }
        : overflowBucket
      : !current || current.resetAt <= now
        ? { count: 0, resetAt: now + options.windowMs }
        : current;
    bucket.count += 1;
    if (usesOverflow) overflowBucket = bucket;
    else buckets.set(key, bucket);
    context.header("RateLimit-Limit", String(options.limit));
    context.header("RateLimit-Remaining", String(Math.max(0, options.limit - bucket.count)));
    context.header("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > options.limit) {
      return context.json(
        { error: { code: "rate_limited", message: "Too many requests. Try again shortly." } },
        429,
      );
    }
    await next();
  };
}
