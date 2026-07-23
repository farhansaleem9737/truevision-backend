// Backend/models/ModerationLog.js
//
// Immutable audit trail — one row per moderation DECISION on a video, whether
// made by the AI pipeline or by a human admin. Powers the admin "Audit Log"
// view and answers "who changed this video's status, when, and why".
//
// Never updated after creation; only appended.

const mongoose = require('mongoose');

const moderationLogSchema = new mongoose.Schema({
  video:       { type: mongoose.Schema.Types.ObjectId, ref: 'Video', required: true, index: true },
  creator:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',  default: null },

  // Who acted.
  actorType:   { type: String, enum: ['ai', 'admin', 'system'], required: true },
  admin:       { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  adminName:   { type: String, default: '' },   // denormalised for fast log rendering

  // What happened.
  action: {
    type:    String,
    enum:    [
      'auto_approved', 'auto_blocked', 'auto_pending',
      'approved', 'rejected', 'request_changes', 'deleted',
      'warned', 'suspended', 'review_submitted',
    ],
    required: true,
  },
  previousStatus: { type: String, default: null },
  newStatus:      { type: String, default: null },

  reason:  { type: String, default: '' },        // machine or admin-entered reason
  note:    { type: String, default: '' },        // free-text admin note
  meta:    { type: mongoose.Schema.Types.Mixed, default: {} },  // category, confidence, etc.
}, { timestamps: true });

// Audit views: per-video history, and a global feed newest-first.
moderationLogSchema.index({ video: 1, createdAt: -1 });
moderationLogSchema.index({ createdAt: -1 });
moderationLogSchema.index({ admin: 1, createdAt: -1 });

module.exports = mongoose.model('ModerationLog', moderationLogSchema);
