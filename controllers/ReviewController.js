// Backend/controllers/ReviewController.js
//
// Creator-facing side of the moderation system (all behind `protect`):
//   • GET  /api/videos/mine/moderation           — my queued/blocked uploads
//   • POST /api/videos/:videoId/review-request    — appeal a blocked upload
//
// The admin side lives in AdminController.

const mongoose          = require('mongoose');
const Video             = require('../models/Video');
const ReviewRequest     = require('../models/ReviewRequest');
const moderationService = require('../services/moderationService');
const { HIDDEN_REVIEW_STATES } = require('../services/moderationPolicy');

const ok   = (res, data, code = 200) => res.status(code).json({ success: true, ...data });
const fail = (res, message, code = 400) => res.status(code).json({ success: false, message });
const clip = (s, n) => String(s || '').trim().slice(0, n);
const isId = (s) => mongoose.Types.ObjectId.isValid(s);

// Videos eligible for an appeal.
const APPEALABLE = ['blocked', 'rejected', 'changes_requested'];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/videos/mine/moderation?status=
// My uploads that are in the moderation queue (not publicly live), each with
// its latest review ticket so the client can render the right block screen.
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyModeration = async (req, res) => {
  try {
    const status = req.query.status;
    const filter = { userId: req.user.id, status: { $ne: 'deleted' } };
    filter.reviewStatus = (status && HIDDEN_REVIEW_STATES.includes(status))
      ? status
      : { $in: HIDDEN_REVIEW_STATES };

    const videos = await Video.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    const ids = videos.map((v) => v._id);
    const tickets = await ReviewRequest.find({ video: { $in: ids }, creator: req.user.id })
      .sort({ createdAt: -1 }).lean();

    const latestByVideo = new Map();
    for (const t of tickets) {
      const k = String(t.video);
      if (!latestByVideo.has(k)) latestByVideo.set(k, t);
    }

    return ok(res, {
      videos: videos.map((v) => ({
        _id: v._id, title: v.title, thumbnailUrl: v.thumbnailUrl, videoUrl: v.videoUrl,
        duration: v.duration, createdAt: v.createdAt,
        reviewStatus: v.reviewStatus,
        review: v.review || null,
        aiCategory: v.aiCategory, informativeScore: v.informativeScore,
        reviewRequest: latestByVideo.get(String(v._id)) || null,
      })),
    });
  } catch (err) {
    console.error('getMyModeration error:', err);
    return fail(res, 'Failed to load your uploads', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/videos/:videoId/review-request
//   { reason, description, notes, links[] }
// Creates a Pending review ticket for a blocked/rejected upload.
// ─────────────────────────────────────────────────────────────────────────────
exports.submitReviewRequest = async (req, res) => {
  try {
    const { videoId } = req.params;
    if (!isId(videoId)) return fail(res, 'Invalid video id');

    const video = await Video.findById(videoId);
    if (!video) return fail(res, 'Video not found', 404);
    if (String(video.userId) !== String(req.user.id)) return fail(res, 'Not your video', 403);
    if (!APPEALABLE.includes(video.reviewStatus)) {
      return fail(res, 'This video is not eligible for a review request.');
    }

    // One open ticket at a time.
    const open = await ReviewRequest.findOne({ video: videoId, status: 'pending' }).lean();
    if (open) return ok(res, { reviewRequest: open, deduped: true });

    const links = Array.isArray(req.body.links)
      ? req.body.links.filter(Boolean).slice(0, 5).map((l) => String(l).slice(0, 2048))
      : [];

    const ticket = await ReviewRequest.create({
      video: videoId,
      creator: req.user.id,
      reason:      clip(req.body.reason, 200),
      description: clip(req.body.description, 2000),
      notes:       clip(req.body.notes, 2000),
      links,
      snapshot: {
        category:   video.review?.autoCategory || video.aiCategory || null,
        confidence: video.review?.confidence || 0,
        reason:     video.review?.reason || '',
      },
    });

    // Audit + confirmation to the creator. The video stays hidden; the admin
    // acts on the pending ticket.
    await moderationService.log({
      video, actorType: 'system', action: 'review_submitted',
      previousStatus: video.reviewStatus, newStatus: video.reviewStatus,
      note: clip(req.body.reason, 200),
    });
    await moderationService.notifyCreator(video, {
      event: 'review_submitted',
      title: 'Review requested',
      body:  'Your review request was submitted. We’ll notify you with the decision.',
    });

    return ok(res, { reviewRequest: ticket }, 201);
  } catch (err) {
    console.error('submitReviewRequest error:', err);
    return fail(res, 'Failed to submit review request', 500);
  }
};
