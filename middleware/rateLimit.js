// Backend/middleware/rateLimit.js
//
// Sliding-window rate limiter, Redis-first with in-memory fallback.
//
// When Redis is available:
//   • INCR the counter at `ratelimit:<prefix>:<ip>`
//   • Set TTL on first increment (the "1" branch)
//   • Reject with 429 when count exceeds the limit
//
// When Redis is unavailable:
//   • Falls back to the exact Map-based algorithm the old server.js used —
//     so behaviour + limits stay identical.

const { client, isReady } = require('../config/redis');

// In-process fallback store. Shared across every limiter instance so we
// don't leak per-limiter cleanup timers.
const localBuckets = new Map();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  localBuckets.forEach((v, k) => { if (v.start < cutoff) localBuckets.delete(k); });
}, 10 * 60 * 1000).unref();

const REJECTION = { success: false, message: 'Too many requests — please slow down.' };

/**
 * rateLimit(maxReqs, windowMs, prefix)
 *
 * Returns an Express middleware. `prefix` namespaces buckets so /auth and
 * /videos limits don't collide.
 */
module.exports = (maxReqs, windowMs, prefix = 'default') => {
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));

  return async (req, res, next) => {
    const key = `ratelimit:${prefix}:${req.ip || 'unknown'}`;

    // ── Redis path ──────────────────────────────────────────────────────
    if (isReady()) {
      try {
        const count = await client.incr(key);
        if (count === 1) {
          // First hit — establish the sliding window.
          await client.expire(key, windowSeconds);
        }
        if (count > maxReqs) {
          return res.status(429).json(REJECTION);
        }
        return next();
      } catch (_) {
        // Fall through to memory fallback on any Redis error.
      }
    }

    // ── In-memory fallback ─────────────────────────────────────────────
    const now  = Date.now();
    const data = localBuckets.get(key) || { count: 0, start: now };
    if (now - data.start > windowMs) { data.count = 0; data.start = now; }
    data.count += 1;
    localBuckets.set(key, data);
    if (data.count > maxReqs) return res.status(429).json(REJECTION);
    return next();
  };
};
