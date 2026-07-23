// Backend/controllers/SocialController.js
//
// SOCIAL GRAPH backend. Centralises:
//   • Public profile      — getUserProfile (relationship flags + privacy gates)
//   • Follow / unfollow   — followUser / unfollowUser (private accounts queue
//                           a follow request instead of following instantly)
//   • Follow requests     — listFollowRequests / accept / decline
//   • Connection lists    — listFollowers / listFollowing (privacy-gated)
//   • Blocking            — blockUser / unblockUser / listBlockedUsers
//
// Every privacy DECISION is delegated to services/privacy.js — the single
// source of truth. This controller never re-implements audience/visibility
// logic; it only orchestrates the graph writes around those decisions.
//
// All endpoints assume `req.user` is the FULL user doc set by `protect`
// (so my own followers/blockedUsers/followRequests are already in memory).

const mongoose = require('mongoose');
const User     = require('../models/User');
const Video    = require('../models/Video');
const Report   = require('../models/Report');
const cache    = require('../services/cache');
const privacy  = require('../services/privacy');

// ── Helpers ──────────────────────────────────────────────────────────────────
const ok   = (res, data, statusCode = 200) =>
  res.status(statusCode).json({ success: true,  ...data });
const fail = (res, message, statusCode = 400) =>
  res.status(statusCode).json({ success: false, message });

const isObjectId = (s) => mongoose.Types.ObjectId.isValid(s);

