// Backend/models/SearchHistory.js
//
// Stores recent search queries per user, deduped on (user, query). Upserting
// the same query bumps `searchedAt` so the most-recent search ranks first
// without inserting a duplicate row.
//
// Queries are stored lowercase + trimmed so "React" and "react" collapse to
// one entry — same as TikTok / Instagram.

const mongoose = require('mongoose');

const searchHistorySchema = new mongoose.Schema(
  {
    userId: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    query: {
      type:      String,
      required:  true,
      trim:      true,
      lowercase: true,
      maxlength: 200,
    },
    searchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Dedupe: one row per (user, query). Upsert on re-search.
searchHistorySchema.index({ userId: 1, query: 1 }, { unique: true });
// Listing: my searches, newest first.
searchHistorySchema.index({ userId: 1, searchedAt: -1 });

module.exports = mongoose.model('SearchHistory', searchHistorySchema);
