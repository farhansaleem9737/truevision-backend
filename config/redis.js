// Backend/config/redis.js
//
// Single Redis client for the whole process.
//
// Design goals:
//   1. GRACEFUL DEGRADATION — if Redis is unreachable, the client fires an
//      event and every helper in services/cache.js falls back to
//      pass-through (cache miss = compute value directly). The API keeps
//      responding, just without caching acceleration.
//   2. Zero-config default — REDIS_URL from .env, fallback to
//      redis://127.0.0.1:6379 (standard localhost port).
//   3. Lazy connect — we don't block server startup on Redis, but we log
//      status changes so operators see connect / reconnect / drop.

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// State flag consulted by services/cache.js. When false, helpers short-
// circuit to the loader — nothing goes to (or comes from) Redis.
let ready = false;

const client = new Redis(REDIS_URL, {
  // Don't retry forever; give up quickly so a downed Redis doesn't queue
  // hundreds of pending commands that all time out later.
  maxRetriesPerRequest:      2,
  enableOfflineQueue:        false,
  connectTimeout:            5000,
  // Reconnect with exponential-ish backoff, capped so we don't spin. When
  // Redis is genuinely unreachable we give up after 3 attempts so the log
  // doesn't fill with reconnect noise — every cache helper degrades to a
  // pass-through anyway.
  retryStrategy(times) {
    if (times > 3) return null;              // give up after ~2s of retries
    return Math.min(times * 500, 2000);
  },
  lazyConnect: true,
});

// ── State plumbing ──────────────────────────────────────────────────────────
// De-dupe: repeated ECONNREFUSED loops only print ONE line, followed by a
// final "running without cache" summary. Every command still passes through
// to the loader as normal — the log just stops screaming.
let firstErrorLogged = false;

client.on('connect',      () => { firstErrorLogged = false; console.log('[redis] connecting…'); });
client.on('ready',         () => { ready = true;  console.log('[redis] ready — cache online'); });
client.on('error', (err)  => {
  ready = false;
  if (!firstErrorLogged) {
    firstErrorLogged = true;
    console.warn('[redis] error:', err.message.slice(0, 160));
  }
});
client.on('end', () => {
  ready = false;
  console.warn('[redis] offline — every cache call now passes through to Mongo. Set REDIS_URL in .env to enable caching.');
});
client.on('reconnecting', () => { ready = false; /* quiet by design */ });

// Best-effort initial connect + ping. Any error here is already logged by
// the 'error' handler above; we don't rethrow — the app boots regardless.
const boot = async () => {
  try {
    if (client.status === 'wait') await client.connect();
    await client.ping();
  } catch (_) { /* graceful degrade */ }
};

module.exports = {
  client,
  boot,
  /** True when Redis is connected and ready to accept commands. */
  isReady: () => ready,
  REDIS_URL,
};
