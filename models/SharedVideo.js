// Backend/models/SharedVideo.js
//
// One row per share event. Unlike WatchHistory we do NOT dedupe — the user
// might share the same video to multiple platforms, or share it twice over
// time, and both events are interesting. The activity screen shows them
// newest-first.

const mongoose = require('mongoose');

const sharedVideoSchema = new mongoose.Schema(
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
    // Free-form string. Common values: 'copy_link', 'whatsapp', 'telegram',
    // 'twitter', 'system_share', 'chat'. Validation lives in the controller
    // so adding a new surface doesn't require a schema migration.
    platform: { type: String, trim: true, default: 'system_share' },
    sharedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Listing query: my share history, newest first.
sharedVideoSchema.index({ userId: 1, sharedAt: -1 });

module.exports = mongoose.model('SharedVideo', sharedVideoSchema);
