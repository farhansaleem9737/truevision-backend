// Backend/controllers/AdminController.js
//
// Moderation-panel backend. Every route here is behind requireAdmin (see
// AdminRoutes). Read endpoints paginate + filter server-side; write endpoints
// route through services/moderationService so the video status, audit log and
// creator notifications always stay in lockstep.

const mongoose      = require('mongoose');
const Video         = require('../models/Video');
const User          = require('../models/User');
const ReviewRequest = require('../models/ReviewRequest');
const ModerationLog = require('../models/ModerationLog');
const AdminUser     = require('../models/AdminUser');
const moderationService = require('../services/moderationService');
const { signAdminToken } = require('../middleware/adminAuth');

const ok   = (res, data, code = 200) => res.status(code).json({ success: true, ...data });
const fail = (res, message, code = 400) => res.status(code).json({ success: false, message });

const pageParams = (req) => {
  const page  = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

const isId = (s) => mongoose.Types.ObjectId.isValid(s);

// Compact video shape for lists + detail.
const shapeVideo = (v) => ({
  _id:          v._id,
  title:        v.title,
  description:  v.description,
  thumbnailUrl: v.thumbnailUrl,
  videoUrl:     v.videoUrl,
  duration:     v.duration,
  category:     v.category,
  createdAt:    v.createdAt,
  status:       v.status,
  reviewStatus: v.reviewStatus,
  aiCategory:   v.aiCategory,
  informativeScore: v.informativeScore,
  review:       v.review || null,
  moderation:   v.moderation || null,   // NSFW verdict
  transcription: v.transcription ? {
    category: v.transcription.category, confidence: v.transcription.confidence,
    moderation: v.transcription.moderation, status: v.transcription.status,
    language: v.transcription.language,
  } : null,
  creator: v.userId && v.userId._id ? {
    _id: v.userId._id, username: v.userId.username, fullName: v.userId.fullName,
    profileImage: v.userId.profileImage, isSuspended: v.userId.isSuspended,
  } : v.userId,
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/login   { username, password, remember }
// ─────────────────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const remember = !!req.body.remember;
    if (!username || !password) return fail(res, 'Username and password are required');

    const admin = await AdminUser.findOne({ username });
    // Constant-ish response — don't reveal whether the username exists.
    if (!admin || !admin.active || !(await admin.verifyPassword(password))) {
      return fail(res, 'Invalid credentials', 401);
    }

    admin.lastLoginAt = new Date();
    await admin.save();

    return ok(res, { token: signAdminToken(admin, { remember }), admin: admin.toSafeJSON() });
  } catch (err) {
    console.error('admin.login error:', err);
    return fail(res, 'Login failed', 500);
  }
};

// GET /api/admin/me
exports.me = async (req, res) => ok(res, { admin: req.admin.toSafeJSON() });

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/stats   — dashboard counters
// ─────────────────────────────────────────────────────────────────────────────
exports.stats = async (req, res) => {
  try {
    const [
      pendingTickets, approvedTickets, rejectedTickets, changesTickets,
      blocked, pendingReview, processing, approved, totalVideos, suspendedCreators,
    ] = await Promise.all([
      ReviewRequest.countDocuments({ status: 'pending' }),
      ReviewRequest.countDocuments({ status: 'approved' }),
      ReviewRequest.countDocuments({ status: 'rejected' }),
      ReviewRequest.countDocuments({ status: 'changes_requested' }),
      Video.countDocuments({ reviewStatus: 'blocked' }),
      Video.countDocuments({ reviewStatus: 'pending_review' }),
      Video.countDocuments({ reviewStatus: 'processing' }),
      Video.countDocuments({ reviewStatus: 'approved' }),
      Video.countDocuments({}),
      User.countDocuments({ isSuspended: true }),
    ]);

    return ok(res, {
      stats: {
        reviews:  { pending: pendingTickets, approved: approvedTickets, rejected: rejectedTickets, changesRequested: changesTickets },
        uploads:  { blocked, pendingReview, processing, approved, total: totalVideos },
        creators: { suspended: suspendedCreators },
      },
    });
  } catch (err) {
    console.error('admin.stats error:', err);
    return fail(res, 'Failed to load stats', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/videos?status=blocked|pending_review|processing|approved|all
//                        &q=&page=&limit=&sort=new|old
// ─────────────────────────────────────────────────────────────────────────────
exports.listVideos = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);
    const status = String(req.query.status || 'blocked');
    const q      = String(req.query.q || '').trim();
    const sort   = req.query.sort === 'old' ? 1 : -1;

    const filter = {};
    if (status !== 'all') filter.reviewStatus = status;

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      // Match title/description OR a creator whose username/name matches.
      const creators = await User.find({ $or: [{ username: rx }, { fullName: rx }] }).select('_id').limit(50).lean();
      filter.$or = [{ title: rx }, { description: rx }, { userId: { $in: creators.map((c) => c._id) } }];
    }

    const [rows, total] = await Promise.all([
      Video.find(filter)
        .sort({ createdAt: sort })
        .skip(skip).limit(limit)
        .populate('userId', 'username fullName profileImage isSuspended')
        .lean(),
      Video.countDocuments(filter),
    ]);

    return ok(res, {
      videos: rows.map(shapeVideo),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('admin.listVideos error:', err);
    return fail(res, 'Failed to load videos', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/reviews?status=pending|approved|rejected|changes_requested|all
//                        &q=&page=&limit=
// ─────────────────────────────────────────────────────────────────────────────
exports.listReviews = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);
    const status = String(req.query.status || 'pending');
    const q      = String(req.query.q || '').trim();

    const filter = {};
    if (status !== 'all') filter.status = status;
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const creators = await User.find({ $or: [{ username: rx }, { fullName: rx }] }).select('_id').limit(50).lean();
      filter.$or = [{ reason: rx }, { description: rx }, { creator: { $in: creators.map((c) => c._id) } }];
    }

    const [rows, total] = await Promise.all([
      ReviewRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip).limit(limit)
        .populate('creator', 'username fullName profileImage')
        .populate({ path: 'video', select: 'title thumbnailUrl videoUrl reviewStatus aiCategory informativeScore review duration createdAt' })
        .lean(),
      ReviewRequest.countDocuments(filter),
    ]);

    return ok(res, {
      reviews: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('admin.listReviews error:', err);
    return fail(res, 'Failed to load reviews', 500);
  }
};

// GET /api/admin/videos/:videoId  — full moderation detail + history + ticket
exports.videoDetail = async (req, res) => {
  try {
    const { videoId } = req.params;
    if (!isId(videoId)) return fail(res, 'Invalid video id');

    const video = await Video.findById(videoId)
      .populate('userId', 'username fullName profileImage isSuspended followersCount createdAt')
      .lean();
    if (!video) return fail(res, 'Video not found', 404);

    const [logs, ticket] = await Promise.all([
      ModerationLog.find({ video: videoId }).sort({ createdAt: -1 }).limit(50).lean(),
      ReviewRequest.findOne({ video: videoId }).sort({ createdAt: -1 }).lean(),
    ]);

    return ok(res, { video: shapeVideo(video), logs, reviewRequest: ticket || null });
  } catch (err) {
    console.error('admin.videoDetail error:', err);
    return fail(res, 'Failed to load detail', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/videos/:videoId/action
//   { action: approve|reject|request_changes|delete|warn|suspend, note? }
// ─────────────────────────────────────────────────────────────────────────────
const ACTION_TO_TICKET = {
  approve: 'approved', reject: 'rejected', request_changes: 'changes_requested', delete: 'rejected',
};
exports.action = async (req, res) => {
  try {
    const { videoId } = req.params;
    const action = String(req.body.action || '');
    const note   = String(req.body.note || '').slice(0, 2000);
    if (!isId(videoId)) return fail(res, 'Invalid video id');
    if (!['approve', 'reject', 'request_changes', 'delete', 'warn', 'suspend'].includes(action)) {
      return fail(res, 'Invalid action');
    }

    const video = await Video.findById(videoId);
    if (!video) return fail(res, 'Video not found', 404);

    await moderationService.applyAdminDecision({ video, admin: req.admin, action, note });

    // Resolve an open review ticket to match the decisive action.
    const ticketStatus = ACTION_TO_TICKET[action];
    if (ticketStatus) {
      await ReviewRequest.updateMany(
        { video: videoId, status: 'pending' },
        { $set: { status: ticketStatus, adminNote: note, reviewedBy: req.admin._id, reviewedAt: new Date() } },
      ).catch(() => {});
    }

    return ok(res, { videoId, action, reviewStatus: video.reviewStatus });
  } catch (err) {
    console.error('admin.action error:', err);
    return fail(res, err.message || 'Action failed', 500);
  }
};

// GET /api/admin/audit?page=&limit=&videoId=
exports.auditLog = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);
    const filter = {};
    if (req.query.videoId && isId(req.query.videoId)) filter.video = req.query.videoId;

    const [rows, total] = await Promise.all([
      ModerationLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip).limit(limit)
        .populate('creator', 'username')
        .lean(),
      ModerationLog.countDocuments(filter),
    ]);

    return ok(res, { logs: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('admin.auditLog error:', err);
    return fail(res, 'Failed to load audit log', 500);
  }
};