// Parse + clamp page/limit query params consistently across endpoints.
const pageParams = (req, maxLimit = 50) => {
  const page  = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

// The same public "user card" everywhere a user appears inside a list.
const USER_CARD_FIELDS = 'fullName username profileImage isVerified bio';

// ── Social push notifications ────────────────────────────────────────────────
// Fire-and-forget: never blocks or fails the request that triggered it.
// Respects the recipient's notifications.newFollowers preference (default on).
const SOCIAL_PUSH_COPY = {
  follow:           (actor) => `@${actor} started following you`,
  follow_request:   (actor) => `@${actor} requested to follow you`,
  request_accepted: (actor) => `@${actor} accepted your follow request`,
};

// Routed through notificationCenter (NOT pushService directly) so follows get
// the same treatment as likes/comments/mentions: preference gate, an in-app
// Notification history row, and a correct unread badge. Critically, the
// history row is written even when no push provider is configured — the event
// must never vanish just because the device has no push token.
const notifySocial = (recipientId, kind, actor) => {
  const build = SOCIAL_PUSH_COPY[kind];
  if (!build) return;
  const notificationCenter = require('../services/notificationCenter');
  notificationCenter.notify(recipientId, 'newFollowers', {
    title: 'TrueVision',
    body:  build(actor?.username || 'Someone'),
    fromUserId: actor?._id || actor?.id || null,
    // `type` carries the specific action so a tapped push/history row can
    // route correctly (follow vs request vs accepted).
    data: { type: kind, fromUserId: String(actor?._id || actor?.id || '') },
  }).catch((e) => console.warn('[social] notify failed:', e.message));
};

// Central cache invalidator — mirrors UserController.invalidateUserCache.
// The updateOne() calls below bypass the model's post-save hook, so every
// write site drops the affected users' `user:byId:` entries explicitly.
const invalidateUserCache = (...userIds) =>
  Promise.all(
    userIds
      .filter(Boolean)
      .map((id) => cache.del(`user:byId:${id}`).catch(() => {})),
  );

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC PROFILE
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/users/:userId/profile
// Profile card + relationship flags for the profile screen. "They blocked me"
// is deliberately indistinguishable from "no such user" (404) so blocking is
// never revealed to the blocked party.
exports.getUserProfile = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return fail(res, 'Invalid user id');

    const viewerId = String(req.user.id);
    const target = await User.findById(userId).select(
      'fullName username bio profileImage coverImage isVerified createdAt ' +
      'followers following followRequests blockedUsers preferences isOnline lastSeen',
    );

    const blockedMe =
      target && (target.blockedUsers || []).some((b) => String(b) === viewerId);
    if (!target || blockedMe) return fail(res, 'User not found', 404);

    const targetId = String(target._id);
    const p        = privacy.getPrivacy(target);

    // Only videos the app would actually show count toward the total — exclude
    // moderation-queued / blocked uploads so the count matches the visible grid.
    const { PUBLIC_REVIEW_FILTER } = require('../services/moderationPolicy');
    const totalVideos = await Video.countDocuments({
      userId:     target._id,
      status:     'active',
      isArchived: { $ne: true },
      ...PUBLIC_REVIEW_FILTER,
    });

    // Relationship flags (viewer ↔ target).
    const isFollowing   = privacy.isFollower(viewerId, target);
    const isRequested   = (target.followRequests || []).some((r) => String(r.from) === viewerId);
    const followsMe     = (target.following || []).some((f) => String(f) === viewerId);
    const isBlockedByMe = (req.user.blockedUsers || []).some((b) => String(b) === targetId);

    // Content gate: privacy policy AND my own block both hide their videos.
    const canViewContent = privacy.canViewContentOf(viewerId, target) && !isBlockedByMe;

    // Presence honours hideOnlineStatus — applyPresencePolicy nulls the fields.
    const presented = privacy.applyPresencePolicy(target, viewerId);

    return ok(res, {
      user: {
        _id:            target._id,
        fullName:       target.fullName,
        username:       target.username,
        bio:            target.bio || '',
        profileImage:   target.profileImage || null,
        coverImage:     target.coverImage || null,
        isVerified:     target.isVerified,
        createdAt:      target.createdAt,
        followersCount: target.followers?.length || 0,
        followingCount: target.following?.length || 0,
        totalVideos,
        privateAccount: p.privateAccount,
        hideFollowers:  p.hideFollowers,
        isFollowing,
        isRequested,
        followsMe,
        isBlockedByMe,
        isOnline:       presented.isOnline === true,
        lastSeen:       presented.lastSeen ?? null,
        canViewContent,
      },
    });
  } catch (err) {
    console.error('getUserProfile error:', err);
    return fail(res, 'Failed to fetch profile', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// FOLLOW / UNFOLLOW
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/users/:userId/follow
// Public account → instant follow. Private account → queue a follow request.
// Idempotent: repeat taps return the current status instead of erroring.
exports.followUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const me = String(req.user.id);
    if (!isObjectId(userId)) return fail(res, 'Invalid user id');
    if (userId === me)       return fail(res, "You can't follow yourself");

    const target = await User.findById(userId).select('followers followRequests preferences blockedUsers');
    if (!target) return fail(res, 'User not found', 404);

    // Block handling is direction-aware: if THEY blocked me the response is
    // indistinguishable from a missing account, so the block is never
    // revealed. If I blocked them, say so — that's my own state.
    if ((target.blockedUsers || []).some((b) => String(b) === me)) {
      return fail(res, 'User not found', 404);
    }
    if ((req.user.blockedUsers || []).some((b) => String(b) === String(target._id))) {
      return fail(res, 'Unblock this user to follow them.', 403);
    }

    // Already related → report the existing state.
    if (privacy.isFollower(me, target)) return ok(res, { status: 'following' });
    if ((target.followRequests || []).some((r) => String(r.from) === me)) {
      return ok(res, { status: 'requested' });
    }

    if (privacy.getPrivacy(target).privateAccount) {
      // Private account → queue a request. The `$ne` filter makes the push
      // race-safe: two concurrent taps can never create duplicate entries.
      await User.updateOne(
        { _id: target._id, 'followRequests.from': { $ne: me } },
        { $push: { followRequests: { from: me } } },
      );
      await invalidateUserCache(me, userId);
      notifySocial(target._id, 'follow_request', req.user);
      return ok(res, { status: 'requested' });
    }

    // Public account → instant follow, both directions of the edge.
    await Promise.all([
      User.updateOne({ _id: target._id }, { $addToSet: { followers: me } }),
      User.updateOne({ _id: me },         { $addToSet: { following: target._id } }),
    ]);
    await invalidateUserCache(me, userId);
    notifySocial(target._id, 'follow', req.user);
    return ok(res, { status: 'following' });
  } catch (err) {
    console.error('followUser error:', err);
    return fail(res, 'Failed to follow user', 500);
  }
};

