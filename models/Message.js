// Backend/models/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  chatId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Chat',
    required: true,
    index:    true,
  },

  senderId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },

  // Message content
  text: {
    type:    String,
    default: '',
    trim:    true,
    maxlength: 5000,
  },

  type: {
    type:    String,
    enum:    ['text', 'video', 'image'],
    default: 'text',
  },

  // If type === 'video', reference the shared video
  videoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'Video',
    default: null,
  },

  // If type === 'image', store the image URL
  imageUrl: {
    type:    String,
    default: null,
  },

  // Read receipts
  seen:   { type: Boolean, default: false },
  seenAt: { type: Date,    default: null },

  // Soft-delete (unsend)
  deleted: { type: Boolean, default: false },

}, { timestamps: true });

// Fetch messages for a chat in chronological order with pagination
messageSchema.index({ chatId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
