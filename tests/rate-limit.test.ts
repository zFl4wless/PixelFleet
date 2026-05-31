import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../apps/backend/src/rate-limit";

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
