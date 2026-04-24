// Backend/controllers/UserController.js
const User       = require('../models/User');
const cloudinary = require('../config/cloudinary');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const ok   = (res, data, code = 200) => res.status(code).json({ success: true,  ...data });
const fail = (res, msg,  code = 400) => res.status(code).json({ success: false, message: msg });

const safeUser = (u) => ({
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
});

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH USERS
// GET /api/users/search?q=keyword
// ─────────────────────────────────────────────────────────────────────────────
exports.searchUsers = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return ok(res, { users: [] });

    const regex = new RegExp(q, 'i');
    const users = await User.find({
      _id: { $ne: req.user.id }, // exclude self
      $or: [
        { username: regex },
        { fullName: regex },
      ],
    })
      .select('fullName username profileImage bio')
      .limit(20)
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
    return ok(res, { user: safeUser(user) });
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
