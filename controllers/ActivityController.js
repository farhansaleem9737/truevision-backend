// Backend/controllers/ActivityController.js
//
// "My Activity" backend. Centralises:
//   • Watch History       — recordWatch / listWatch / deleteWatch / clearWatch
//   • Viewed Profiles     — recordProfileView / listProfileViews / delete / clear
//   • Shared Videos       — recordShare / listShares / delete / clear
//   • Search History      — recordSearch / listSearches / delete / clear
//   • Clear all activity  — clearAll
//
// Liked + Saved videos already live in VideoController (toggleLike, toggleSave,
// getLikedVideos, getSavedVideos) — we don't duplicate them.
//
// Pagination is offset-based ({ page, limit }) to match the rest of the API.
// All endpoints assume `req.user.id` is set by the `protect` middleware.

const mongoose       = require('mongoose');
const WatchHistory   = require('../models/WatchHistory');
const ViewedProfile  = require('../models/ViewedProfile');
const SharedVideo    = require('../models/SharedVideo');
const SearchHistory  = require('../models/SearchHistory');

// ── Helpers ──────────────────────────────────────────────────────────────────
const ok   = (res, data, statusCode = 200) =>
  res.status(statusCode).json({ success: true,  ...data });
const fail = (res, message, statusCode = 400) =>
  res.status(statusCode).json({ success: false, message });

