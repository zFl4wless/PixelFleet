import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedWindowRateLimiter } from "../apps/backend/src/rate-limit";
import * as rateLimits from "../apps/backend/src/rate-limit";

afterEach(() => vi.useRealTimers());

describe("FixedWindowRateLimiter", () => {
  it("allows requests within the window and rejects overflow", () => {
    const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000 });

    expect(limiter.check("ip", 1, 1000).allowed).toBe(true);
    expect(limiter.check("ip", 1, 1100).allowed).toBe(true);
    expect(limiter.check("ip", 1, 1200).allowed).toBe(false);
  });

  it("resets after the window expires", () => {
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000 });

    expect(limiter.check("ip", 1, 1000).allowed).toBe(true);
    expect(limiter.check("ip", 1, 1200).allowed).toBe(false);
    expect(limiter.check("ip", 1, 2101).allowed).toBe(true);
  });
});

describe("periodic quota cleanup (TD-04)", () => {
  it("prunes many expired keys without further activity and preserves valid quotas at exact boundaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 1000; i++) limiter.check(`old-${i}`);
    expect(rateLimits.startRateLimitCleanup).toBeTypeOf("function");
    const stop = rateLimits.startRateLimitCleanup((now) => limiter.prune(now));
    try {
      vi.advanceTimersByTime(29_999);
      limiter.check("current");
      const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets;
      vi.advanceTimersByTime(30_000);
      expect(buckets.size).toBe(1001);
      vi.advanceTimersByTime(1);
      expect(buckets.size).toBe(1);
      expect(limiter.check("current").allowed).toBe(false);
      vi.advanceTimersByTime(29_998);
      expect(limiter.check("current").allowed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(limiter.check("current").allowed).toBe(true);
      vi.advanceTimersByTime(60_001);
      expect(buckets.size).toBe(0);
    } finally { stop(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owns one unrefed interval and stops idempotently on shutdown", () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    expect(rateLimits.startRateLimitCleanup).toBeTypeOf("function");
    const stop = rateLimits.startRateLimitCleanup(cleanup);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(90_000);
    expect(cleanup).toHaveBeenCalledTimes(3);
    stop(); stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(cleanup).toHaveBeenCalledTimes(3);
  });
});
