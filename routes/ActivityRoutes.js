// Backend/routes/ActivityRoutes.js
//
// All "My Activity" endpoints (viewed profiles, shared videos, search history,
// comments history). Mounted at /api/activity/* in server.js.
// Every route is JWT-protected — activity data is per-user and private.

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/Auth');
const A = require('../controllers/ActivityController');

// ── Viewed Profiles ─────────────────────────────────────────────────────────
router.get   ('/viewed-profiles',             protect, A.listProfileViews);
router.post  ('/viewed-profiles',             protect, A.recordProfileView);
router.delete('/viewed-profiles',             protect, A.clearProfileViews);
router.delete('/viewed-profiles/:profileId',  protect, A.deleteProfileView);

// ── Shared Videos ───────────────────────────────────────────────────────────
router.get   ('/shared-videos',     protect, A.listShares);
router.post  ('/shared-videos',     protect, A.recordShare);
router.delete('/shared-videos',     protect, A.clearShares);
router.delete('/shared-videos/:id', protect, A.deleteShare);

// ── Comments History ────────────────────────────────────────────────────────
router.get   ('/comments', protect, A.listMyComments);

// ── Search History ──────────────────────────────────────────────────────────
router.get   ('/search-history',     protect, A.listSearches);
router.post  ('/search-history',     protect, A.recordSearch);
router.delete('/search-history',     protect, A.clearSearches);
router.delete('/search-history/:id', protect, A.deleteSearch);

// ── Clear everything ────────────────────────────────────────────────────────
router.delete('/all', protect, A.clearAll);

module.exports = router;