// Parse + clamp page/limit query params consistently across endpoints.
const pageParams = (req, maxLimit = 50) => {
  const page  = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

const isObjectId = (s) => mongoose.Types.ObjectId.isValid(s);

// ═════════════════════════════════════════════════════════════════════════════
// WATCH HISTORY
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/activity/watch-history
//   Body: { videoId, lastPosition?, watchDuration? }
// Upserts the row so re-watching bumps `watchedAt` without duplicating.
exports.recordWatch = async (req, res) => {
  try {
    const { videoId, lastPosition = 0, watchDuration = 0 } = req.body;
    if (!isObjectId(videoId)) return fail(res, 'videoId is required');

    await WatchHistory.findOneAndUpdate(
      { userId: req.user.id, videoId },
      {
        $set: {
          watchedAt:     new Date(),
          lastPosition:  Math.max(0, Number(lastPosition)  || 0),
          watchDuration: Math.max(0, Number(watchDuration) || 0),
        },
        $setOnInsert: { userId: req.user.id, videoId },
      },
      { upsert: true, new: true },
    );
    return ok(res, { message: 'recorded' });
  } catch (err) {
    console.error('recordWatch error:', err);
    return fail(res, 'Failed to record watch', 500);
  }
};

// GET /api/activity/watch-history?page=1&limit=20
exports.listWatch = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);
    const filter = { userId: req.user.id };

    const [rows, total] = await Promise.all([
      WatchHistory.find(filter)
        .sort({ watchedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('videoId', 'title thumbnailUrl videoUrl duration userId category')
        .lean(),
      WatchHistory.countDocuments(filter),
    ]);

    // Drop rows whose video was deleted (populate returns null in that case).
    const items = rows
      .filter((r) => r.videoId)
      .map((r) => ({
        _id:           r._id,
        video:         r.videoId,
        watchedAt:     r.watchedAt,
        lastPosition:  r.lastPosition,
        watchDuration: r.watchDuration,
      }));

    return ok(res, {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('listWatch error:', err);
    return fail(res, 'Failed to fetch watch history', 500);
  }
};

// DELETE /api/activity/watch-history/:videoId — remove one entry
exports.deleteWatch = async (req, res) => {
  try {
    const { videoId } = req.params;
    if (!isObjectId(videoId)) return fail(res, 'invalid videoId');
    const r = await WatchHistory.deleteOne({ userId: req.user.id, videoId });
    return ok(res, { deleted: r.deletedCount });
  } catch (err) {
    console.error('deleteWatch error:', err);
    return fail(res, 'Delete failed', 500);
  }
};

// DELETE /api/activity/watch-history — clear everything
exports.clearWatch = async (req, res) => {
  try {
    const r = await WatchHistory.deleteMany({ userId: req.user.id });
    return ok(res, { deleted: r.deletedCount });
  } catch (err) {
    console.error('clearWatch error:', err);
    return fail(res, 'Clear failed', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// VIEWED PROFILES
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/activity/viewed-profiles
//   Body: { profileId }
// Skips self-views — we don't show "you viewed yourself".
exports.recordProfileView = async (req, res) => {
  try {
    const { profileId } = req.body;
    if (!isObjectId(profileId)) return fail(res, 'profileId is required');
    if (String(profileId) === String(req.user.id)) {
      // Silently no-op for self.
      return ok(res, { skipped: true });
    }

    await ViewedProfile.findOneAndUpdate(
      { viewerId: req.user.id, profileId },
      {
        $set: { viewedAt: new Date() },
        $setOnInsert: { viewerId: req.user.id, profileId },
      },
      { upsert: true, new: true },
    );
    return ok(res, { message: 'recorded' });
  } catch (err) {
    console.error('recordProfileView error:', err);
    return fail(res, 'Failed to record', 500);
  }
};

exports.listProfileViews = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);
    const filter = { viewerId: req.user.id };

    const [rows, total] = await Promise.all([
      ViewedProfile.find(filter)
        .sort({ viewedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('profileId', 'username fullName profileImage bio isVerified')
        .lean(),
      ViewedProfile.countDocuments(filter),
    ]);

    const items = rows
      .filter((r) => r.profileId)
      .map((r) => ({ _id: r._id, profile: r.profileId, viewedAt: r.viewedAt }));

    return ok(res, {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('listProfileViews error:', err);
    return fail(res, 'Failed to fetch viewed profiles', 500);
  }
};

exports.deleteProfileView = async (req, res) => {
  try {
    const { profileId } = req.params;
    if (!isObjectId(profileId)) return fail(res, 'invalid profileId');
    const r = await ViewedProfile.deleteOne({ viewerId: req.user.id, profileId });
    return ok(res, { deleted: r.deletedCount });
  } catch (err) {
    console.error('deleteProfileView error:', err);
    return fail(res, 'Delete failed', 500);
  }
};

exports.clearProfileViews = async (req, res) => {
  try {
    const r = await ViewedProfile.deleteMany({ viewerId: req.user.id });
    return ok(res, { deleted: r.deletedCount });
  } catch (err) {
    console.error('clearProfileViews error:', err);
    return fail(res, 'Clear failed', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SHARED VIDEOS
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/activity/shared-videos
//   Body: { videoId, platform? }
// NOT deduped — same video shared to two platforms = two rows.
exports.recordShare = async (req, res) => {
  try {
    const { videoId, platform = 'system_share' } = req.body;
    if (!isObjectId(videoId)) return fail(res, 'videoId is required');

    const row = await SharedVideo.create({
      userId:   req.user.id,
      videoId,
      platform: String(platform).slice(0, 40),
    });
    return ok(res, { id: row._id });
  } catch (err) {
    console.error('recordShare error:', err);
    return fail(res, 'Failed to record share', 500);
  }
};

exports.listShares = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);
    const filter = { userId: req.user.id };

    const [rows, total] = await Promise.all([
      SharedVideo.find(filter)
        .sort({ sharedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('videoId', 'title thumbnailUrl videoUrl duration userId category')
        .lean(),
      SharedVideo.countDocuments(filter),
    ]);

    const items = rows
      .filter((r) => r.videoId)
      .map((r) => ({
        _id:      r._id,
        video:    r.videoId,
        platform: r.platform,
        sharedAt: r.sharedAt,
      }));

    return ok(res, {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('listShares error:', err);
    return fail(res, 'Failed to fetch shared videos', 500);
  }
};

exports.deleteShare = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return fail(res, 'invalid id');
    const r = await SharedVideo.deleteOne({ _id: id, userId: req.user.id });
    return ok(res, { deleted: r.deletedCount });
  } catch (err) {
    console.error('deleteShare error:', err);
    return fail(res, 'Delete failed', 500);
  }
};

exports.clearShares = async (req, res) => {
  try {
    const r = await SharedVideo.deleteMany({ userId: req.user.id });
    return ok(res, { deleted: r.deletedCount });
  } catch (err) {
    console.error('clearShares error:', err);
    return fail(res, 'Clear failed', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SEARCH HISTORY
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/activity/search-history   Body: { query }
exports.recordSearch = async (req, res) => {
  try {
    const raw = String(req.body?.query || '').trim();
    if (!raw) return fail(res, 'query is required');
    const query = raw.toLowerCase().slice(0, 200);

    await SearchHistory.findOneAndUpdate(
      { userId: req.user.id, query },
      {
        $set: { searchedAt: new Date() },
        $setOnInsert: { userId: req.user.id, query },
      },
      { upsert: true, new: true },
    );
    return ok(res, { message: 'recorded' });
  } catch (err) {
    console.error('recordSearch error:', err);
    return fail(res, 'Failed to record search', 500);
  }
};

// GET /api/activity/search-history?limit=20 (no pagination — just a recent list)
exports.listSearches = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
    const items = await SearchHistory.find({ userId: req.user.id })
      .sort({ searchedAt: -1 })
      .limit(limit)
      .lean();
    return ok(res, { items });
  } catch (err) {
    console.error('listSearches error:', err);
    return fail(res, 'Failed to fetch search history', 500);
  }
};

// DELETE /api/activity/search-history/:id
exports.deleteSearch = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return fail(res, 'invalid id');
    const r = await SearchHistory.deleteOne({ _id: id, userId: req.user.id });
    return ok(res, { deleted: r.deletedCount });
  } catch (err) {
    console.error('deleteSearch error:', err);
    return fail(res, 'Delete failed', 500);
  }
};

exports.clearSearches = async (req, res) => {
  try {
    const r = await SearchHistory.deleteMany({ userId: req.user.id });
    return ok(res, { deleted: r.deletedCount });
  } catch (err) {
    console.error('clearSearches error:', err);
    return fail(res, 'Clear failed', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// CLEAR EVERYTHING
// ═════════════════════════════════════════════════════════════════════════════

// DELETE /api/activity/all — nuke every section in parallel.
// Does NOT touch likes/saves — those are video-level state, not history.
exports.clearAll = async (req, res) => {
  try {
    const uid = req.user.id;
    const [w, p, s, q] = await Promise.all([
      WatchHistory.deleteMany({ userId: uid }),
      ViewedProfile.deleteMany({ viewerId: uid }),
      SharedVideo.deleteMany({ userId: uid }),
      SearchHistory.deleteMany({ userId: uid }),
    ]);
    return ok(res, {
      deleted: {
        watchHistory:   w.deletedCount,
        viewedProfiles: p.deletedCount,
        sharedVideos:   s.deletedCount,
        searchHistory:  q.deletedCount,
      },
    });
  } catch (err) {
    console.error('clearAll error:', err);
    return fail(res, 'Clear-all failed', 500);
  }
};
