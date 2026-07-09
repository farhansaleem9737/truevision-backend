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
  withCache,
  incr, setNX,
  // Direct client access — reserve for low-level ops (SADD, HINCRBY, etc.)
  // used in later phases. Always call isReady() first.
  raw: client,
};
