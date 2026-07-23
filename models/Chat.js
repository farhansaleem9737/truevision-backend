// Backend/models/Chat.js
//
// Single + group chats share this document.
//   type: 'single' — 1-on-1 DM (members.length === 2, enforced by controller)
//   type: 'group'  — 2+ members plus groupName/groupImage/createdBy metadata
//
// Per-user chat state (pinned / muted / archived) is stored on the Chat as
// arrays of userIds — one document reads back the whole thing so the inbox
// can render without extra lookups. All are indexed for the getMyChats
// query.

const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  type: {
    type:    String,
    enum:    ['single', 'group'],
    default: 'single',
    index:   true,
  },

  // 2 for single chats, 2+ for groups.
  members: [{
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  }],

  // Group-only metadata. Empty for single chats.
  groupName:          { type: String, default: '', trim: true, maxlength: 80 },
  groupImage:         { type: String, default: '' },
  groupImagePublicId: { type: String, default: '' },
  createdBy: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },

  // Preview shown in the inbox list.
  lastMessage: {
    text:      { type: String, default: '' },
    senderId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type:      { type: String, default: 'text' },
    createdAt: { type: Date,   default: Date.now },
  },

  // Per-member unread count map: { "<userId>": <count> }.
  // Written with atomic $inc from the controllers/socket so concurrent
  // sends can't clobber each other.
  unreadCount: {
    type:    Map,
    of:      Number,
    default: {},
  },

  // ── Per-user chat state — sets of userIds ──────────────────────────────
  // Kept as small arrays (a chat has at most ~a few dozen members). Each
  // has a partial index so getMyChats can filter without a full scan.
  pinnedBy:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  mutedBy:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  archivedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // Optional per-user mute expiry: { "<userId>": <Date> }. A member listed in
  // mutedBy with NO entry here (or a null value) is muted forever ("Always").
  // An entry in the past means the mute has lapsed — treated as unmuted and
  // lazily cleared by getMyChats / toggleMuteChat.
  mutedUntil: { type: Map, of: Date, default: {} },
  // Fully-cleared-history — the messages are still on disk for the other
  // members, but this user only sees messages newer than clearedAt[them].
  clearedAt: { type: Map, of: Date, default: {} },

  // Chat-wide pinned message pointer (up to 3, WhatsApp-style). Stored as
  // an array so re-pinning the same message is idempotent.
  pinnedMessages: [{
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    pinnedAt:  { type: Date, default: Date.now },
    pinnedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  }],

}, { timestamps: true });

// ── Indexes ────────────────────────────────────────────────────────────────
// Inbox query: "all my chats, newest first".
chatSchema.index({ members: 1, updatedAt: -1 });
// Fast 1-on-1 dedupe lookup — the createOrGetChat path.
chatSchema.index({ type: 1, members: 1 });
// Filtered inbox queries (pinned / muted / archived).
chatSchema.index({ pinnedBy:   1, updatedAt: -1 });
chatSchema.index({ archivedBy: 1, updatedAt: -1 });

module.exports = mongoose.model('Chat', chatSchema);
