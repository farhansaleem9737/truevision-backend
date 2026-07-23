// Backend/services/feedCache.js
//
// One home for the feed / recommendation cache invalidation contract, shared
// by VideoController (which WRITES feed cache) and the settings controllers
// (which INVALIDATE it on a preference change).
//
// Design goals from the spec:
//   • Per-user only — changing one user's preferences must never wipe another
//     user's cached feed.
//   • Scan-free — invalidation reads a small per-user registry SET, not the
//     whole keyspace, so it stays O(pages-cached-for-this-user) at any scale.
//   • Awaited + reliable — callers can `await invalidateUserFeed()` and trust
//     that on resolve the user's recommendation cache is gone; on reject they
//     can roll back.
//   • Scoped to recommendation settings — playback-only toggles (autoplay,
//     hdOnWifi, dataSaver) never touch the feed cache.

const cache = require('./cache');

// Keys tracked here MUST use the same TTL family as VideoController.TTL.feed.
// The registry set lives a little longer so it never expires before the keys
// it points at.
const FEED_TTL_SECONDS = 30;
const REGISTRY_TTL      = FEED_TTL_SECONDS * 4;

// The preference keys that actually change what the feed returns. A change to
// any of these — and ONLY these — invalidates the user's recommendation cache.
const RECOMMENDATION_KEYS = ['personalizedRecs', 'hideSensitive', 'interestedTopics'];

const feedRegistryKey = (userId) => `video:feedkeys:${userId}`;
const foryouPoolKey   = (userId) => `video:foryou:pool:${userId}`;

/** True if a sanitized content patch touches a recommendation-affecting key. */
const affectsRecommendations = (contentPatch) =>
  !!contentPatch && RECOMMENDATION_KEYS.some((k) => k in contentPatch);

/**
 * Register a feed cache key against its owner so it can be invalidated later
 * without scanning. Call this whenever getFeed caches a page for a signed-in
 * viewer. Best-effort — never throws, never blocks the response.
 */
const trackUserFeedKey = (userId, cacheKey) => {
  if (!userId || !cacheKey) return;
  cache.trackKey(feedRegistryKey(userId), cacheKey, REGISTRY_TTL).catch(() => {});
};

/**
 * Invalidate exactly ONE user's feed + personalized pool. Awaited and
 * reliable: resolves only after the delete completes (or Redis is confirmed
 * down, in which case nothing is cached and there is nothing to clear).
 * Rejects if Redis is up but the delete fails after a retry, so the caller
 * can roll back the originating write.
 *
 * @returns {Promise<{cleared:number, degraded:boolean}>}
 */
const invalidateUserFeed = (userId) => {
  if (!userId) return Promise.resolve({ cleared: 0, degraded: false });
  // The general feed pages live in the registry set; the personalized pool is
  // a single well-known key passed as an extra.
  return cache.invalidateScope(feedRegistryKey(userId), [foryouPoolKey(userId)]);
};

/**
 * Invalidate EVERY viewer's public feed + personalized pools. Use when a video's
 * public visibility changes for everyone — a new approved upload, an admin
 * approve/reject/delete, a block/unblock — so the change is reflected on the
 * next feed fetch instead of after the TTL. SCAN-based (safe on large keyspaces);
 * best-effort and non-blocking.
 */
const invalidatePublicFeeds = () => {
  cache.delByPrefix('video:feed:*').catch(() => {});
  cache.delByPrefix('video:foryou:pool:*').catch(() => {});
};

module.exports = {
  FEED_TTL_SECONDS,
  RECOMMENDATION_KEYS,
  affectsRecommendations,
  trackUserFeedKey,
  invalidateUserFeed,
  invalidatePublicFeeds,
  foryouPoolKey,
};
