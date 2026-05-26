// Backend/controllers/UserController.js
const User       = require('../models/User');
const Video      = require('../models/Video');
const cloudinary = require('../config/cloudinary');

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
    whoCanMessage:    'everyone',  // 'everyone' | 'followers' | 'nobody'
    whoCanComment:    'everyone',
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

    // Always exclude self. When q is empty we still return a list — the chat
    // screen uses this to show "people you can chat with" before the user has
    // any conversations. With a query we filter by username / fullName regex.
    const filter = { _id: { $ne: req.user.id } };
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

    const users = await User.find(filter)
      .select('fullName username profileImage bio isVerified isOnline lastSeen')
      .sort(sort)
      .limit(q.length > 0 ? 20 : 30)
      .lean();

    return ok(res, { users });
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
    const user = await User.findById(req.user.id);
    if (!user) return fail(res, 'User not found', 404);

    // Count this user's videos that aren't soft-deleted
    const totalVideos = await Video.countDocuments({
      userId: req.user.id,
      status: { $ne: 'deleted' },
    });

    return ok(res, { user: safeUser(user, { totalVideos }) });
  } catch (err) {
    console.error('getMe error:', err);
    return fail(res, 'Failed to fetch profile', 500);
  }
};

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
// Body: partial preferences object — deep-merged with existing.
// ─────────────────────────────────────────────────────────────────────────────
exports.updatePreferences = async (req, res) => {
  try {
    const patch = req.body || {};
    if (typeof patch !== 'object' || Array.isArray(patch)) {
      return fail(res, 'Body must be a preferences object');
    }

    const user = await User.findById(req.user.id);
    if (!user) return fail(res, 'User not found', 404);

    const merged = deepMerge(user.preferences || {}, patch);
    user.preferences = merged;
    user.markModified('preferences');
    await user.save();

    return ok(res, {
      message:     'Preferences updated',
      preferences: deepMerge(DEFAULT_PREFS, merged),
    });
  } catch (err) {
    console.error('updatePreferences error:', err);
    return fail(res, 'Failed to update preferences', 500);
  }
};
