// Backend/controllers/UserController.js
const User       = require('../models/User');
const Video      = require('../models/Video');
const cloudinary = require('../config/cloudinary');
const cache      = require('../services/cache');
const feedCache  = require('../services/feedCache');
const privacy    = require('../services/privacy');
const { resolveKind } = require('../services/cloudinaryFolders');

// socket.js is required lazily (on first use, not at module load) to avoid a
// circular import at boot. broadcastOnlineStatus is a newer export, so every
// call site guards with a typeof check and degrades gracefully without it.
let sock;
const getSock = () => sock || (sock = require('../socket'));

const kUser = (id) => `user:byId:${id}`;
const TTL_USER = 60; // 1 min — profile edits, follow counts change often

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const ok   = (res, data, code = 200) => res.status(code).json({ success: true,  ...data });
const fail = (res, msg,  code = 400) => res.status(code).json({ success: false, message: msg });

const DEFAULT_PREFS = {
  privacy: {
    privateAccount:   false,
    hideOnlineStatus: false,
    hideFollowers:    false,
    whoCanMessage:    'everyone',  // 'everyone' | 'followers' | 'mutual' | 'nobody'
    whoCanComment:    'everyone',  // 'everyone' | 'followers' | 'mutual' | 'nobody'
  },
  notifications: {
    likes:           true,
    comments:        true,
    newFollowers:    true,
    messages:        true,
    mentions:        true,
    appUpdates:      true,
    emailSecurity:   true,
    emailNewsletter: false,
    emailPromotions: false,
    emailWeekly:     false,
  },
  content: {
    autoplay:         true,
    hdOnWifi:         true,
    dataSaver:        false,
    personalizedRecs: true,
    hideSensitive:    false,
    interestedTopics: [],
  },
  language: 'en',
};

// Recursive deep-merge that lets the client patch nested preferences.
const deepMerge = (target, patch) => {
  if (typeof target !== 'object' || target === null) return patch;
  if (typeof patch  !== 'object' || patch  === null) return patch;
  if (Array.isArray(patch)) return patch;
  const out = { ...target };
  for (const k of Object.keys(patch)) out[k] = deepMerge(target[k], patch[k]);
  return out;
};

