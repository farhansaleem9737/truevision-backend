// Backend/models/Chat.js
const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  // Exactly two members for 1-on-1 DM
  members: [{
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  }],

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

module.exports = mongoose.model('Chat', chatSchema);