// DELETE /api/users/:userId/follow
// Removes the follow edge in both directions AND any pending request, so
// "unfollow" doubles as "cancel follow request". Idempotent by design.
exports.unfollowUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const me = String(req.user.id);
    if (!isObjectId(userId)) return fail(res, 'Invalid user id');

    await Promise.all([
      User.updateOne(
        { _id: userId },
        { $pull: { followers: me, followRequests: { from: me } } },
      ),
      User.updateOne({ _id: me }, { $pull: { following: userId } }),
    ]);
    await invalidateUserCache(me, userId);
    return ok(res, { status: 'none' });
  } catch (err) {
    console.error('unfollowUser error:', err);
    return fail(res, 'Failed to unfollow user', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// FOLLOW REQUESTS (private accounts)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/users/follow-requests?page&limit
// My pending incoming requests, newest first. `protect` already loaded the
// full doc, so the requests array is in memory — we page over it and only
// hit Mongo for the requester cards.
exports.listFollowRequests = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);

    const requests = [...(req.user.followRequests || [])]
      .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));

    const total    = requests.length;
    const pageRows = requests.slice(skip, skip + limit);
    const pageIds  = pageRows.map((r) => r.from);

    const users = await User.find({ _id: { $in: pageIds } })
      .select(USER_CARD_FIELDS)
      .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    // Preserve requestedAt-desc order; drop entries whose account is gone.
    const items = pageRows
      .map((r) => ({ user: byId.get(String(r.from)) || null, requestedAt: r.requestedAt }))
      .filter((r) => r.user);

    return ok(res, {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('listFollowRequests error:', err);
    return fail(res, 'Failed to fetch follow requests', 500);
  }
};

// POST /api/users/follow-requests/:requesterId/accept
// Consume the request + gain the follower in ONE atomic write on my doc,
// then mirror the edge onto the requester's `following`.
exports.acceptFollowRequest = async (req, res) => {
  try {
    const { requesterId } = req.params;
    const me = String(req.user.id);
    if (!isObjectId(requesterId)) return fail(res, 'Invalid user id');

    // Conditional consume: the filter only matches while the request still
    // exists, so two concurrent accepts (or accept-after-decline) can't both
    // succeed — the loser sees modifiedCount 0 and 404s.
    const r = await User.updateOne(
      { _id: me, 'followRequests.from': requesterId },
      {
        $pull:     { followRequests: { from: requesterId } },
        $addToSet: { followers: requesterId },
      },
    );
    if (r.modifiedCount !== 1) return fail(res, 'Follow request not found', 404);

    await User.updateOne({ _id: requesterId }, { $addToSet: { following: me } });
    await invalidateUserCache(me, requesterId);
    notifySocial(requesterId, 'request_accepted', req.user);
    return ok(res, {});
  } catch (err) {
    console.error('acceptFollowRequest error:', err);
    return fail(res, 'Failed to accept follow request', 500);
  }
};

