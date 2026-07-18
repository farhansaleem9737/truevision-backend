// Backend/models/Notification.js
//
// In-app notification history. One row per delivered (or pref-suppressed-
// but-recorded? NO — suppressed kinds are not recorded) notification.
// Backs GET /api/notifications/history and the unread badge count that is
// attached to every outgoing push.

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },

  // Preference kind that gated this notification — one of the push toggles.
  kind: {
    type:    String,
    enum:    ['likes', 'comments', 'newFollowers', 'messages', 'mentions', 'appUpdates'],
    required: true,
    index:   true,
  },

  title: { type: String, required: true, maxlength: 120 },
  body:  { type: String, default: '',   maxlength: 300 },

  // Deep-link payload — mirrors what the push notification carries so a tap
  // in the history list can navigate the same way a push tap does.
  data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

  // Actor (who liked/commented/followed/messaged) — optional.
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  read:   { type: Boolean, default: false, index: true },
  readAt: { type: Date,    default: null },
}, { timestamps: true });

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1 });

// History cap — keep the latest 200 per user.
notificationSchema.statics.trimOld = async function (userId, keep = 200) {
  const excess = await this.find({ userId })
    .sort({ createdAt: -1 })
    .skip(keep)
    .select('_id')
    .lean();
  if (excess.length) await this.deleteMany({ _id: { $in: excess.map((d) => d._id) } });
};

module.exports = mongoose.model('Notification', notificationSchema);
