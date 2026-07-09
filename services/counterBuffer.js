// Backend/services/counterBuffer.js
//
// Redis-buffered counter deltas + periodic Mongo flush.
//
// Use when a counter increments so often that hitting Mongo per event is
// wasteful: views (every playback), shares (every share button tap), likes
// during a viral spike.
//
// Contract:
//   • Callers call bumpVideo(videoId, field, by = 1)
//   • Deltas accumulate under `counter:video:<videoId>:<field>`
//   • Every FLUSH_MS the flusher scans the delta keys, applies a single
//     $inc per video to Mongo, and DELs the key
//   • If Redis is down, callers see false → fall back to a direct $inc

const mongoose = require('mongoose');
const { client, isReady } = require('../config/redis');

const PREFIX   = 'counter:video:';
const FLUSH_MS = 30_000;   // 30 s — bounded staleness; tune if needed

// Set of fields we're willing to buffer. Anything else falls through.
const ALLOWED_FIELDS = new Set([
  'viewsCount', 'sharesCount', 'downloadsCount',
]);

/** Attempt to buffer an increment. Returns true on success. */
exports.bumpVideo = async (videoId, field, by = 1) => {
  if (!ALLOWED_FIELDS.has(field)) return false;
  if (!isReady()) return false;
  try {
    await client.hincrby(PREFIX + videoId, field, by);
    return true;
  } catch (_) { return false; }
};

// ── Flusher ────────────────────────────────────────────────────────────────

let flushTimer = null;

const flushOnce = async () => {
  if (!isReady()) return;
  let scanned = 0, flushed = 0;
  try {
    const stream = client.scanStream({ match: PREFIX + '*', count: 100 });
    const Video  = mongoose.model('Video');

    for await (const keys of stream) {
      scanned += keys.length;
      // Process in small batches so we don't hold the connection.
      for (const key of keys) {
        // Atomically read all counters + delete the key. Anything logged
        // in the microsecond between HGETALL and DEL is lost — acceptable
        // for view/share counters, would NOT be for likes (which we still
        // write to Mongo directly in the controller).
        const [[, hash], [, delOk]] = await client.multi()
          .hgetall(key)
          .del(key)
          .exec();

        if (!delOk || !hash) continue;

        const videoId = key.slice(PREFIX.length);
        const inc = {};
        for (const [field, deltaStr] of Object.entries(hash)) {
          const d = Number(deltaStr);
          if (Number.isFinite(d) && d !== 0) inc[field] = d;
        }
        if (Object.keys(inc).length === 0) continue;

        try {
          await Video.updateOne(
            { _id: videoId },
            { $inc: inc },
          );
          flushed += 1;
        } catch (e) {
          console.warn('[counterBuffer] flush write failed:', videoId, e.message);
        }
      }
    }
    if (flushed > 0) {
      console.log(`[counterBuffer] flushed ${flushed}/${scanned} video counters`);
    }
  } catch (e) {
    console.warn('[counterBuffer] flush failed:', e.message);
  }
};

/** Start the periodic flusher. Idempotent. */
exports.start = () => {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushOnce().catch(() => {}); }, FLUSH_MS);
  flushTimer.unref();
  console.log(`[counterBuffer] flush loop started (${FLUSH_MS}ms interval)`);
};

/** For tests / graceful shutdown. */
exports.stop = () => {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
};

exports._flushOnce = flushOnce; // exposed for tests
