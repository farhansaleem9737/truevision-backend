// Backend/models/ReviewRequest.js
//
// A creator's appeal against an automated moderation decision (usually a
// "blocked as entertainment" outcome). Creating one turns the blocked upload
// into a review TICKET in the admin panel.
//
// One OPEN ticket per (video, creator) — enforced in the controller so a
// creator can't spam the queue; a resolved ticket doesn't block a fresh appeal
// if the admin later requests changes.

const mongoose = require('mongoose');

const reviewRequestSchema = new mongoose.Schema({
  video:   { type: mongoose.Schema.Types.ObjectId, ref: 'Video', required: true, index: true },
  creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true, index: true },

  // Creator's submission.
  reason:      { type: String, default: '', trim: true, maxlength: 200 },   // short headline
  description: { type: String, default: '', trim: true, maxlength: 2000 },  // full explanation
  notes:       { type: String, default: '', trim: true, maxlength: 2000 },  // supporting notes
  links:       [{ type: String, trim: true, maxlength: 2048 }],             // optional supporting links

  // Snapshot of the AI verdict at request time (so the admin sees what was decided).
  snapshot: {
    category:   { type: String, default: null },
    confidence: { type: Number, default: 0 },
    reason:     { type: String, default: '' },
  },

  status: {
    type:    String,
    enum:    ['pending', 'approved', 'rejected', 'changes_requested'],
    default: 'pending',
    index:   true,
  },
  adminNote:  { type: String, default: '' },   // feedback returned to the creator
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
  reviewedAt: { type: Date, default: null },
}, { timestamps: true });

// Admin queue: pending first, newest first.
reviewRequestSchema.index({ status: 1, createdAt: -1 });
reviewRequestSchema.index({ creator: 1, createdAt: -1 });

module.exports = mongoose.model('ReviewRequest', reviewRequestSchema);
