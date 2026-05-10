// Backend/models/Chat.js
//
// Single + group chats share this document. `type === 'single'` is a 1-on-1
// DM (members.length === 2 enforced by the controller); `type === 'group'`
// allows 2+ members and adds groupName / groupImage / createdBy.

const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  type: {
    type:    String,
    enum:    ['single', 'group'],
    default: 'single',
    index:   true,
  },

  // 2 for single chats, 2+ for groups
  members: [{
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  }],

  // Group-only metadata. Null/empty for single chats.
  groupName: {
    type:    String,
    default: '',
    trim:    true,
    maxlength: 80,
  },
  groupImage: {
    type:    String,
    default: '',
  },
  groupImagePublicId: {
    type:    String,
    default: '',
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User',
    default: null,
  },

  lastMessage: {
    text:      { type: String, default: '' },
    senderId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type:      { type: String, enum: ['text', 'video', 'image'], default: 'text' },
    createdAt: { type: Date,   default: Date.now },
  },

  // Per-member unread count: { "<userId>": <count> }
  unreadCount: {
    type: Map,
    of:   Number,
    default: {},
  },
}, { timestamps: true });

// Fast lookup: find all chats for a given user, sorted by most recent activity
chatSchema.index({ members: 1, updatedAt: -1 });
chatSchema.index({ type: 1, members: 1 });

module.exports = mongoose.model('Chat', chatSchema);
