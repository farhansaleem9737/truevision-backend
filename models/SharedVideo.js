// Backend/models/SharedVideo.js
//
// One row per share event. Deliberately NOT deduped — the user might share
// the same video to multiple platforms, or share it twice over time, and
// both events are interesting. The activity screen shows them newest-first.
// `toUserId` records the recipient when the video was shared into a chat;
// it stays null for external platforms (copy_link, whatsapp, ...).

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
    // Recipient when the video was shared into a chat — null otherwise.
    toUserId: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    sharedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Listing query: my share history, newest first.
sharedVideoSchema.index({ userId: 1, sharedAt: -1 });

module.exports = mongoose.model('SharedVideo', sharedVideoSchema);