const safeUser = (u, extras = {}) => ({
  _id:                  u._id,
  fullName:             u.fullName,
  username:             u.username,
  email:                u.email,
  bio:                  u.bio          || '',
  country:              u.country      || '',
  profileImage:         u.profileImage || null,
  profileImagePublicId: u.profileImagePublicId || null,
  role:                 u.role,
  isVerified:           u.isVerified,
  createdAt:            u.createdAt,
  followersCount:       u.followers?.length || 0,
  followingCount:       u.following?.length || 0,
  language:             u.language || 'en',
  preferences:          deepMerge(DEFAULT_PREFS, u.preferences || {}),
  ...extras,
});

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH USERS
// GET /api/users/search?q=keyword
// ─────────────────────────────────────────────────────────────────────────────
exports.searchUsers = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();

    // Always exclude self AND every blocked pair (either direction) — blocked
    // users must never surface in search. When q is empty we still return a
    // list — the chat screen uses this to show "people you can chat with"
    // before the user has any conversations. With a query we filter by
    // username / fullName regex.
    const excluded = await privacy.blockedIdSetFor(req.user.id);
    const filter = { _id: { $nin: [req.user.id, ...excluded] } };
    if (q.length > 0) {
      // Escape regex metacharacters so a username with "." or "*" doesn't blow up
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safe, 'i');
      filter.$or = [{ username: regex }, { fullName: regex }];
    }

    // No query → show recently-active users first so the empty-state list
    // feels useful. With a query, sort by username so matches are stable.
    const sort = q.length > 0
      ? { username: 1 }
      : { lastSeen: -1, createdAt: -1 };

    // `preferences` is selected ONLY so applyPresencePolicy can consult
    // hideOnlineStatus — the policy helper strips it before it reaches the wire.
    const users = await User.find(filter)
      .select('fullName username profileImage bio isVerified isOnline lastSeen preferences')
      .sort(sort)
      .limit(q.length > 0 ? 20 : 30)
      .lean();

    return ok(res, {
      users: users.map((u) => privacy.applyPresencePolicy(u, req.user.id)),
    });
  } catch (err) {
    console.error('searchUsers error:', err);
    return fail(res, 'Search failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET CURRENT USER PROFILE
// GET /api/users/me
// ─────────────────────────────────────────────────────────────────────────────
exports.getMe = async (req, res) => {
  try {
    // Cache-aside — invalidated on any profile / image / preference update
    // (see helper `invalidateUserCache` used by every write site below).
    const payload = await cache.withCache(kUser(req.user.id), TTL_USER, async () => {
      const user = await User.findById(req.user.id);
      if (!user) return null;

      const totalVideos = await Video.countDocuments({
        userId: req.user.id,
        status: { $ne: 'deleted' },
      });

      return safeUser(user, {
        totalVideos,
        // Badge count for the "Follow Requests" entry point (private accounts).
        // Every request write path invalidates user:byId:<id>, so this stays fresh.
        pendingRequestsCount: user.followRequests?.length || 0,
      });
    });

    if (!payload) return fail(res, 'User not found', 404);
    return ok(res, { user: payload });
  } catch (err) {
    console.error('getMe error:', err);
    return fail(res, 'Failed to fetch profile', 500);
  }
};

// Central invalidator used by every write path (profile edit, image change,
// preference update). Cheap enough to fire even when Redis is offline.
const invalidateUserCache = (userId) => cache.del(kUser(String(userId))).catch(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// GET PROFILE IMAGE UPLOAD SIGNATURE
// GET /api/users/profile-image/signature
//
// Client calls this first, then uploads image DIRECTLY to Cloudinary using
// the returned signed params — server never receives the image bytes.
// ─────────────────────────────────────────────────────────────────────────────
exports.getProfileImageSignature = async (req, res) => {
  try {
    const timestamp    = Math.round(Date.now() / 1000);
    const folder       = `truevision/profiles/${req.user.id}`;

    // overwrite: true replaces any existing image with the same public_id
    // This keeps storage clean — one image per user
    const paramsToSign = { folder, overwrite: true, timestamp };
    const signature    = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_SECRET_KEY,
    );

    return ok(res, {
      signature,
      timestamp,
      folder,
      overwrite:  true,
      api_key:    process.env.CLOUDINARY_API_KEY,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (err) {
    console.error('getProfileImageSignature error:', err);
    return fail(res, 'Could not generate upload signature', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PROFILE IMAGE
// POST /api/users/profile-image
// Body: { imageUrl, publicId }  — values returned by Cloudinary after upload
//
// Called by the client AFTER the image is already on Cloudinary.
// Deletes the previous profile image from Cloudinary to avoid orphaned files.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateProfileImage = async (req, res) => {
  try {
    const { imageUrl, publicId } = req.body;

    if (!imageUrl || !publicId) {
      return fail(res, 'imageUrl and publicId are required');
    }

    const user = await User.findById(req.user.id);
    if (!user) return fail(res, 'User not found', 404);

    // Delete OLD image from Cloudinary (if it exists and is different)
    if (user.profileImagePublicId && user.profileImagePublicId !== publicId) {
      await cloudinary.uploader
        .destroy(user.profileImagePublicId, { resource_type: 'image' })
        .catch((e) => console.warn('Could not delete old profile image:', e.message));
    }

    user.profileImage         = imageUrl;
    user.profileImagePublicId = publicId;
    await user.save();

    return ok(res, {
      message: 'Profile image updated successfully',
      user:    safeUser(user),
    });
  } catch (err) {
    console.error('updateProfileImage error:', err);
    return fail(res, err.message || 'Failed to update profile image', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE PROFILE IMAGE
// DELETE /api/users/profile-image
//
// Deletes the image from Cloudinary and clears it in the database.
// ─────────────────────────────────────────────────────────────────────────────
exports.removeProfileImage = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return fail(res, 'User not found', 404);

    if (user.profileImagePublicId) {
      await cloudinary.uploader
        .destroy(user.profileImagePublicId, { resource_type: 'image' })
        .catch((e) => console.warn('Cloudinary delete failed:', e.message));
    }

    user.profileImage         = null;
    user.profileImagePublicId = null;
    await user.save();

    return ok(res, {
      message: 'Profile image removed',
      user:    safeUser(user),
    });
  } catch (err) {
    console.error('removeProfileImage error:', err);
    return fail(res, 'Failed to remove profile image', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PROFILE FIELDS
// PUT /api/users/profile
// Body: { fullName, username, bio, country }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const { fullName, username, bio, country } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) return fail(res, 'User not found', 404);

    // Validate username uniqueness only if changed
    if (username && username.toLowerCase().trim() !== user.username) {
      const taken = await User.findOne({
        username: username.toLowerCase().trim(),
        _id: { $ne: req.user.id },
      });
      if (taken) return fail(res, 'That username is already taken');
    }

    // Validate fullName
    if (fullName !== undefined) {
      const name = fullName.trim();
      if (name.length < 2)  return fail(res, 'Full name must be at least 2 characters');
      if (name.length > 50) return fail(res, 'Full name cannot exceed 50 characters');
      user.fullName = name;
    }

    if (username !== undefined) {
      const uname = username.toLowerCase().trim();
      if (uname.length < 3)               return fail(res, 'Username must be at least 3 characters');
      if (uname.length > 30)              return fail(res, 'Username cannot exceed 30 characters');
      if (!/^[a-z0-9_]+$/.test(uname))   return fail(res, 'Username can only contain lowercase letters, numbers, and underscores');
      user.username = uname;
    }

    if (bio     !== undefined) user.bio     = bio.trim().slice(0, 150);
    if (country !== undefined) user.country = country.trim();

    await user.save();

    return ok(res, {
      message: 'Profile updated successfully',
      user:    safeUser(user),
    });
  } catch (err) {
    console.error('updateProfile error:', err);
    return fail(res, err.message || 'Failed to update profile', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PREFERENCES (privacy / notifications / content / language)
// PUT /api/users/preferences
// Body: partial preferences object — whitelist-validated, then deep-merged.
// ─────────────────────────────────────────────────────────────────────────────

// Whitelist-based sanitizer for preference patches. Only known keys survive
// (unknown keys are silently dropped) and every value is validated/coerced:
//   privacy.*        booleans coerced with `=== true` (only when present);
//                    whoCanMessage/whoCanComment restricted to AUDIENCE_VALUES
//   notifications.*  known boolean keys from DEFAULT_PREFS.notifications
//   content.*        known keys; booleans, except interestedTopics which is
//                    an array of strings (each ≤40 chars, max 30 items)
//   language         non-empty string, ≤10 chars
// Returns a patch that is safe to deep-merge into the Mixed blob.
const sanitizePreferencesPatch = (patch) => {
  const out = {};
  const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

  if (isPlainObject(patch.privacy)) {
    const p = {};
    for (const k of ['privateAccount', 'hideOnlineStatus', 'hideFollowers']) {
      if (k in patch.privacy) p[k] = patch.privacy[k] === true;
    }
    for (const k of ['whoCanMessage', 'whoCanComment']) {
      if (k in patch.privacy && privacy.AUDIENCE_VALUES.includes(patch.privacy[k])) {
        p[k] = patch.privacy[k];
      }
    }
    if (Object.keys(p).length) out.privacy = p;
  }

  if (isPlainObject(patch.notifications)) {
    const n = {};
    for (const k of Object.keys(DEFAULT_PREFS.notifications)) {
      if (k in patch.notifications) n[k] = patch.notifications[k] === true;
    }
    if (Object.keys(n).length) out.notifications = n;
  }

  if (isPlainObject(patch.content)) {
    const c = {};
    for (const k of Object.keys(DEFAULT_PREFS.content)) {
      if (!(k in patch.content)) continue;
      if (k === 'interestedTopics') {
        if (Array.isArray(patch.content[k])) {
          c[k] = patch.content[k]
            .filter((t) => typeof t === 'string')
            .map((t) => t.trim().slice(0, 40))
            .filter((t) => t.length > 0)
            .slice(0, 30);
        }
      } else {
        c[k] = patch.content[k] === true;
      }
    }
    if (Object.keys(c).length) out.content = c;
  }

  if (typeof patch.language === 'string') {
    const lang = patch.language.trim();
    if (lang.length > 0 && lang.length <= 10) out.language = lang;
  }

  return out;
};

exports.updatePreferences = async (req, res) => {
  try {
    const patch = req.body || {};
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      return fail(res, 'Body must be a preferences object');
    }

    // Validate BEFORE merging — malformed/unknown keys never reach the blob.
    const clean = sanitizePreferencesPatch(patch);
    if (!Object.keys(clean).length) {
      return fail(res, 'No valid preference fields in request');
    }

    const user = await User.findById(req.user.id);
    if (!user) return fail(res, 'User not found', 404);

    // Snapshot for rollback: a deep clone of the preferences BEFORE the merge.
    // If the feed-cache invalidation below fails we restore this so the DB can
    // never be left ahead of a still-stale cache.
    const prefsSnapshot = JSON.parse(JSON.stringify(user.preferences || {}));

    // Snapshot privacy BEFORE the merge so transitions are detectable below.
    const before = privacy.getPrivacy(user);

    const merged = deepMerge(user.preferences || {}, clean);
    user.preferences = merged;
    user.markModified('preferences');
    await user.save();

    const after  = privacy.getPrivacy(user);
    const userId = String(user._id);

    // ── Recommendation cache invalidation (AWAITED · per-user · rollback-safe) ─
    // Only recommendation-affecting keys (personalizedRecs / hideSensitive /
    // interestedTopics) touch the feed cache — playback toggles (autoplay,
    // hdOnWifi, dataSaver) are deliberately excluded. We AWAIT the invalidation
    // so success is returned only after this viewer's cached feed + pool are
    // gone; the frontend can then refetch and never sees a stale feed.
    if (feedCache.affectsRecommendations(clean.content)) {
      try {
        await feedCache.invalidateUserFeed(userId);
      } catch (err) {
        // Redis is up but the delete failed. Restore the previous preferences
        // so the DB isn't left updated while the cache still serves the old
        // feed — no inconsistent state — and tell the client to roll back.
        console.error('[updatePreferences] feed cache invalidation failed — rolling back:', err.message);
        try {
          user.preferences = prefsSnapshot;
          user.markModified('preferences');
          await user.save();
        } catch (rbErr) {
          console.error('[updatePreferences] rollback save failed:', rbErr.message);
        }
        return res.status(503).json({
          success: false,
          code:    'CACHE_SYNC_FAILED',
          message: 'Could not apply your change right now. Please try again.',
        });
      }
    }

    // ── Presence side-effects (best-effort — never fail the request) ─────────
    try {
      const s = getSock();
      if (typeof s.broadcastOnlineStatus === 'function') {
        // Hiding online status: chat partners immediately see the user go
        // offline, with lastSeen suppressed (null).
        if (!before.hideOnlineStatus && after.hideOnlineStatus) {
          s.broadcastOnlineStatus(userId, false, null);
        }
        // Un-hiding while actually connected: partners see them come back.
        if (before.hideOnlineStatus && !after.hideOnlineStatus && s.presenceIsOnline(userId)) {
          s.broadcastOnlineStatus(userId, true);
        }
      }
    } catch (e) {
      console.warn('updatePreferences: presence broadcast skipped:', e.message);
    }

    // ── Going public: auto-accept every pending follow request ───────────────
    // Two bulk writes instead of N round-trips: my doc gains all requesters
    // as followers (and drops the queue), each requester gains me in following.
    if (before.privateAccount && !after.privateAccount && user.followRequests?.length) {
      const requesterIds = user.followRequests.map((r) => r.from).filter(Boolean);
      await Promise.all([
        User.updateOne(
          { _id: user._id },
          {
            $addToSet: { followers: { $each: requesterIds } },
            // Only the snapshotted, auto-accepted requests are removed —
            // requests that arrive concurrently survive for manual review.
            $pull:     { followRequests: { from: { $in: requesterIds } } },
          },
        ),
        User.updateMany(
          { _id: { $in: requesterIds } },
          { $addToSet: { following: user._id } },
        ),
      ]);
      // updateOne/updateMany bypass the model's cache hook — invalidate manually.
      await Promise.all(
        [userId, ...requesterIds.map(String)].map((id) => invalidateUserCache(id)),
      );
    }

    return ok(res, {
      message:     'Preferences updated',
      preferences: deepMerge(DEFAULT_PREFS, merged),
    });
  } catch (err) {
    console.error('updatePreferences error:', err);
    return fail(res, 'Failed to update preferences', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL-PURPOSE MEDIA UPLOAD SIGNATURE
// GET /api/users/media-signature?kind=chat-image|chat-video|story-image|…
//
// Signs a Cloudinary upload for any of the folder classes the app now
// supports (see services/cloudinaryFolders.js). Existing controller-scoped
// signatures (profile, video, attachment) stay in place unchanged for
// backward compat — this new endpoint just eliminates the need to add a
// bespoke signature endpoint every time a new media class appears.
// ─────────────────────────────────────────────────────────────────────────────
exports.getMediaSignature = async (req, res) => {
  try {
    const kind = String(req.query.kind || '').trim();
    const resolved = resolveKind(kind, req.user.id);
    if (!resolved) return fail(res, `Unknown media kind "${kind}"`, 400);

    const { folder, resourceType } = resolved;
    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = { folder, timestamp };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_SECRET_KEY,
    );

    return ok(res, {
      signature,
      timestamp,
      folder,
      resourceType,
      api_key:    process.env.CLOUDINARY_API_KEY,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (err) {
    console.error('getMediaSignature error:', err);
    return fail(res, 'Could not generate upload signature', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/push-token
//   Body: { token, platform: 'expo' | 'fcm' }
// Keeps a *set* of tokens per user so the same account across multiple
// devices is properly notified. Old tokens self-expire when Expo/FCM
// returns "DeviceNotRegistered" during a send (see pushService.js).
exports.registerPushToken = async (req, res) => {
  try {
    const userId = req.user.id;
    const { token, platform = 'expo' } = req.body || {};
    if (!token || typeof token !== 'string') return fail(res, 'token is required');
    if (!['expo', 'fcm'].includes(platform))  return fail(res, 'invalid platform');

    const field = platform === 'expo' ? 'expoPushTokens' : 'fcmTokens';
    await User.updateOne({ _id: userId }, { $addToSet: { [field]: token } });
    return ok(res, { message: 'Token registered' });
  } catch (err) {
    console.error('registerPushToken error:', err);
    return fail(res, 'Failed to register token', 500);
  }
};

// DELETE /api/users/push-token
//   Body: { token, platform }
exports.unregisterPushToken = async (req, res) => {
  try {
    const userId = req.user.id;
    const { token, platform = 'expo' } = req.body || {};
    if (!token) return fail(res, 'token is required');

    const field = platform === 'expo' ? 'expoPushTokens' : 'fcmTokens';
    await User.updateOne({ _id: userId }, { $pull: { [field]: token } });
    return ok(res, { message: 'Token removed' });
  } catch (err) {
    console.error('unregisterPushToken error:', err);
    return fail(res, 'Failed to remove token', 500);
  }
};
