// Backend/routes/VideoRoutes.js
const express  = require('express');
const router   = express.Router();
const { protect, maybeAuth } = require('../middleware/Auth');
const { upload } = require('../middleware/upload');

const {
  getUploadSignature,
  getAttachmentSignature,
  createVideo,
  getFeed,
  getVideoById,
  getUserVideos,
  updateVideo,
  deleteVideo,
  togglePin,
  toggleLikeCountVisibility,
  toggleShareCountVisibility,
  toggleArchive,
  getArchivedVideos,
  searchVideos,
  searchHashtags,
  recomputeRankings,
  toggleLike,
  toggleSave,
  toggleRepost,
  toggleFavorite,
  markNotInterested,
  recordView,
  downloadVideo,
  shareVideo,
  reportVideo,
  getSavedVideos,
  getLikedVideos,
  getFavoriteVideos,
} = require('../controllers/VideoController');

const {
  getComments,
  addComment,
  editComment,
  deleteComment,
  toggleCommentLike,
  pinComment,
  addReply,
  editReply,
  deleteReply,
  toggleReplyLike,
} = require('../controllers/CommentController');

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO — DIRECT CLOUDINARY UPLOAD (replaces old server-relay /upload route)
// ─────────────────────────────────────────────────────────────────────────────

// POST   /api/videos/upload-signature      — Get signed params for direct Cloudinary upload
router.post('/upload-signature', protect, getUploadSignature);

// GET    /api/videos/attachment-signature  — Sign upload for evidence/news files (image|raw)
//        Query: ?kind=image|raw
router.get('/attachment-signature', protect, getAttachmentSignature);

// POST   /api/videos/create                — Save video record after direct Cloudinary upload
router.post('/create', protect, createVideo);

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO — CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET    /api/videos/feed            — Paginated public feed
// maybeAuth (not protect): the feed is public, but when a valid token IS
// present req.user powers per-viewer behaviour — notInterested filtering,
// isLiked/isSaved flags, and the owner exemption in the hide-count strip.
router.get('/feed', maybeAuth, getFeed);

// POST   /api/videos/admin/recompute-rankings  — Backfill ranking scores
//        Optional: ?ai=true to call Gemini on un-analysed videos
//        Admin role required.
router.post('/admin/recompute-rankings', protect, recomputeRankings);

// GET    /api/videos/search          — Search videos by keyword
router.get('/search', maybeAuth, searchVideos);

// GET    /api/videos/search/hashtags — Search hashtags (aggregated from tags)
router.get('/search/hashtags', searchHashtags);

// GET    /api/videos/saved           — Current user's saved videos (auth required)
router.get('/saved',     protect, getSavedVideos);

// GET    /api/videos/liked           — Current user's liked videos (auth required)
router.get('/liked',     protect, getLikedVideos);

// GET    /api/videos/favorites       — Current user's favorite videos (auth required)
router.get('/favorites', protect, getFavoriteVideos);

// GET    /api/videos/archived        — Current user's archived videos (auth required, owner-only list)
router.get('/archived',  protect, getArchivedVideos);

// GET    /api/videos/user/:userId    — Videos uploaded by a specific user
// maybeAuth: isOwner controls private-video visibility + hide-count strip.
router.get('/user/:userId', maybeAuth, getUserVideos);

// GET    /api/videos/:id             — Single video details
// maybeAuth: owner exemption for archived videos + hide-count strip.
router.get('/:id', maybeAuth, getVideoById);

// PUT    /api/videos/:id             — Update video metadata (owner only)
router.put('/:id', protect, updateVideo);

// DELETE /api/videos/:id             — Delete video (owner / admin)
router.delete('/:id', protect, deleteVideo);

// PUT    /api/videos/:id/pin         — Pin/unpin to creator profile (owner only)
router.put('/:id/pin', protect, togglePin);

// PUT    /api/videos/:id/hide-like-count   — Hide/show like count (owner only)
router.put('/:id/hide-like-count',  protect, toggleLikeCountVisibility);

// PUT    /api/videos/:id/hide-share-count  — Hide/show share count (owner only)
router.put('/:id/hide-share-count', protect, toggleShareCountVisibility);

// PUT    /api/videos/:id/archive     — Archive/restore (owner only)
router.put('/:id/archive',          protect, toggleArchive);

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO — SOCIAL ACTIONS  (all auth required)
// ─────────────────────────────────────────────────────────────────────────────

// POST   /api/videos/:id/like            — Toggle like
router.post('/:id/like',           protect, toggleLike);

// POST   /api/videos/:id/save            — Toggle save / bookmark
router.post('/:id/save',           protect, toggleSave);

// POST   /api/videos/:id/repost          — Toggle repost
router.post('/:id/repost',         protect, toggleRepost);

// POST   /api/videos/:id/favorite        — Toggle favorite
router.post('/:id/favorite',       protect, toggleFavorite);

// POST   /api/videos/:id/not-interested  — Mark as not interested
router.post('/:id/not-interested', protect, markNotInterested);

// POST   /api/videos/:id/view            — Record a view (auth optional)
router.post('/:id/view',           maybeAuth, recordView);

// POST   /api/videos/:id/download        — Get signed download URL
router.post('/:id/download',       protect, downloadVideo);

// POST   /api/videos/:id/share           — Increment share count (auth optional:
//        signed-in sharers also get a SharedVideo history row)
router.post('/:id/share',          maybeAuth, shareVideo);

// POST   /api/videos/:id/report          — Report video
router.post('/:id/report',         protect, reportVideo);

// ─────────────────────────────────────────────────────────────────────────────
// COMMENTS
// ─────────────────────────────────────────────────────────────────────────────

// GET    /api/videos/:id/comments                              — Fetch comments
// maybeAuth: comments inherit the video's visibility/privacy gates.
router.get('/:id/comments',                            maybeAuth, getComments);

// POST   /api/videos/:id/comments                              — Add comment
router.post('/:id/comments',                             protect, addComment);

// PUT    /api/videos/:id/comments/:commentId                   — Edit comment
router.put('/:id/comments/:commentId',                   protect, editComment);

// DELETE /api/videos/:id/comments/:commentId                   — Delete comment
router.delete('/:id/comments/:commentId',                protect, deleteComment);

// POST   /api/videos/:id/comments/:commentId/like              — Toggle comment like
router.post('/:id/comments/:commentId/like',             protect, toggleCommentLike);

// POST   /api/videos/:id/comments/:commentId/pin               — Pin comment (video owner)
router.post('/:id/comments/:commentId/pin',              protect, pinComment);

// ─────────────────────────────────────────────────────────────────────────────
// REPLIES
// ─────────────────────────────────────────────────────────────────────────────

// POST   /api/videos/:id/comments/:commentId/reply             — Add reply
router.post('/:id/comments/:commentId/reply',            protect, addReply);

// PUT    /api/videos/:id/comments/:commentId/reply/:replyId    — Edit reply
router.put('/:id/comments/:commentId/reply/:replyId',    protect, editReply);

// DELETE /api/videos/:id/comments/:commentId/reply/:replyId   — Delete reply
router.delete('/:id/comments/:commentId/reply/:replyId', protect, deleteReply);

// POST   /api/videos/:id/comments/:commentId/reply/:replyId/like — Toggle reply like
router.post('/:id/comments/:commentId/reply/:replyId/like', protect, toggleReplyLike);

module.exports = router;
