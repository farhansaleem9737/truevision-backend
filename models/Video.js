// Backend/models/Video.js
const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

const viewSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  watchTime: { type: Number, default: 0 },   // seconds actually watched
  viewedAt:  { type: Date,   default: Date.now },
}, { _id: false });

const reportSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reason: {
    type: String,
    enum: ['spam', 'harassment', 'hate_speech', 'violence', 'misinformation', 'copyright', 'other'],
    required: true,
  },
  description: { type: String, trim: true, maxlength: 500, default: '' },
  reportedAt:  { type: Date, default: Date.now },
}, { _id: true });

// ─────────────────────────────────────────────────────────────────────────────
// MAIN VIDEO SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const videoSchema = new mongoose.Schema({

  // ── Ownership ──────────────────────────────────────────────────────────────
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: [true, 'User ID is required'],
    index:    true,
  },

  // ── Core Content ──────────────────────────────────────────────────────────
  title: {
    type:      String,
    required:  [true, 'Title is required'],
    trim:      true,
    maxlength: [150, 'Title cannot exceed 150 characters'],
  },
  description: {
    type:      String,
    trim:      true,
    maxlength: [2200, 'Description cannot exceed 2200 characters'],
    default:   '',
  },
  song: {
    type:    String,
    trim:    true,
    default: '',   // e.g. "Original Sound – username"
  },
  tags: [{
    type:      String,
    trim:      true,
    lowercase: true,
  }],
  category: {
    type:    String,
    enum:    [
      // Informative / educational
      'education', 'tech', 'programming', 'business', 'finance',
      'islamic', 'motivation', 'news', 'productivity',
      // Legacy / lifestyle
      'entertainment', 'music', 'sports', 'gaming', 'food', 'travel', 'fashion',
      'other',
    ],
    default: 'other',
  },

  // ── Cloudinary – Video ─────────────────────────────────────────────────────
  videoUrl:        { type: String, required: [true, 'Video URL is required'] },
  videoPublicId:   { type: String, required: [true, 'Cloudinary public ID is required'] },

  // ── Cloudinary – Thumbnail ─────────────────────────────────────────────────
  thumbnailUrl:      { type: String, default: '' },
  thumbnailPublicId: { type: String, default: '' },

  // ── Media Metadata ─────────────────────────────────────────────────────────
  duration:  { type: Number, default: 0 },         // seconds
  fileSize:  { type: Number, default: 0 },         // bytes
  format:    { type: String, default: '' },        // mp4, mov, etc.
  resolution: {
    width:  { type: Number, default: 0 },
    height: { type: Number, default: 0 },
  },

  // ── Visibility & Status ───────────────────────────────────────────────────
  visibility: {
    type:    String,
    enum:    ['public', 'private', 'followers'],
    default: 'public',
  },
  status: {
    type:    String,
    enum:    ['processing', 'active', 'deleted', 'suspended'],
    default: 'processing',
  },

  // ── Permissions ───────────────────────────────────────────────────────────
  allowDownload: { type: Boolean, default: true  },
  allowComments: { type: Boolean, default: true  },
  allowDuet:     { type: Boolean, default: true  },
  allowRemix:    { type: Boolean, default: true  },

  // ── Privacy toggles for the "Manage your reel" panel ─────────────────────
  // Owner sees the true counts everywhere; everyone else sees the wording
  // "Liked by others" / "Shared" instead. The frontend enforces the hide by
  // reading these flags together with a viewer-is-owner check; the backend
  // strips numeric counts from the payload for non-owner requests so a
  // hostile client can't sniff them.
  hideLikeCount:  { type: Boolean, default: false },
  hideShareCount: { type: Boolean, default: false },

  // ── Archive ──────────────────────────────────────────────────────────────
  // Archive is a soft-hide separate from "deleted". Archived videos are
  // visible ONLY to the owner in the profile > Archived list. They must be
  // filtered out of every public surface (feed, trending, search,
  // recommendations, user grid). "restore" flips this back to false.
  isArchived: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date,    default: null  },

  // ── Location tag (optional geotag from the Edit Reel screen) ─────────────
  // Free-form string — no reverse geocoding server-side; the client picks a
  // place label and it is stored verbatim. Capped so an abusive client can't
  // stuff arbitrary payloads.
  location: { type: String, trim: true, default: '', maxlength: 120 },

  // ── Social Arrays (store userId refs) ────────────────────────────────────
  likes:          [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  saves:          [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  reposts:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  favorites:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  notInterested:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // ── Denormalized Counters (fast reads for feed) ──────────────────────────
  likesCount:     { type: Number, default: 0 },
  commentsCount:  { type: Number, default: 0 },
  savesCount:     { type: Number, default: 0 },
  repostsCount:   { type: Number, default: 0 },
  sharesCount:    { type: Number, default: 0 },
  viewsCount:     { type: Number, default: 0 },
  downloadsCount: { type: Number, default: 0 },
  favoritesCount: { type: Number, default: 0 },

  // ── Views Log (unique per user) ──────────────────────────────────────────
  views: [viewSchema],

  // ── Multi-quality URLs (generated by Cloudinary eager transformations) ──────
  qualities: {
    '144p': { type: String, default: '' },
    '240p': { type: String, default: '' },
    '360p': { type: String, default: '' },
    '480p': { type: String, default: '' },
    '720p': { type: String, default: '' },
  },

  // ── Pinned Comment ────────────────────────────────────────────────────────
  pinnedComment: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'Comment',
    default: null,
  },

  // ── Pinned to creator's profile (sorts to top of /user/:userId feed) ────
  pinned: {
    type:    Boolean,
    default: false,
    index:   true,
  },
  pinnedAt: {
    type:    Date,
    default: null,
  },

  // ── Content-quality ranking ────────────────────────────────────────────
  // Computed by services/contentRanking.js + (optionally) Gemini AI.
  // rankingScore drives the Trending feed order; recompute periodically as
  // engagement metrics change.
  aiCategory: {
    type: String,
    enum: ['technical', 'educational', 'business', 'finance', 'motivational',
           'news', 'islamic', 'entertainment', 'music', 'other', null],
    default: null,
  },
  // ── Speech-to-text (Faster-Whisper → DistilBERT) ──────────────────────
  // Populated asynchronously by runContentAnalysis() after upload. Kept in
  // its own sub-document so it never collides with the `aiCategory` enum
  // above (the DistilBERT label set is free-form, e.g. "Professional").
  //   status: pending → done | empty | failed
  //   empty  = video had no speech (silent/music-only) — not an error.
  transcription: {
    text:             { type: String, default: '' },
    language:         { type: String, default: '' },
    category:         { type: String, default: null },  // DistilBERT label
    confidence:       { type: Number, default: 0, min: 0, max: 1 },
    processingTimeMs: { type: Number, default: 0 },     // end-to-end pipeline ms
    audioDuration:    { type: Number, default: 0 },     // seconds of audio
    engine:           { type: String, default: '' },    // e.g. "faster-whisper:base"
    status: {
      type: String,
      enum: ['pending', 'done', 'empty', 'failed'],
      default: 'pending',
    },
    error:            { type: String, default: '' },
    transcribedAt:    { type: Date,   default: null },
  },

  informativeScore: { type: Number, default: 0, min: 0, max: 10 },  // 0–10 from AI (or tag-derived fallback)
  tagScore:         { type: Number, default: 0 },                    // weighted tag count
  engagementScore:  { type: Number, default: 0 },                    // computed from views/likes/etc.
  rankingScore:     { type: Number, default: 0, index: true },       // weighted combo; sorted DESC for trending
  aiAnalyzedAt:     { type: Date,   default: null },                  // last time AI classifier ran
  rankingUpdatedAt: { type: Date,   default: null },                  // last time engagement → ranking ran

  // ── Reports ───────────────────────────────────────────────────────────────
  reports:      [reportSchema],
  reportCount:  { type: Number, default: 0 },
  isReported:   { type: Boolean, default: false },

  // ── Sensitivity (drives the "Hide Sensitive Content" preference) ──────────
  // Hard PORN/NSFW is rejected at upload and never reaches the DB. This flag
  // marks content that PASSED moderation but is still borderline — either the
  // NudeNet frame score landed in a grey band below the reject threshold, or
  // the tags/title matched a sensitive-topic lexicon (violence, graphic, etc).
  // Viewers with preferences.content.hideSensitive = true never see these.
  isSensitive: { type: Boolean, default: false, index: true },
  moderation: {
    status:     { type: String, enum: ['SAFE', 'NSFW', 'PORN', null], default: null },
    confidence: { type: Number, default: 0 },   // 0–1 from the NudeNet worst-frame
    reason:     { type: String, default: '' },  // why isSensitive was set, if it was
    checkedAt:  { type: Date,   default: null },
  },

  // ── Content classification (Fact / News / Opinion) ────────────────────────
  // Optional self-declared label that drives the Info panel + source slots.
  // Validated server-side; if absent the video is shown without a content-type chip.
  contentType: {
    type:    String,
    enum:    ['fact', 'news', 'opinion', null],
    default: null,
    index:   true,
  },

  // ── Source / evidence (FACT) ─────────────────────────────────────────────
  // All optional — videos publish fine with none. sourceFiles entries are
  // Cloudinary-hosted attachments (image / pdf / doc) uploaded ahead of the
  // video create call.
  sourceUrl:   { type: String, trim: true, default: '' },
  sourceFiles: [{
    _id:      false,
    url:      { type: String, required: true },   // Cloudinary secure_url
    publicId: { type: String, default: '' },      // Cloudinary public_id (for deletion)
    type:     { type: String, enum: ['image', 'pdf', 'document'], default: 'document' },
    name:     { type: String, default: '' },      // user-friendly filename
    size:     { type: Number, default: 0 },       // bytes (optional)
  }],

  // ── Source / publisher (NEWS) ─────────────────────────────────────────────
  newsUrl:       { type: String, trim: true, default: '' },
  newsPublisher: { type: String, trim: true, default: '', maxlength: 120 },
  newsFiles: [{
    _id:      false,
    url:      { type: String, required: true },
    publicId: { type: String, default: '' },
    type:     { type: String, enum: ['image', 'pdf', 'document'], default: 'document' },
    name:     { type: String, default: '' },
    size:     { type: Number, default: 0 },
  }],

  // ── AI-readiness placeholders ────────────────────────────────────────────
  // Schema-only — populated by future recommendation / verification models.
  // Endpoints return them as-is; no business logic depends on them yet.
  relatedContent:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Video' }],
  relatedNews:      [{
    _id:       false,
    title:     { type: String, default: '' },
    url:       { type: String, default: '' },
    publisher: { type: String, default: '' },
    addedAt:   { type: Date,   default: Date.now },
  }],
  semanticMatches: [{
    _id:     false,
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Video' },
    score:   { type: Number, min: 0, max: 1 },
  }],
  verificationScore: { type: Number, min: 0, max: 1, default: null },
  credibilityScore:  { type: Number, min: 0, max: 1, default: null },

}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES  (compound indexes for common query patterns)
// ─────────────────────────────────────────────────────────────────────────────
videoSchema.index({ status: 1, visibility: 1, createdAt: -1 });
videoSchema.index({ userId: 1, status: 1, createdAt: -1 });
videoSchema.index({ tags: 1, createdAt: -1 });
videoSchema.index({ category: 1, createdAt: -1 });
videoSchema.index({ viewsCount: -1 });
videoSchema.index({ likesCount: -1 });
// isArchived is filtered on nearly every read (feed / trending / search /
// user grid) so a compound index avoids full-collection scans as the
// archive count grows.
videoSchema.index({ status: 1, isArchived: 1, visibility: 1, createdAt: -1 });
videoSchema.index({ userId: 1, isArchived: 1, createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
videoSchema.methods.isLikedBy      = function (uid) { return this.likes.some(id => id.equals(uid)); };
videoSchema.methods.isSavedBy      = function (uid) { return this.saves.some(id => id.equals(uid)); };
videoSchema.methods.isRepostedBy   = function (uid) { return this.reposts.some(id => id.equals(uid)); };
videoSchema.methods.isFavoritedBy  = function (uid) { return this.favorites.some(id => id.equals(uid)); };
videoSchema.methods.hasViewedBy    = function (uid) { return this.views.some(v => v.userId && v.userId.equals(uid)); };

// ─────────────────────────────────────────────────────────────────────────────
// CACHE INVALIDATION HOOK
// Fires after every save() — that covers toggleLike / toggleSave / toggleRepost
// / toggleFavorite / recordView / updateVideo / createVideo / deleteVideo (soft)
// without having to tag each controller by hand. Also runs on findOneAndUpdate.
// Lazy require avoids a circular dep with services/cache → config/redis.
// ─────────────────────────────────────────────────────────────────────────────
function invalidate(doc) {
  if (!doc) return;
  try {
    const cache = require('../services/cache');
    cache.del(`video:byId:${doc._id}`).catch(() => {});
    cache.delByPrefix('video:feed:*').catch(() => {});
  } catch (_) { /* cache is optional */ }
}
videoSchema.post('save',              function (doc) { invalidate(doc); });
videoSchema.post('findOneAndUpdate',  function (doc) { invalidate(doc); });
videoSchema.post('findOneAndDelete',  function (doc) { invalidate(doc); });

module.exports = mongoose.model('Video', videoSchema);
