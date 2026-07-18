// Backend/controllers/CommentController.js
const Comment = require('../models/Comment');
const Video   = require('../models/Video');
const User    = require('../models/User');
const privacy = require('../services/privacy');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const ok   = (res, data, statusCode = 200) => res.status(statusCode).json({ success: true,  ...data });
const fail = (res, message, statusCode = 400) => res.status(statusCode).json({ success: false, message });

// Privacy gate shared by addComment + addReply. Checks, in order:
//   1. the owner's whoCanComment policy (+ blocks, via privacy.canComment);
//   2. account-level privacy — a private account only accepts comments from
//      approved followers, regardless of whoCanComment.
// Returns null when allowed, otherwise the 403 body to send.
const commentGate = async (actorId, ownerUserId) => {
  const owner = await User.findById(ownerUserId)
    .select('followers following preferences blockedUsers')
    .lean();

  const verdict = await privacy.canComment(actorId, owner);
  if (!verdict.allowed) {
    return { success: false, code: verdict.code, message: verdict.message };
  }
  if (!privacy.canViewContentOf(actorId, owner)) {
    return { success: false, code: 'ACCOUNT_PRIVATE', message: 'This account is private.' };
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET COMMENTS FOR A VIDEO
// GET /api/videos/:id/comments?page=1&limit=20&sort=top|new
// ─────────────────────────────────────────────────────────────────────────────
exports.getComments = async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const skip  = (page - 1) * limit;
    const sort  = req.query.sort === 'top'
      ? { isPinned: -1, likesCount: -1 }
      : { isPinned: -1, createdAt:  -1 };

    // Read-side privacy: comments are only as visible as the video itself.
    const video = await Video.findById(req.params.id)
      .select('userId status visibility isArchived')
      .lean();
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const viewerIsOwner = String(req.user?.id || '') === String(video.userId);
    if (!viewerIsOwner) {
      if (video.isArchived) return fail(res, 'Video not found', 404);
      if (req.user?.id && await privacy.isBlockedBetween(req.user.id, video.userId)) {
        return fail(res, 'Video not found', 404);
      }
      if (video.visibility === 'private') {
        return res.status(403).json({ success: false, code: 'VIDEO_PRIVATE', message: 'This video is private.' });
      }
      const owner = await User.findById(video.userId).select('followers preferences').lean();
      if (video.visibility === 'followers' && !privacy.isFollower(req.user?.id || null, owner)) {
        return res.status(403).json({ success: false, code: 'VIDEO_PRIVATE', message: 'This video is only visible to followers.' });
      }
      if (!privacy.canViewContentOf(req.user?.id || null, owner)) {
        return res.status(403).json({ success: false, code: 'ACCOUNT_PRIVATE', message: 'This account is private.' });
      }
    }

    const filter = { videoId: req.params.id, isHidden: false };

    const [comments, total] = await Promise.all([
      Comment.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('userId',          'username fullName profileImage')
        .populate('replies.userId',  'username fullName profileImage')
        .lean(),
      Comment.countDocuments(filter),
    ]);

    return ok(res, {
      comments,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getComments error:', err);
    return fail(res, 'Failed to fetch comments', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADD COMMENT
// POST /api/videos/:id/comments
// Body: { text }
// ─────────────────────────────────────────────────────────────────────────────
exports.addComment = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.allowComments) return fail(res, 'Comments are disabled for this video', 403);

    // Privacy: owner's whoCanComment policy + blocks + private-account gate.
    const denied = await commentGate(req.user.id, video.userId);
    if (denied) return res.status(403).json(denied);

    const { text } = req.body;
    if (!text?.trim()) return fail(res, 'Comment text is required');

    const comment = await Comment.create({
      videoId: req.params.id,
      userId:  req.user.id,
      text:    text.trim(),
    });

    // Increment video comment counter
    await Video.findByIdAndUpdate(req.params.id, { $inc: { commentsCount: 1 } });

    // ── Notifications (fire-and-forget, pref-gated in the center) ─────────
    const notificationCenter = require('../services/notificationCenter');
    const preview = text.trim().slice(0, 120);

    // 1. Video owner — "comments" kind (self-comments filtered by the center).
    notificationCenter.notify(video.userId, 'comments', {
      title: `@${req.user.username} commented on your video`,
      body:  preview,
      fromUserId: req.user.id,
      data: { videoId: String(video._id), commentId: String(comment._id), type: 'comment' },
    }).catch(() => {});

    // 2. @mentions — every distinct @username in the text that maps to a
    //    real account gets a "mentions" notification (owner excluded — they
    //    already got the comment one; the center also drops self-mentions).
    const mentioned = [...new Set((text.match(/@([a-z0-9_]{3,30})/gi) || [])
      .map((m) => m.slice(1).toLowerCase()))].slice(0, 10);
    if (mentioned.length) {
      User.find({ username: { $in: mentioned } }).select('_id').lean()
        .then((users) => Promise.all(
          users
            .filter((u) => !u._id.equals(video.userId))
            .map((u) => notificationCenter.notify(u._id, 'mentions', {
              title: `@${req.user.username} mentioned you in a comment`,
              body:  preview,
              fromUserId: req.user.id,
              data: { videoId: String(video._id), commentId: String(comment._id), type: 'mention' },
            })),
        ))
        .catch(() => {});
    }

    await comment.populate('userId', 'username fullName profileImage');
    return ok(res, { message: 'Comment added', comment }, 201);
  } catch (err) {
    console.error('addComment error:', err);
    return fail(res, err.message || 'Failed to add comment', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EDIT COMMENT
// PUT /api/videos/:id/comments/:commentId
// Body: { text }
// ─────────────────────────────────────────────────────────────────────────────
exports.editComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment || comment.isHidden) return fail(res, 'Comment not found', 404);

    // Debug breadcrumb — dev only. Makes it obvious when a comment owner
    // check fails whether it was really a different user or an ObjectId-vs-
    // string mismatch. Paired with the [auth] log in Auth.js so both sides
    // of the equality are visible in the same terminal.
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[editComment] commentId=${comment._id} owner=${comment.userId} caller=${req.user._id} match=${comment.userId.equals(req.user.id)}`,
      );
    }

    if (!comment.userId.equals(req.user.id)) return fail(res, 'Unauthorized', 403);

    const { text } = req.body;
    if (!text?.trim()) return fail(res, 'Comment text is required');

    comment.text     = text.trim();
    comment.isEdited = true;
    comment.editedAt = new Date();
    await comment.save();

    return ok(res, { message: 'Comment updated', comment });
  } catch (err) {
    console.error('editComment error:', err);
    return fail(res, 'Failed to edit comment', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE COMMENT
// DELETE /api/videos/:id/comments/:commentId
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment || comment.isHidden) return fail(res, 'Comment not found', 404);

    const isOwner = comment.userId.equals(req.user.id);
    const isAdmin = req.user.role === 'admin';

    // Also allow the video owner to delete comments
    const video = await Video.findById(req.params.id).select('userId');
    const isVideoOwner = video?.userId.equals(req.user.id);

    if (!isOwner && !isAdmin && !isVideoOwner) return fail(res, 'Unauthorized', 403);

    comment.isHidden = true;
    await comment.save();

    await Video.findByIdAndUpdate(req.params.id, {
      $inc: { commentsCount: -1 },
    });

    return ok(res, { message: 'Comment deleted' });
  } catch (err) {
    console.error('deleteComment error:', err);
    return fail(res, 'Failed to delete comment', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE COMMENT LIKE
// POST /api/videos/:id/comments/:commentId/like
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleCommentLike = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment || comment.isHidden) return fail(res, 'Comment not found', 404);

    // Blocked pairs can't interact with content on each other's videos.
    const video = await Video.findById(comment.videoId).select('userId');
    if (!video) return fail(res, 'Video not found', 404);
    if (await privacy.isBlockedBetween(req.user.id, video.userId)) {
      return fail(res, 'You cannot interact with this content.', 403);
    }

    const uid   = req.user.id;
    const liked = comment.isLikedBy(uid);

    if (liked) {
      comment.likes      = comment.likes.filter(id => !id.equals(uid));
      comment.likesCount = Math.max(comment.likesCount - 1, 0);
    } else {
      comment.likes.push(uid);
      comment.likesCount += 1;
    }

    await comment.save();
    return ok(res, { liked: !liked, likesCount: comment.likesCount });
  } catch (err) {
    console.error('toggleCommentLike error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PIN / UNPIN COMMENT  (video owner only)
// POST /api/videos/:id/comments/:commentId/pin
// ─────────────────────────────────────────────────────────────────────────────
exports.pinComment = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.userId.equals(req.user.id)) return fail(res, 'Only the video owner can pin comments', 403);

    const comment = await Comment.findById(req.params.commentId);
    if (!comment || comment.isHidden) return fail(res, 'Comment not found', 404);

    // Unpin previous pinned comment
    if (video.pinnedComment && !video.pinnedComment.equals(comment._id)) {
      await Comment.findByIdAndUpdate(video.pinnedComment, { isPinned: false });
    }

    const willPin        = !comment.isPinned;
    comment.isPinned     = willPin;
    video.pinnedComment  = willPin ? comment._id : null;

    await Promise.all([comment.save(), video.save()]);

    return ok(res, {
      message:   willPin ? 'Comment pinned' : 'Comment unpinned',
      isPinned:  willPin,
    });
  } catch (err) {
    console.error('pinComment error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADD REPLY
// POST /api/videos/:id/comments/:commentId/reply
// Body: { text }
// ─────────────────────────────────────────────────────────────────────────────
exports.addReply = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment || comment.isHidden) return fail(res, 'Comment not found', 404);

    // Same enforcement as addComment — a reply is still a comment on the
    // video, so the owner's comment policy + privacy settings apply.
    const video = await Video.findById(req.params.id).select('userId status allowComments');
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.allowComments) return fail(res, 'Comments are disabled for this video', 403);

    const denied = await commentGate(req.user.id, video.userId);
    if (denied) return res.status(403).json(denied);

    const { text } = req.body;
    if (!text?.trim()) return fail(res, 'Reply text is required');

    comment.replies.push({ userId: req.user.id, text: text.trim() });
    comment.repliesCount += 1;
    await comment.save();

    await comment.populate('replies.userId', 'username fullName profileImage');
    const newReply = comment.replies[comment.replies.length - 1];

    return ok(res, { message: 'Reply added', reply: newReply, repliesCount: comment.repliesCount }, 201);
  } catch (err) {
    console.error('addReply error:', err);
    return fail(res, 'Failed to add reply', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EDIT REPLY
// PUT /api/videos/:id/comments/:commentId/reply/:replyId
// Body: { text }
// ─────────────────────────────────────────────────────────────────────────────
exports.editReply = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment || comment.isHidden) return fail(res, 'Comment not found', 404);

    const reply = comment.replies.id(req.params.replyId);
    if (!reply) return fail(res, 'Reply not found', 404);
    if (!reply.userId.equals(req.user.id)) return fail(res, 'Unauthorized', 403);

    const { text } = req.body;
    if (!text?.trim()) return fail(res, 'Reply text is required');

    reply.text     = text.trim();
    reply.isEdited = true;
    reply.editedAt = new Date();
    await comment.save();

    return ok(res, { message: 'Reply updated', reply });
  } catch (err) {
    console.error('editReply error:', err);
    return fail(res, 'Failed to edit reply', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE REPLY
// DELETE /api/videos/:id/comments/:commentId/reply/:replyId
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteReply = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment || comment.isHidden) return fail(res, 'Comment not found', 404);

    const reply = comment.replies.id(req.params.replyId);
    if (!reply) return fail(res, 'Reply not found', 404);

    const isOwner      = reply.userId.equals(req.user.id);
    const isAdmin      = req.user.role === 'admin';
    const video        = await Video.findById(req.params.id).select('userId');
    const isVideoOwner = video?.userId.equals(req.user.id);

    if (!isOwner && !isAdmin && !isVideoOwner) return fail(res, 'Unauthorized', 403);

    reply.deleteOne();
    comment.repliesCount = Math.max(comment.repliesCount - 1, 0);
    await comment.save();

    return ok(res, { message: 'Reply deleted', repliesCount: comment.repliesCount });
  } catch (err) {
    console.error('deleteReply error:', err);
    return fail(res, 'Failed to delete reply', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE REPLY LIKE
// POST /api/videos/:id/comments/:commentId/reply/:replyId/like
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleReplyLike = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment || comment.isHidden) return fail(res, 'Comment not found', 404);

    // Blocked pairs can't interact with content on each other's videos.
    const video = await Video.findById(comment.videoId).select('userId');
    if (!video) return fail(res, 'Video not found', 404);
    if (await privacy.isBlockedBetween(req.user.id, video.userId)) {
      return fail(res, 'You cannot interact with this content.', 403);
    }

    const reply = comment.replies.id(req.params.replyId);
    if (!reply) return fail(res, 'Reply not found', 404);

    const uid   = req.user.id;
    const liked = reply.likes.some(id => id.equals(uid));

    if (liked) {
      reply.likes      = reply.likes.filter(id => !id.equals(uid));
      reply.likesCount = Math.max(reply.likesCount - 1, 0);
    } else {
      reply.likes.push(uid);
      reply.likesCount += 1;
    }

    await comment.save();
    return ok(res, { liked: !liked, likesCount: reply.likesCount });
  } catch (err) {
    console.error('toggleReplyLike error:', err);
    return fail(res, 'Action failed', 500);
  }
};
