// Backend/services/moderationService.js
//
// The engine that APPLIES a moderation outcome to a video — used by BOTH the AI
// pipeline (runContentAnalysis) and the admin panel. It centralises the three
// side-effects every decision must have, so they can never drift apart:
//   1. set the video's reviewStatus + review meta
//   2. append an immutable ModerationLog (audit trail)
//   3. notify the creator (and, on publish, their followers)

const Video              = require('../models/Video');
const User               = require('../models/User');
const ModerationLog      = require('../models/ModerationLog');
const notificationCenter = require('./notificationCenter');
const feedCache          = require('./feedCache');

const clip = (s, n) => String(s || '').slice(0, n);

// ── Notifications ────────────────────────────────────────────────────────────
// Moderation notices ride the 'appUpdates' channel (default-on, in-app history
// + push). data.type='moderation' lets the client deep-link to the upload.
async function notifyCreator(video, { title, body, event }) {
  try {
    await notificationCenter.notify(video.userId, 'appUpdates', {
      title,
      body,
      data: { type: 'moderation', event, videoId: String(video._id), reviewStatus: video.reviewStatus },
    });
  } catch (_) { /* best-effort */ }
}

async function notifyFollowersNewVideo(video) {
  try {
    const creator = await User.findById(video.userId).select('followers username').lean();
    const followers = (creator?.followers || []).map(String);
    if (!followers.length) return;
    await notificationCenter.notifyMany(
      followers,
      'appUpdates',
      () => ({
        title: `@${creator.username} posted a new video`,
        body:  video.title ? `"${clip(video.title, 80)}"` : '',
        data:  { type: 'newVideo', videoId: String(video._id), creatorId: String(video.userId) },
      }),
      { fromUserId: video.userId },
    );
  } catch (_) { /* best-effort */ }
}

// ── Audit log ────────────────────────────────────────────────────────────────
function log({ video, actorType, admin = null, adminName = '', action, previousStatus, newStatus, reason = '', note = '', meta = {} }) {
  return ModerationLog.create({
    video: video._id, creator: video.userId,
    actorType, admin, adminName,
    action, previousStatus, newStatus, reason, note, meta,
  }).catch((e) => console.warn('[moderation] log failed:', e.message));
}

// ── AI auto-decision ─────────────────────────────────────────────────────────
// Mutates the video doc with the verdict. Caller persists it (video.save()).
function applyVerdictToDoc(video, verdict) {
  video.reviewStatus = verdict.decision; // approved | blocked | pending_review
  video.review = {
    ...(video.review ? (video.review.toObject ? video.review.toObject() : video.review) : {}),
    autoCategory: verdict.category,
    confidence:   verdict.confidence,
    decision:     verdict.decision,
    reason:       verdict.reason,
    decidedBy:    'ai',
    decidedByAdmin: null,
    decidedAt:    new Date(),
    queuedAt:     video.review?.queuedAt || new Date(),
  };
  return video;
}

// Record + notify AFTER the doc was saved with the verdict.
async function recordAutoDecision(video, verdict) {
  const actionByDecision = {
    approved:       'auto_approved',
    blocked:        'auto_blocked',
    pending_review: 'auto_pending',
  };
  await log({
    video, actorType: 'ai',
    action: actionByDecision[verdict.decision] || 'auto_pending',
    previousStatus: 'processing', newStatus: verdict.decision,
    reason: verdict.reason,
    meta: { category: verdict.category, confidence: verdict.confidence, level: verdict.level },
  });

  if (verdict.decision === 'approved') {
    await notifyCreator(video, {
      event: 'approved',
      title: 'Your video is live 🎉',
      body:  video.title ? `"${clip(video.title, 80)}" was approved and published.` : 'Your video was approved and published.',
    });
    await notifyFollowersNewVideo(video);
  } else if (verdict.decision === 'blocked') {
    await notifyCreator(video, {
      event: 'blocked',
      title: 'Upload blocked',
      body:  'Your video was classified as entertainment content. Open it to request a review.',
    });
  } else {
    await notifyCreator(video, {
      event: 'pending',
      title: 'Video under review',
      body:  'Your video is being reviewed and will be published if it fits TrueVision.',
    });
  }
}

// ── Admin decision ───────────────────────────────────────────────────────────
// action ∈ approve | reject | request_changes | delete | warn | suspend
async function applyAdminDecision({ video, admin, action, note = '', reason = '' }) {
  const prev = video.reviewStatus;
  const stamp = (status) => {
    video.reviewStatus = status;
    video.review = {
      ...(video.review ? (video.review.toObject ? video.review.toObject() : video.review) : {}),
      decision: status, decidedBy: 'admin',
      decidedByAdmin: admin._id, decidedAt: new Date(),
      adminNote: note || video.review?.adminNote || '',
    };
  };

  let logAction = action;
  switch (action) {
    case 'approve':
      stamp('approved');
      await video.save();
      await notifyCreator(video, { event: 'approved', title: 'Your video was approved 🎉', body: 'A reviewer approved your video. It is now public.' });
      await notifyFollowersNewVideo(video);
      logAction = 'approved';
      break;

    case 'reject':
      stamp('rejected');
      await video.save();
      await notifyCreator(video, { event: 'rejected', title: 'Video not approved', body: note ? clip(note, 200) : 'Your video does not fit TrueVision’s content guidelines.' });
      logAction = 'rejected';
      break;

    case 'request_changes':
      stamp('changes_requested');
      await video.save();
      await notifyCreator(video, { event: 'changes_requested', title: 'Changes requested', body: note ? clip(note, 200) : 'A reviewer requested changes. You may upload an improved version.' });
      logAction = 'request_changes';
      break;

    case 'delete':
      video.status = 'deleted';
      await video.save();
      await notifyCreator(video, { event: 'deleted', title: 'Video removed', body: note ? clip(note, 200) : 'Your video was removed by a moderator.' });
      logAction = 'deleted';
      break;

    case 'warn':
      await notifyCreator(video, { event: 'warned', title: 'Content warning', body: note ? clip(note, 200) : 'A moderator issued a warning about your recent upload.' });
      logAction = 'warned';
      break;

    case 'suspend':
      await User.updateOne({ _id: video.userId }, { $set: { isSuspended: true, suspendedAt: new Date() } }).catch(() => {});
      await notifyCreator(video, { event: 'suspended', title: 'Account suspended', body: note ? clip(note, 200) : 'Your account has been suspended pending review.' });
      logAction = 'suspended';
      break;

    default:
      throw new Error(`Unknown admin action: ${action}`);
  }

  await log({
    video, actorType: 'admin', admin: admin._id, adminName: admin.username,
    action: logAction, previousStatus: prev, newStatus: video.reviewStatus,
    reason, note,
  });

  // Any admin action that changes public visibility (approve → visible,
  // reject/delete → hidden) must refresh every cached feed so the change shows
  // on the next fetch instead of after the TTL.
  if (prev !== video.reviewStatus || video.status === 'deleted') {
    feedCache.invalidatePublicFeeds();
    console.log(`[feed] admin ${logAction} video=${video._id} (${prev} → ${video.reviewStatus}) → feeds invalidated`);
  }

  return video;
}

module.exports = {
  applyVerdictToDoc,
  recordAutoDecision,
  applyAdminDecision,
  notifyCreator,
  log,
};
