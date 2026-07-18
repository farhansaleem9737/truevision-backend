// Backend/services/cache.js
//
// Thin helpers over ioredis. Every function is Redis-optional: if Redis is
// down / not installed, get/withCache silently return "cache miss" and the
// loader runs against Mongo, so behaviour is identical (just slower).
//
// Convention:
//   - Values are JSON-encoded strings. Callers pass and receive objects.
//   - Keys use ":" as a namespace separator, e.g. "video:byId:<id>".
//   - Pass `ttlSeconds` to every setter to prevent stale-forever entries.

const { client, isReady } = require('../config/redis');

// ── Basic ops ──────────────────────────────────────────────────────────────

/** Get a JSON value, or null on miss / Redis-down / parse error. */
const get = async (key) => {
  if (!isReady()) return null;
  try {
    const raw = await client.get(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[cache.get] failed:', key, e.message);
    return null;
  }
};

/** Set a JSON value with a required TTL (seconds). No-op if Redis is down. */
const set = async (key, value, ttlSeconds) => {
  if (!isReady()) return false;
  if (!ttlSeconds || ttlSeconds <= 0) {
    console.warn('[cache.set] missing TTL for key', key, '— refusing to write');
    return false;
  }
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch (e) {
    console.warn('[cache.set] failed:', key, e.message);
    return false;
  }
};

/** Delete one or more exact keys. Safe when Redis is down. */
const del = async (...keys) => {
  const flat = keys.flat().filter(Boolean);
  if (!flat.length || !isReady()) return 0;
  try {
    return await client.del(flat);
  } catch (e) {
    console.warn('[cache.del] failed:', e.message);
    return 0;
  }
};

/**
 * Delete every key matching a glob-style prefix. Uses SCAN so it's safe on
 * large keyspaces (never blocks the server). Use sparingly — a widely
 * matched pattern can walk the whole DB.
 *
 * Example: delByPrefix('video:feed:*') on a like/save mutation to invalidate
 * every feed permutation without keeping a manual index.
 */
const delByPrefix = async (pattern) => {
  if (!isReady()) return 0;
  let deleted = 0;
  try {
    const stream = client.scanStream({ match: pattern, count: 200 });
    const pipeline = client.pipeline();
    for await (const keys of stream) {
      if (keys.length) {
        pipeline.del(...keys);
        deleted += keys.length;
      }
    }
    if (deleted) await pipeline.exec();
    return deleted;
  } catch (e) {
    console.warn('[cache.delByPrefix] failed:', pattern, e.message);
    return 0;
  }
};

// ── Scoped invalidation via a per-scope key registry ───────────────────────
//
// Problem: feed cache keys embed the viewerId in the MIDDLE
// (video:feed:<sort>:<cat>:<viewerId>:<page>:<limit>), so a prefix delete
// can't target one user without SCANning the whole keyspace — and wiping
// EVERY user's feed on one person's preference change doesn't scale.
//
// Solution: when we cache a key for a user, also record it in a small Redis
// SET (the "scope"). Invalidating that user then means: read the set, delete
// exactly those keys, delete the set. O(keys-for-this-user), zero keyspace
// scan — safe at thousands of concurrent users.

/**
 * Register `memberKey` under the registry SET `setKey` so the scope can be
 * invalidated later without scanning. Best-effort; never throws. The set is
 * given its own TTL (slightly longer than the members') so it self-cleans.
 */
const trackKey = async (setKey, memberKey, ttlSeconds) => {
  if (!isReady() || !setKey || !memberKey) return;
  try {
    await client.multi()
      .sadd(setKey, memberKey)
      .expire(setKey, Math.max(ttlSeconds || 60, 60))
      .exec();
  } catch (e) {
    console.warn('[cache.trackKey] failed:', setKey, e.message);
  }
};

/**
 * Invalidate a scope: delete every key registered under `setKey`, plus any
 * `extraKeys`, plus the registry set itself. AWAITED and reliable — one retry
 * on a transient error, then it throws so the caller can react (e.g. roll back
 * a write). When Redis is down there is nothing cached to be stale, so this
 * resolves successfully as a no-op.
 *
 * @returns {Promise<{cleared:number, degraded:boolean}>}
 */
const invalidateScope = async (setKey, extraKeys = []) => {
  if (!isReady()) return { cleared: 0, degraded: true };

  const run = async () => {
    const members = await client.smembers(setKey);
    const keys = [...members, ...extraKeys, setKey].filter(Boolean);
    if (keys.length) await client.del(keys);
    return keys.length;
  };

  try {
    return { cleared: await run(), degraded: false };
  } catch (first) {
    // Single retry — covers a transient blip without masking a real outage.
    try {
      return { cleared: await run(), degraded: false };
    } catch (second) {
      console.error('[cache.invalidateScope] failed after retry:', setKey, second.message);
      throw second;
    }
  }
};

// ── High-level pattern: cache-aside with loader fallback ───────────────────

/**
 * withCache(key, ttlSeconds, loader)
 *
 * Look up `key` in Redis. If missing (or Redis is down), call `loader()`,
 * store the result (best-effort), and return it. This is THE helper every
 * cached endpoint should use — one line at the top of a controller replaces
 * the entire cache-miss dance:
 *
 *   const data = await cache.withCache(`video:byId:${id}`, 300, async () => {
 *     return Video.findById(id).lean();
 *   });
 *
 * If loader throws, the error propagates to the caller — we do NOT cache
 * errors.
 */
const withCache = async (key, ttlSeconds, loader) => {
  const hit = await get(key);
  if (hit !== null) return hit;

  const fresh = await loader();
  // Don't cache null/undefined — future misses would look like hits.
  if (fresh !== null && fresh !== undefined) {
    // Fire-and-forget the write; loader's return value is what the caller
    // gets, whether Redis accepts the write or not.
    set(key, fresh, ttlSeconds).catch(() => {});
  }
  return fresh;
};

// ── Counters — INCR-based atomic operations ────────────────────────────────

/** Atomic increment. Returns the new value (or null on Redis-down). */
const incr = async (key, by = 1) => {
  if (!isReady()) return null;
  try {
    return await client.incrby(key, by);
  } catch (e) {
    console.warn('[cache.incr] failed:', key, e.message);
    return null;
  }
};

/** Set-if-not-exists with TTL — building block for "did user X already do Y?" idempotency. */
const setNX = async (key, value, ttlSeconds) => {
  if (!isReady()) return false;
  try {
    const result = await client.set(key, String(value), 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (e) {
    console.warn('[cache.setNX] failed:', key, e.message);
    return false;
  }
};

module.exports = {
  get, set, del, delByPrefix,
  trackKey, invalidateScope,
  withCache,
  incr, setNX,
  // Direct client access — reserve for low-level ops (SADD, HINCRBY, etc.)
  // used in later phases. Always call isReady() first.
  raw: client,
};
