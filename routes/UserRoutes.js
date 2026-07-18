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
  getMediaSignature,
  registerPushToken,
  unregisterPushToken,
} = require('../controllers/UserController');
const { getUserReposts } = require('../controllers/VideoController');
const {
  getUserProfile,
  followUser,
  unfollowUser,
  listFollowRequests,
  acceptFollowRequest,
  declineFollowRequest,
  listFollowers,
  listFollowing,
  blockUser,
  unblockUser,
  listBlockedUsers,
} = require('../controllers/SocialController');

// ── Search ────────────────────────────────────────────────────────────────────
// GET  /api/users/search?q=keyword   — find users by name or username
router.get('/search', protect, searchUsers);

// ── Current user ─────────────────────────────────────────────────────────────
// GET  /api/users/me                  — fetch own full profile
router.get('/me', protect, getMe);

// ── Profile image ─────────────────────────────────────────────────────────────
// GET  /api/users/profile-image/signature  — get Cloudinary signed params
router.get('/profile-image/signature', protect, getProfileImageSignature);

// GET  /api/users/media-signature?kind=chat-image|story-video|cover|…
//                                — general-purpose signature for the newer
//                                  media classes (see cloudinaryFolders.js).
router.get('/media-signature', protect, getMediaSignature);

// POST /api/users/profile-image            — save imageUrl + publicId after upload
router.post('/profile-image', protect, updateProfileImage);

// DELETE /api/users/profile-image          — remove image from Cloudinary + DB
router.delete('/profile-image', protect, removeProfileImage);

// ── Profile fields ────────────────────────────────────────────────────────────
// PUT  /api/users/profile             — update fullName, username, bio, country
router.put('/profile', protect, updateProfile);

// PUT  /api/users/preferences         — privacy / notifications / content / language
router.put('/preferences', protect, updatePreferences);

// ── Social: static routes ─────────────────────────────────────────────────────
// NOTE: these MUST stay registered BEFORE the '/:userId/…' param routes below,
// otherwise Express would match 'blocked' / 'follow-requests' as a :userId.
// GET  /api/users/blocked?page&limit&q — my blocked-users list (searchable)
router.get('/blocked', protect, listBlockedUsers);

// GET  /api/users/follow-requests     — pending incoming requests (private account)
router.get('/follow-requests', protect, listFollowRequests);

// POST /api/users/follow-requests/:requesterId/accept   — approve a request
// POST /api/users/follow-requests/:requesterId/decline  — reject a request
router.post('/follow-requests/:requesterId/accept',  protect, acceptFollowRequest);
router.post('/follow-requests/:requesterId/decline', protect, declineFollowRequest);

// ── Per-user param routes ─────────────────────────────────────────────────────
// GET  /api/users/:userId/reposts     — list of videos this user has reposted
router.get('/:userId/reposts', protect, getUserReposts);

// GET  /api/users/:userId/profile     — public profile + relationship flags
router.get('/:userId/profile', protect, getUserProfile);

// POST   /api/users/:userId/follow    — follow (or request, if account is private)
// DELETE /api/users/:userId/follow    — unfollow / cancel a pending request
router.post  ('/:userId/follow', protect, followUser);
router.delete('/:userId/follow', protect, unfollowUser);

// GET  /api/users/:userId/followers   — paginated followers list (privacy-gated)
// GET  /api/users/:userId/following   — paginated following list (privacy-gated)
router.get('/:userId/followers', protect, listFollowers);
router.get('/:userId/following', protect, listFollowing);

// POST   /api/users/:userId/block     — block + cascade-remove all relationships
// DELETE /api/users/:userId/block     — unblock
router.post  ('/:userId/block', protect, blockUser);
router.delete('/:userId/block', protect, unblockUser);

// ── Push notifications ────────────────────────────────────────────────────────
// POST /api/users/push-token     — register the current device's Expo/FCM token
// DELETE /api/users/push-token   — unregister on logout
router.post  ('/push-token', protect, registerPushToken);
router.delete('/push-token', protect, unregisterPushToken);

module.exports = router;
