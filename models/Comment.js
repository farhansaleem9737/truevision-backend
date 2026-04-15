// Backend/models/Comment.js
const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// REPLY SUB-SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const replySchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },
  text: {
    type:      String,
    required:  [true, 'Reply text is required'],
    trim:      true,
    maxlength: [1000, 'Reply cannot exceed 1000 characters'],
  },
  likes:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  likesCount: { type: Number, default: 0 },
  isEdited:   { type: Boolean, default: false },
  editedAt:   { type: Date },
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
// COMMENT SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const commentSchema = new mongoose.Schema({

  videoId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Video',
    required: [true, 'Video ID is required'],
    index:    true,
  },
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: [true, 'User ID is required'],
    index:    true,
  },
  text: {
    type:      String,
    required:  [true, 'Comment text is required'],
    trim:      true,
    maxlength: [1000, 'Comment cannot exceed 1000 characters'],
  },

  // ── Reactions ──────────────────────────────────────────────────────────────
  likes:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  likesCount: { type: Number, default: 0 },

  // ── Nested Replies ─────────────────────────────────────────────────────────
  replies:       [replySchema],
  repliesCount:  { type: Number, default: 0 },

  // ── Flags ──────────────────────────────────────────────────────────────────
  isPinned:  { type: Boolean, default: false },
  isEdited:  { type: Boolean, default: false },
  editedAt:  { type: Date },
  isHidden:  { type: Boolean, default: false },

}, { timestamps: true });

// ── Indexes ───────────────────────────────────────────────────────────────────
commentSchema.index({ videoId: 1, isPinned: -1, createdAt: -1 });
commentSchema.index({ videoId: 1, likesCount: -1 });

// ── Helpers ───────────────────────────────────────────────────────────────────
commentSchema.methods.isLikedBy = function (uid) { return this.likes.some(id => id.equals(uid)); };

module.exports = mongoose.model('Comment', commentSchema);
