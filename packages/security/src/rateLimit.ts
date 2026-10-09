/**
 * Fixed-window in-memory rate limiter.
 *
 * The VPS deployment runs a single web container, so process memory is a
 * correct shared store. If the app is ever scaled to multiple replicas, swap
 * this for a Redis/Postgres-backed implementation behind the same interface.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string): RateLimitResult;
  reset(key: string): void;
}

export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  function sweep(t: number) {
    if (t - lastSweep < opts.windowMs) return;
    lastSweep = t;
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
  }

  return {
    consume(key) {
      const t = now();
      sweep(t);
      let b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        b = { count: 0, resetAt: t + opts.windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      const allowed = b.count <= opts.limit;
      return {
        allowed,
        remaining: Math.max(0, opts.limit - b.count),
        retryAfterSeconds: allowed ? 0 : Math.ceil((b.resetAt - t) / 1000),
      };
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}