// POST /api/users/follow-requests/:requesterId/decline
// $pull only — declining a request that is already gone is a silent success.
exports.declineFollowRequest = async (req, res) => {
  try {
    const { requesterId } = req.params;
    const me = String(req.user.id);
    if (!isObjectId(requesterId)) return fail(res, 'Invalid user id');

    await User.updateOne(
      { _id: me },
      { $pull: { followRequests: { from: requesterId } } },
    );
    await invalidateUserCache(me);
    return ok(res, {});
  } catch (err) {
    console.error('declineFollowRequest error:', err);
    return fail(res, 'Failed to decline follow request', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// FOLLOWERS / FOLLOWING LISTS
// ═════════════════════════════════════════════════════════════════════════════

// Shared implementation — the two lists differ only by which id array we
// page over. Gates are applied in strict order (owner always allowed):
//   1) blocked either direction  → 404 (indistinguishable from not-found)
//   2) private + not a follower  → 403 ACCOUNT_PRIVATE
//   3) hideFollowers             → 403 FOLLOWERS_PRIVATE (gates BOTH lists)
const listConnections = async (req, res, field) => {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return fail(res, 'Invalid user id');

    const viewerId = String(req.user.id);
    const target = await User.findById(userId)
      .select('followers following blockedUsers preferences')
      .lean();
    if (!target) return fail(res, 'User not found', 404);

    const isOwner = viewerId === String(target._id);
    if (!isOwner) {
      const blocked =
        (target.blockedUsers || []).some((b) => String(b) === viewerId) ||
        (req.user.blockedUsers || []).some((b) => String(b) === String(target._id));
      if (blocked) return fail(res, 'User not found', 404);

      const p = privacy.getPrivacy(target);

      if (p.privateAccount && !privacy.isFollower(viewerId, target)) {
        return res.status(403).json({
          success: false,
          code:    'ACCOUNT_PRIVATE',
          message: 'This account is private.',
        });
      }

      // "Hide Followers List" hides BOTH lists from everyone but the owner.
      if (p.hideFollowers) {
        return res.status(403).json({
          success: false,
          code:    'FOLLOWERS_PRIVATE',
          message: 'Followers list is private.',
        });
      }
    }

    const { page, limit, skip } = pageParams(req);
    const idArray = target[field] || [];
    const total   = idArray.length;
    const pageIds = idArray.slice(skip, skip + limit);

    const users = await User.find({ _id: { $in: pageIds } })
      .select(USER_CARD_FIELDS)
      .lean();
    const byId  = new Map(users.map((u) => [String(u._id), u]));
    // Preserve array order; drop ids whose account was deleted.
    const items = pageIds.map((id) => byId.get(String(id))).filter(Boolean);

    return ok(res, {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error(`list ${field} error:`, err);
    return fail(res, `Failed to fetch ${field}`, 500);
  }
};

// GET /api/users/:userId/followers?page&limit
exports.listFollowers = (req, res) => listConnections(req, res, 'followers');

// GET /api/users/:userId/following?page&limit
exports.listFollowing = (req, res) => listConnections(req, res, 'following');

// ═════════════════════════════════════════════════════════════════════════════
// BLOCKING
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/users/:userId/block
// Block + cascade: sever follow edges AND pending requests in BOTH
// directions so no stale relationship survives the block.
exports.blockUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const me = String(req.user.id);
    if (!isObjectId(userId)) return fail(res, 'Invalid user id');
    if (userId === me)       return fail(res, "You can't block yourself");

    const exists = await User.exists({ _id: userId });
    if (!exists) return fail(res, 'User not found', 404);

    await Promise.all([
      User.updateOne(
        { _id: me },
        {
          $addToSet: { blockedUsers: userId },
          $pull: {
            followers:      userId,
            following:      userId,
            followRequests: { from: userId },
          },
        },
      ),
      User.updateOne(
        { _id: userId },
        {
          $pull: {
            followers:      me,
            following:      me,
            followRequests: { from: me },
          },
        },
      ),
    ]);
    await invalidateUserCache(me, userId);
    return ok(res, {});
  } catch (err) {
    console.error('blockUser error:', err);
    return fail(res, 'Failed to block user', 500);
  }
};

// POST /api/users/:userId/report — file a moderation report against a user.
// Body: { reason, details?, context?, chatId? }. Idempotent-ish: a second
// report while an earlier one is still open (pending/reviewing) is accepted
// silently without creating a duplicate row.
const REPORT_REASONS = ['spam', 'harassment', 'fake', 'inappropriate', 'other'];
exports.reportUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const me = String(req.user.id);
    const { reason, details, context, chatId } = req.body || {};

    if (!isObjectId(userId))         return fail(res, 'Invalid user id');
    if (userId === me)               return fail(res, "You can't report yourself");
    if (!REPORT_REASONS.includes(reason)) return fail(res, 'Invalid report reason');

    const exists = await User.exists({ _id: userId });
    if (!exists) return fail(res, 'User not found', 404);

    // Collapse duplicate open reports from the same reporter.
    const open = await Report.findOne({
      reporter: me, reportedUser: userId, status: { $in: ['pending', 'reviewing'] },
    }).select('_id').lean();
    if (open) return ok(res, { reportId: open._id, deduped: true });

    const report = await Report.create({
      reporter:     me,
      reportedUser: userId,
      reason,
      details:      typeof details === 'string' ? details.slice(0, 1000) : '',
      context:      ['chat', 'profile', 'comment', 'video', 'other'].includes(context) ? context : 'chat',
      chatId:       isObjectId(chatId) ? chatId : null,
    });
    return ok(res, { reportId: report._id }, 201);
  } catch (err) {
    console.error('reportUser error:', err);
    return fail(res, 'Failed to submit report', 500);
  }
};

// DELETE /api/users/:userId/block — idempotent unblock ($pull no-ops if absent).
exports.unblockUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const me = String(req.user.id);
    if (!isObjectId(userId)) return fail(res, 'Invalid user id');

    await User.updateOne({ _id: me }, { $pull: { blockedUsers: userId } });
    await invalidateUserCache(me);
    return ok(res, {});
  } catch (err) {
    console.error('unblockUser error:', err);
    return fail(res, 'Failed to unblock user', 500);
  }
};

// GET /api/users/blocked?page&limit&q
// My blocked-users list, optionally filtered by name/username. Paginates in
// Mongo (skip/limit + count) since the filter can shrink the result set.
exports.listBlockedUsers = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);
    const q = (req.query.q || '').trim();

    const ids = req.user.blockedUsers || [];
    const filter = { _id: { $in: ids } };
    if (q.length > 0) {
      // Escape regex metacharacters so a username with "." or "*" doesn't blow up
      const safe  = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safe, 'i');
      filter.$or = [{ username: regex }, { fullName: regex }];
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .select(USER_CARD_FIELDS)
        .sort({ username: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return ok(res, {
      items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('listBlockedUsers error:', err);
    return fail(res, 'Failed to fetch blocked users', 500);
  }
};
