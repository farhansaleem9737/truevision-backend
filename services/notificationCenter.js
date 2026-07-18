// Backend/services/notificationCenter.js
//
// The single choke-point every notification goes through:
//
//   notificationCenter.notify(recipientId | userDoc, kind, { title, body, data, fromUserId })
//
//   1. Loads the recipient (tokens + preferences) if given an id.
//   2. Checks preferences.notifications[kind] — default ON; an explicit
//      `false` suppresses BOTH the push and the history row.
//   3. Writes a Notification history row (backs the in-app list + badge).
//   4. Sends the push with `badge` = unread count so app icons stay honest.
//
// Never throws — notifications are always best-effort side effects.

const User         = require('../models/User');
const Notification = require('../models/Notification');
const push         = require('./pushService');

const CHANNEL_FOR = {
  likes:        'social',
  comments:     'social',
  newFollowers: 'social',
  mentions:     'social',
  messages:     'chat-messages',
  appUpdates:   'social',
};

/** Resolve a user doc with the fields notify() needs. */
const loadRecipient = async (recipient) => {
  if (!recipient) return null;
  if (typeof recipient === 'object' && recipient.expoPushTokens !== undefined) return recipient;
  const id = recipient._id || recipient;
  return User.findById(id).select('expoPushTokens fcmTokens preferences fullName username').lean();
};

/**
 * @param {ObjectId|object} recipient  user id or a user doc that already has
 *                                     expoPushTokens/fcmTokens/preferences
 * @param {string} kind   'likes'|'comments'|'newFollowers'|'messages'|'mentions'|'appUpdates'
 * @param {object} opts   { title, body, data, fromUserId, skipHistory }
 * @returns {Promise<{delivered:boolean, suppressed:boolean}>}
 */
exports.notify = async (recipient, kind, { title, body = '', data = {}, fromUserId = null, skipHistory = false } = {}) => {
  try {
    const user = await loadRecipient(recipient);
    if (!user) return { delivered: false, suppressed: false };

    // Preference gate — default ON when the key is absent.
    const enabled = user.preferences?.notifications?.[kind] !== false;
    if (!enabled) return { delivered: false, suppressed: true };

    // Self-notifications are never useful (liking your own video, etc.).
    if (fromUserId && String(fromUserId) === String(user._id)) {
      return { delivered: false, suppressed: true };
    }

    // History row first, so the badge count below includes this event.
    if (!skipHistory) {
      await Notification.create({
        userId: user._id,
        kind,
        title:  String(title || 'TrueVision').slice(0, 120),
        body:   String(body || '').slice(0, 300),
        data,
        fromUserId,
      });
      Notification.trimOld(user._id).catch(() => {});
    }

    const badge = await Notification.countDocuments({ userId: user._id, read: false });

    const payload = {
      title,
      body,
      data: { ...data, kind },
      channelId: CHANNEL_FOR[kind] || 'default',
      badge,
    };

    // pushService.deliver is private; route through the closest public sender.
    const result = kind === 'messages'
      ? await push.sendChatNotification(user, {
          title, body, badge,
          chatId: data.chatId, senderId: data.senderId,
          messageId: data.messageId, type: data.type,
        })
      : await push.sendSocialNotification(user, {
          title, body, kind, fromUserId, badge,
          // Forward the deep-link payload so a tapped push lands on the same
          // video/comment the in-app history row points at.
          data,
        });

    return { delivered: (result?.sent || 0) > 0, suppressed: false, badge, payload };
  } catch (err) {
    console.warn('[notificationCenter] notify failed:', err.message);
    return { delivered: false, suppressed: false };
  }
};

/** Unread badge for a user — used by the history endpoints. */
exports.unreadCount = (userId) =>
  Notification.countDocuments({ userId, read: false }).catch(() => 0);

/**
 * Batched fan-out for one event to MANY recipients (chat messages to a group,
 * etc.). Same semantics as notify() — preference gate, history row, badge —
 * but with a fixed query count instead of 4 per recipient:
 *   1 User.find  +  1 insertMany  +  1 aggregate  +  N pushes (unavoidable).
 *
 * @param {Array<ObjectId|string>} recipientIds
 * @param {string} kind
 * @param {function} build  (user) => ({ title, body, data }) — per-recipient copy
 */
exports.notifyMany = async (recipientIds, kind, build, { fromUserId = null } = {}) => {
  try {
    const ids = (recipientIds || []).filter(Boolean);
    if (!ids.length) return { delivered: 0, suppressed: 0 };

    const users = await User.find({ _id: { $in: ids } })
      .select('expoPushTokens fcmTokens preferences fullName username')
      .lean();

    // Preference gate + no self-notify.
    const eligible = users.filter((u) =>
      u.preferences?.notifications?.[kind] !== false &&
      !(fromUserId && String(fromUserId) === String(u._id)),
    );
    if (!eligible.length) return { delivered: 0, suppressed: users.length };

    // One insert for every history row.
    const rows = eligible.map((u) => {
      const copy = build(u) || {};
      return {
        userId: u._id,
        kind,
        title:  String(copy.title || 'TrueVision').slice(0, 120),
        body:   String(copy.body  || '').slice(0, 300),
        data:   copy.data || {},
        fromUserId,
      };
    });
    await Notification.insertMany(rows, { ordered: false }).catch(() => {});
    eligible.forEach((u) => Notification.trimOld(u._id).catch(() => {}));

    // One aggregate for every badge count.
    const counts = await Notification.aggregate([
      { $match: { userId: { $in: eligible.map((u) => u._id) }, read: false } },
      { $group: { _id: '$userId', n: { $sum: 1 } } },
    ]).catch(() => []);
    const badgeFor = new Map(counts.map((c) => [String(c._id), c.n]));

    await Promise.all(eligible.map((u) => {
      const copy  = build(u) || {};
      const badge = badgeFor.get(String(u._id)) || 0;
      return kind === 'messages'
        ? push.sendChatNotification(u, {
            title: copy.title, body: copy.body, badge,
            chatId: copy.data?.chatId, senderId: copy.data?.senderId,
            messageId: copy.data?.messageId, type: copy.data?.type,
          })
        : push.sendSocialNotification(u, {
            title: copy.title, body: copy.body, kind, fromUserId, badge, data: copy.data,
          });
    }));

    return { delivered: eligible.length, suppressed: users.length - eligible.length };
  } catch (err) {
    console.warn('[notificationCenter] notifyMany failed:', err.message);
    return { delivered: 0, suppressed: 0 };
  }
};
