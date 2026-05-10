// Backend/routes/UserRoutes.js
const express    = require('express');
const router     = express.Router();
const { protect }  = require('../middleware/Auth');
const {
  getMe,
  searchUsers,
  getProfileImageSignature,
  updateProfileImage,
  removeProfileImage,
  updateProfile,
  updatePreferences,
} = require('../controllers/UserController');
const { getUserReposts } = require('../controllers/VideoController');

// ── Search ────────────────────────────────────────────────────────────────────
// GET  /api/users/search?q=keyword   — find users by name or username
router.get('/search', protect, searchUsers);

// ── Current user ─────────────────────────────────────────────────────────────
// GET  /api/users/me                  — fetch own full profile
router.get('/me', protect, getMe);

// ── Profile image ─────────────────────────────────────────────────────────────
// GET  /api/users/profile-image/signature  — get Cloudinary signed params
router.get('/profile-image/signature', protect, getProfileImageSignature);

// POST /api/users/profile-image            — save imageUrl + publicId after upload
router.post('/profile-image', protect, updateProfileImage);

// DELETE /api/users/profile-image          — remove image from Cloudinary + DB
router.delete('/profile-image', protect, removeProfileImage);

// ── Profile fields ────────────────────────────────────────────────────────────
// PUT  /api/users/profile             — update fullName, username, bio, country
router.put('/profile', protect, updateProfile);

// PUT  /api/users/preferences         — privacy / notifications / content / language
router.put('/preferences', protect, updatePreferences);

// GET  /api/users/:userId/reposts     — list of videos this user has reposted
router.get('/:userId/reposts', protect, getUserReposts);

module.exports = router;
