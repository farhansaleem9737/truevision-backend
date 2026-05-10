// Backend/models/Repost.js
//
// One row per (user, video) repost. The compound unique index prevents the
// same user reposting the same video twice. createdAt drives "newest first"
// ordering on the profile Reposted tab.

const mongoose = require('mongoose');

const repostSchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  videoId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Video',
    required: true,
    index:    true,
  },
  // Snapshot of the original owner — useful for ordering / analytics even if
  // the video is later soft-deleted.
  originalOwnerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User',
  },
}, { timestamps: true });

repostSchema.index({ userId: 1, videoId: 1 }, { unique: true });
repostSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Repost', repostSchema);
