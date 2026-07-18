// Backend/controllers/NotificationController.js
//
// /api/notifications/* — settings read/patch (delegating to the same
// sanitize+merge pipeline UserController uses), device token registration
// aliases, and the in-app notification history with badge counts.

const User         = require('../models/User');
const Notification = require('../models/Notification');

const ok   = (res, data, code = 200) => res.status(code).json({ success: true,  ...data });
const fail = (res, message, code = 400) => res.status(code).json({ success: false, message });

// The canonical notification keys — mirrors UserController.DEFAULT_PREFS.
const NOTIFICATION_DEFAULTS = {
  likes: true, comments: true, newFollowers: true, messages: true,
  mentions: true, appUpdates: true,
  emailSecurity: true, emailNewsletter: false, emailPromotions: false, emailWeekly: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications/settings
// ─────────────────────────────────────────────────────────────────────────────
exports.getSettings = async (req, res) => {
  try {
    const stored = req.user.preferences?.notifications || {};
    return ok(res, { settings: { ...NOTIFICATION_DEFAULTS, ...stored } });
  } catch (err) {
    console.error('notifications getSettings error:', err);
    return fail(res, 'Failed to load notification settings', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/notifications/settings — body: partial { likes: false, ... }
// Whitelisted to the known keys; booleans only.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateSettings = async (req, res) => {
  try {
    const patch = {};
    for (const key of Object.keys(NOTIFICATION_DEFAULTS)) {
      if (typeof req.body?.[key] === 'boolean') patch[key] = req.body[key];
    }
    if (!Object.keys(patch).length) {
      return fail(res, 'No valid settings in request body');
    }

    const user = await User.findById(req.user.id);
    if (!user) return fail(res, 'User not found', 404);

    user.preferences = user.preferences || {};
    user.preferences.notifications = {
      ...(user.preferences.notifications || {}),
      ...patch,
    };
    user.markModified('preferences');
    await user.save();

    return ok(res, {
      message:  'Notification settings updated',
      settings: { ...NOTIFICATION_DEFAULTS, ...user.preferences.notifications },
    });
  } catch (err) {
    console.error('notifications updateSettings error:', err);
    return fail(res, 'Failed to update notification settings', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notifications/register-device — { token, platform: 'expo'|'fcm' }
// DELETE /api/notifications/remove-device — { token, platform }
// Aliases of /api/users/push-token so the API surface matches the spec.
// ─────────────────────────────────────────────────────────────────────────────
exports.registerDevice = async (req, res) => {
  try {
    const { token, platform = 'expo' } = req.body || {};
    if (!token || typeof token !== 'string') return fail(res, 'Push token is required');

    const field = platform === 'fcm' ? 'fcmTokens' : 'expoPushTokens';
    await User.findByIdAndUpdate(req.user.id, { $addToSet: { [field]: token } });
    return ok(res, { message: 'Device registered for notifications' });
  } catch (err) {
    console.error('registerDevice error:', err);
    return fail(res, 'Failed to register device', 500);
  }
};

exports.removeDevice = async (req, res) => {
  try {
    const { token, platform = 'expo' } = req.body || {};
    if (!token || typeof token !== 'string') return fail(res, 'Push token is required');

    const field = platform === 'fcm' ? 'fcmTokens' : 'expoPushTokens';
    await User.findByIdAndUpdate(req.user.id, { $pull: { [field]: token } });
    return ok(res, { message: 'Device removed' });
  } catch (err) {
    console.error('removeDevice error:', err);
    return fail(res, 'Failed to remove device', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications/history?page=&limit=
// ─────────────────────────────────────────────────────────────────────────────
exports.getHistory = async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const [items, total, unread] = await Promise.all([
      Notification.find({ userId: req.user.id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('fromUserId', 'username fullName profileImage')
        .lean(),
      Notification.countDocuments({ userId: req.user.id }),
      Notification.countDocuments({ userId: req.user.id, read: false }),
    ]);

    return ok(res, {
      notifications: items,
      unreadCount:   unread,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getHistory error:', err);
    return fail(res, 'Failed to load notifications', 500);
  }
};

// PATCH /api/notifications/history/:id/read
exports.markRead = async (req, res) => {
  try {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $set: { read: true, readAt: new Date() } },
      { new: true },
    );
    if (!n) return fail(res, 'Notification not found', 404);
    const unread = await Notification.countDocuments({ userId: req.user.id, read: false });
    return ok(res, { message: 'Marked read', unreadCount: unread });
  } catch (err) {
    console.error('markRead error:', err);
    return fail(res, 'Failed to update notification', 500);
  }
};

// POST /api/notifications/history/read-all
exports.markAllRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user.id, read: false },
      { $set: { read: true, readAt: new Date() } },
    );
    return ok(res, { message: 'All notifications marked read', unreadCount: 0 });
  } catch (err) {
    console.error('markAllRead error:', err);
    return fail(res, 'Failed to update notifications', 500);
  }
};

// GET /api/notifications/unread-count — cheap badge poll
exports.getUnreadCount = async (req, res) => {
  try {
    const unread = await Notification.countDocuments({ userId: req.user.id, read: false });
    return ok(res, { unreadCount: unread });
  } catch (err) {
    return fail(res, 'Failed to load badge count', 500);
  }
};
