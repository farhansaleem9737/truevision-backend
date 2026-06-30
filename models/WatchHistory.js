// Backend/models/WatchHistory.js
//
// One row per (user, video) pair. Re-watching a video updates the existing
// row's `watchedAt` instead of inserting a duplicate — see the upsert in
// ActivityController.recordWatch. This is what surfaces "most recently
// watched first" on the activity screen.
//
// We store `lastPosition` (seconds) and `watchDuration` (seconds actually
// watched) so a future "resume where you left off" feature has the data it
// needs without any schema change.

const mongoose = require('mongoose');

const watchHistorySchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    videoId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Video',
      required: true,
    },
    watchedAt:             { type: Date,   default: Date.now },
    lastPlaybackPosition:  { type: Number, default: 0 },   // seconds — for resume
    watchDuration:         { type: Number, default: 0 },   // seconds actually watched
    completionPercentage:  { type: Number, default: 0, min: 0, max: 100 }, // 0-100
  },
  { timestamps: true },
);

// Unique compound — one row per (user, video). Upsert on re-watch.
watchHistorySchema.index({ userId: 1, videoId: 1 }, { unique: true });
// Fast "my history, most recent first" listing.
watchHistorySchema.index({ userId: 1, watchedAt: -1 });

module.exports = mongoose.model('WatchHistory', watchHistorySchema);
