export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly options: {
      limit: number;
      windowMs: number;
    }
  ) {}

  check(key: string, cost = 1, now = Date.now()): RateLimitResult {
    const bucket = this.getBucket(key, now);
    const nextCount = bucket.count + cost;
    const allowed = nextCount <= this.options.limit;

    if (allowed) {
      bucket.count = nextCount;
    }

    return {
      allowed,
      remaining: Math.max(0, this.options.limit - bucket.count),
      retryAfterMs: Math.max(0, bucket.resetAt - now),
      resetAt: bucket.resetAt
    };
  }

  reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
      return;
    }
    this.buckets.clear();
  }

  prune(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }

  private getBucket(key: string, now: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing && existing.resetAt > now) {
      return existing;
    }

    const bucket = {
      count: 0,
      resetAt: now + this.options.windowMs
    };
    this.buckets.set(key, bucket);
    return bucket;
  }
}

export function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
