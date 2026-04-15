// Backend/routes/UserRoutes.js
const express    = require('express');
const router     = express.Router();
const { protect }  = require('../middleware/Auth');
const {
  getMe,
  getProfileImageSignature,
  updateProfileImage,
  removeProfileImage,
  updateProfile,
} = require('../controllers/UserController');

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

module.exports = router;
