// Backend/models/Report.js
//
// One row per user-reported user. Created from the chat "Report user" flow (and
// reusable anywhere a user needs to be reported — profile, comments, etc.).
// Distinct from SupportTicket (bug/contact) and from VideoController.reportVideo
// (which reports a video, not a person).
//
// Admin workflow: staff triage the moderation queue by `status`, newest first.
// A per-(reporter, reportedUser) partial guard prevents a single user from
// spamming duplicate open reports against the same person.

const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  reporter: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  reportedUser: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  reason: {
    type:     String,
    enum:     ['spam', 'harassment', 'fake', 'inappropriate', 'other'],
    required: true,
  },
  // Optional free-text the reporter can add (esp. for "other").
  details: { type: String, default: '', trim: true, maxlength: 1000 },

  // Where the report was raised from — helps moderators find the context.
  context: { type: String, enum: ['chat', 'profile', 'comment', 'video', 'other'], default: 'chat' },
  // Optional pointer to the surrounding chat, when reported from a conversation.
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null },

  // Moderation lifecycle.
  status: {
    type:    String,
    enum:    ['pending', 'reviewing', 'actioned', 'dismissed'],
    default: 'pending',
    index:   true,
  },
}, { timestamps: true });

// Moderation queue: newest reports against a user first.
reportSchema.index({ reportedUser: 1, createdAt: -1 });
// De-dupe guard: at most one OPEN report per (reporter → reportedUser). Handled
// in the controller (checked before insert) rather than a unique index so that
// resolved reports don't block a legitimate new one later.
reportSchema.index({ reporter: 1, reportedUser: 1, status: 1 });

module.exports = mongoose.model('Report', reportSchema);
