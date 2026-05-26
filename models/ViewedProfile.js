// Backend/models/ViewedProfile.js
//
// Tracks which profiles the current user has visited, ordered by most recent.
// Re-visiting an existing profile updates the timestamp via upsert so the
// activity screen can surface "Recently Viewed" without duplicates.

const mongoose = require('mongoose');

const viewedProfileSchema = new mongoose.Schema(
  {
    viewerId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    profileId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    viewedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Dedupe one row per (viewer, profile) pair.
viewedProfileSchema.index({ viewerId: 1, profileId: 1 }, { unique: true });
// Listing query: my recent profile views, newest first.
viewedProfileSchema.index({ viewerId: 1, viewedAt: -1 });

module.exports = mongoose.model('ViewedProfile', viewedProfileSchema);
