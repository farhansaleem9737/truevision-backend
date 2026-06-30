// Backend/controllers/VideoController.js
const Video                                                       = require('../models/Video');
const Repost                                                      = require('../models/Repost');
const cloudinary                                                  = require('../config/cloudinary');
const { uploadToCloudinary, deleteFromCloudinary,
        buildQualityUrls, buildThumbnailUrl }       = require('../middleware/upload');
const { checkContent }                                            = require('../utils/contentFilter');
const { scoreVideo }                                              = require('../services/contentRanking');
const { classifyContent }                                         = require('../services/geminiClassifier');
const { classifyCloudinaryVideo }                                 = require('../services/nsfwModeration');
const WatchHistory                                                = require('../models/WatchHistory');
const SharedVideo                                                 = require('../models/SharedVideo');

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const ok   = (res, data, statusCode = 200) => res.status(statusCode).json({ success: true,  ...data });
const fail = (res, message, statusCode = 400) => res.status(statusCode).json({ success: false, message });

const withUserFlags = (video, userId) => {
  const v = video.toObject ? video.toObject() : { ...video };
  if (!userId) return v;
  v.isLiked    = video.isLikedBy    ? video.isLikedBy(userId)    : false;
  v.isSaved    = video.isSavedBy    ? video.isSavedBy(userId)    : false;
  v.isReposted = video.isRepostedBy ? video.isRepostedBy(userId) : false;
  v.isFavorited= video.isFavoritedBy? video.isFavoritedBy(userId): false;
  return v;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET UPLOAD SIGNATURE  (replaces the old server-relay upload)
// GET /api/videos/upload-signature
// Body: { title, description, tags }
// Returns signed Cloudinary upload params — client uploads directly to Cloudinary
// ─────────────────────────────────────────────────────────────────────────────
exports.getUploadSignature = async (req, res) => {
  try {
    const { title = '', description = '', tags = '' } = req.body;
    if (!title.trim()) return fail(res, 'Title is required');

    const tagArray = typeof tags === 'string'
      ? tags.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean)
      : (Array.isArray(tags) ? tags : []);

    const { blocked } = checkContent(title, description, ...tagArray);
    if (blocked) return fail(res, 'Your content violates our community guidelines.', 422);

    const timestamp = Math.round(Date.now() / 1000);
    const folder    = `truevision/videos/${req.user.id}`;

    // Sign only folder + timestamp.
    // NO synchronous transformation — Cloudinary rejects it on large videos.
    // Quality variants are served lazily via URL-based transforms (buildQualityUrls).
    const paramsToSign = { folder, timestamp };
    const signature    = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_SECRET_KEY,
    );

    return ok(res, {
      signature,
      timestamp,
      folder,
      api_key:    process.env.CLOUDINARY_API_KEY,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (err) {
    console.error('getUploadSignature error:', err);
    return fail(res, 'Could not generate upload signature', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTACHMENT UPLOAD SIGNATURE
// GET /api/videos/attachment-signature?kind=image|raw
//
// Signs a direct-to-Cloudinary upload for source-evidence / news attachments
// (images, PDFs, docs). Same pattern as getUploadSignature but routes to a
// per-user attachments/ subfolder and uses resource_type 'image' or 'raw'
// (Cloudinary stores PDFs and other docs as 'raw').
// ─────────────────────────────────────────────────────────────────────────────
exports.getAttachmentSignature = async (req, res) => {
  try {
    const kind         = (req.query.kind || 'raw').toString();
    const resourceType = kind === 'image' ? 'image' : 'raw';

    const timestamp = Math.round(Date.now() / 1000);
    const folder    = `truevision/attachments/${req.user.id}`;
    const paramsToSign = { folder, timestamp };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_SECRET_KEY,
    );

    return ok(res, {
      signature,
      timestamp,
      folder,
      resourceType,
      api_key:    process.env.CLOUDINARY_API_KEY,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (err) {
    console.error('getAttachmentSignature error:', err);
    return fail(res, 'Could not generate attachment signature', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CREATE VIDEO RECORD  (called after client finishes direct Cloudinary upload)
// POST /api/videos/create
// Body: { publicId, secureUrl, duration, bytes, format, width, height,
//         title, description, song, tags, category, visibility, allowDownload }
// ─────────────────────────────────────────────────────────────────────────────
exports.createVideo = async (req, res) => {
  try {
    const {
      // Cloudinary result fields
      publicId, secureUrl, duration = 0, bytes = 0, format = '', width = 0, height = 0,
      // Metadata
      title, description = '', song = '', tags = '',
      category = 'other', visibility = 'public',
      allowDownload = true, allowComments = true, allowDuet = true,
      // Content type + source attachments (all optional)
      contentType   = null,
      sourceUrl     = '',
      sourceFiles   = [],
      newsUrl       = '',
      newsPublisher = '',
      newsFiles     = [],
    } = req.body;

    if (!publicId || !secureUrl) return fail(res, 'Cloudinary upload result is missing');
    if (!title?.trim())          return fail(res, 'Title is required');

    const tagArray = typeof tags === 'string'
      ? tags.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean)
      : (Array.isArray(tags) ? tags : []);

    // Content check again (defence-in-depth — signature endpoint already ran it)
    const { blocked } = checkContent(title, description, ...tagArray);
    if (blocked) {
      // Delete the already-uploaded asset from Cloudinary so it doesn't linger
      await deleteFromCloudinary(publicId, 'video').catch(() => {});
      return fail(res, 'Your content violates our community guidelines.', 422);
    }

    // ── NSFW MODERATION ────────────────────────────────────────────────────
    // Sample frames from the Cloudinary-hosted video and classify each
    // locally via NudeNet (see services/nsfwModeration.js). Block PORN/NSFW
    // outcomes; pass-through on inference failure (fallback flag set).
    const moderation = await classifyCloudinaryVideo({ publicId, duration });
    if (moderation.status === 'PORN' || moderation.status === 'NSFW') {
      await deleteFromCloudinary(publicId, 'video').catch(() => {});

      // User-facing wording: short label + retry hint. We never expose the
      // raw "PORN" string or the confidence number to the uploader — those
      // remain in the JSON response (moderation.status, moderation.confidence)
      // for server logs and any future admin tooling.
      const reason = moderation.status === 'PORN'
        ? 'Video failed due to adult content detection.'
        : 'Video failed due to explicit content detection.';

      return res.status(422).json({
        success: false,
        moderation: {
          status:     moderation.status,
          confidence: moderation.confidence,
        },
        message: `${reason} Please upload a different video.`,
      });
    }

    const thumbnailUrl = buildThumbnailUrl(publicId);
    const qualities    = buildQualityUrls(publicId);

    // Safely coerce — body values can be boolean or string "true"/"false"
    const toBool = (v, def = true) => v === undefined ? def : v === 'false' ? false : !!v;

    // ── Content type + source validation ────────────────────────────────────
    // Type is optional. If provided it must be one of fact / news / opinion.
    // Source-file arrays are sanitised to drop malformed entries (caller may
    // post partial objects mid-upload). Opinion strips all source data.
    const safeType = ['fact', 'news', 'opinion'].includes(contentType) ? contentType : null;
    const sanitizeFiles = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((f) => f && typeof f.url === 'string' && f.url.length > 0)
        .slice(0, 5)
        .map((f) => ({
          url:      String(f.url),
          publicId: String(f.publicId || ''),
          type:     ['image', 'pdf', 'document'].includes(f.type) ? f.type : 'document',
          name:     String(f.name || '').slice(0, 200),
          size:     Number(f.size) || 0,
        }));

    const safeSources = safeType === 'fact'
      ? { sourceUrl: String(sourceUrl || '').trim().slice(0, 2048),
          sourceFiles: sanitizeFiles(sourceFiles) }
      : { sourceUrl: '', sourceFiles: [] };

    const safeNews = safeType === 'news'
      ? { newsUrl:       String(newsUrl || '').trim().slice(0, 2048),
          newsPublisher: String(newsPublisher || '').trim().slice(0, 120),
          newsFiles:     sanitizeFiles(newsFiles) }
      : { newsUrl: '', newsPublisher: '', newsFiles: [] };

    const video = await Video.create({
      userId:    req.user.id,
      title:     title.trim(),
      description,
      song,
      tags:      tagArray,
      category,
      visibility,
      allowDownload:  toBool(allowDownload),
      allowComments:  toBool(allowComments),
      allowDuet:      toBool(allowDuet),
      videoUrl:          secureUrl,
      videoPublicId:     publicId,
      thumbnailUrl,
      thumbnailPublicId: '',
      duration:  Number(duration)  || 0,
      fileSize:  Number(bytes)     || 0,
      format,
      resolution: { width: Number(width) || 0, height: Number(height) || 0 },
      qualities,
      status: 'active',
      contentType: safeType,
      ...safeSources,
      ...safeNews,
    });

    // Fire-and-forget content analysis. Don't block the upload response on
    // Gemini latency / availability — the ranking system has a tag-based
    // fallback that runs synchronously below.
    runContentAnalysis(video).catch((e) => console.error('runContentAnalysis error:', e));

    // Synchronous tag/engagement ranking so the video has *some* score from
    // the moment it's saved. AI score will overwrite informativeScore once
    // the async Gemini call returns.
    const initial = scoreVideo(video);
    video.tagScore        = initial.tagScore;
    video.engagementScore = initial.engagementScore;
    video.informativeScore = initial.informativeScore;
    video.rankingScore    = initial.rankingScore;
    video.rankingUpdatedAt = new Date();
    await video.save().catch(() => {});

    return ok(res, {
      message: 'Video uploaded successfully',
      video,
      moderation: {
        status:     moderation.status,
        confidence: moderation.confidence,
        ...(moderation.fallback ? { fallback: true } : {}),
      },
    }, 201);
  } catch (err) {
    console.error('createVideo error:', err);
    return fail(res, err.message || 'Failed to save video', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET FEED
// GET /api/videos/feed?page=1&limit=10&sort=new|trending|random&category=
// ─────────────────────────────────────────────────────────────────────────────
exports.getFeed = async (req, res) => {
  try {
    const page     = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit    = Math.min(parseInt(req.query.limit) || 10, 30);
    const sort     = req.query.sort || 'new';
    const category = req.query.category;

    const match = { status: 'active', visibility: 'public', isReported: { $ne: true } };
    if (category && category !== 'all') {
      // Accept comma-separated values for multi-category filter
      // (e.g. "education,tech,business" for the "For You" tab)
      const list = String(category).split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length > 1)      match.category = { $in: list };
      else if (list.length === 1) match.category = list[0];
    }
    if (req.user?.id) match.notInterested = { $nin: [req.user.id] };

    if (sort === 'random') {
      // MongoDB $sample for a random selection
      const pipeline = [
        { $match: match },
        { $sample: { size: limit } },
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id',
            as: 'userId',
            pipeline: [{ $project: { username: 1, fullName: 1, profileImage: 1 } }] } },
        { $unwind: { path: '$userId', preserveNullAndEmptyArrays: true } },
      ];
      const videos = await Video.aggregate(pipeline);
      return ok(res, { videos, pagination: { page: 1, limit, total: videos.length, pages: 1 } });
    }

    const sortMap = {
      // Ranking algorithm-driven trending: combo of informativeScore, tagScore,
      // engagementScore — sorted DESC, with createdAt as a secondary key so two
      // equally-ranked videos surface the fresher one.
      trending: { rankingScore: -1, createdAt: -1 },
      new:      { createdAt: -1 },
    };
    const sortQuery = sortMap[sort] || sortMap.new;
    const skip      = (page - 1) * limit;

    const [videos, total] = await Promise.all([
      Video.find(match)
        .sort(sortQuery)
        .skip(skip)
        .limit(limit)
        .populate('userId', 'username fullName profileImage')
        .lean(),
      Video.countDocuments(match),
    ]);

    const enriched = await markReposts(videos, req.user?.id);

    return ok(res, {
      videos: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getFeed error:', err);
    return fail(res, 'Failed to fetch feed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// markReposts — annotate a list of plain video docs with isReposted=true/false
// for the current viewer. Single round-trip to the Repost collection.
// ─────────────────────────────────────────────────────────────────────────────
async function markReposts(videos, viewerId) {
  if (!viewerId || !videos?.length) {
    return (videos || []).map((v) => ({ ...v, isReposted: false }));
  }
  const ids = videos.map((v) => v._id).filter(Boolean);
  const rows = await Repost.find({ userId: viewerId, videoId: { $in: ids } })
    .select('videoId').lean();
  const set = new Set(rows.map((r) => r.videoId.toString()));
  return videos.map((v) => ({ ...v, isReposted: set.has(v._id.toString()) }));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET SINGLE VIDEO
// GET /api/videos/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getVideoById = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id)
      .populate('userId',       'username fullName profileImage')
      .populate('pinnedComment');

    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const data = req.user ? withUserFlags(video, req.user.id) : video.toObject();
    return ok(res, { video: data });
  } catch (err) {
    console.error('getVideoById error:', err);
    return fail(res, 'Failed to fetch video', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET VIDEOS BY USER
// GET /api/videos/user/:userId?page=1&limit=12
// ─────────────────────────────────────────────────────────────────────────────
exports.getUserVideos = async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const skip  = (page - 1) * limit;

    const isOwner = req.user?.id?.toString() === req.params.userId;
    const filter  = { userId: req.params.userId, status: 'active' };
    if (!isOwner) filter.visibility = 'public';

    const [videos, total] = await Promise.all([
      Video.find(filter)
        .sort({ pinned: -1, pinnedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-views -notInterested -reports -likes -saves -reposts -favorites')
        // Populate the uploader so the player shows the real creator's
        // username + profile image instead of a generic placeholder.
        .populate('userId', 'username fullName profileImage isVerified')
        .lean(),
      Video.countDocuments(filter),
    ]);

    const enriched = await markReposts(videos, req.user?.id);

    return ok(res, {
      videos: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getUserVideos error:', err);
    return fail(res, 'Failed to fetch user videos', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE VIDEO METADATA
// PUT /api/videos/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.updateVideo = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.userId.equals(req.user.id)) return fail(res, 'Unauthorized', 403);

    const { title, description, tags, song, category, visibility,
            allowDownload, allowComments, allowDuet,
            contentType, sourceUrl, sourceFiles,
            newsUrl, newsPublisher, newsFiles } = req.body;

    // Re-run content filter on new text fields
    const newTags = tags
      ? (typeof tags === 'string'
          ? tags.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean)
          : tags)
      : video.tags;

    const { blocked } = checkContent(
      title       || video.title,
      description !== undefined ? description : video.description,
      ...newTags,
    );
    if (blocked) return fail(res, 'Content violates community guidelines', 422);

    if (title       !== undefined) video.title       = title.trim();
    if (description !== undefined) video.description = description;
    if (song        !== undefined) video.song        = song;
    if (category    !== undefined) video.category    = category;
    if (visibility  !== undefined) video.visibility  = visibility;
    if (tags        !== undefined) video.tags        = newTags;
    if (allowDownload !== undefined) video.allowDownload = allowDownload;
    if (allowComments !== undefined) video.allowComments = allowComments;
    if (allowDuet     !== undefined) video.allowDuet     = allowDuet;

    // Content classification + sources. Same sanitisation rules as createVideo.
    if (contentType !== undefined) {
      const safeType = ['fact', 'news', 'opinion'].includes(contentType) ? contentType : null;
      video.contentType = safeType;
      // Switching type clears the sibling slots so stale data doesn't linger.
      if (safeType !== 'fact') { video.sourceUrl = ''; video.sourceFiles = []; }
      if (safeType !== 'news') { video.newsUrl = ''; video.newsPublisher = ''; video.newsFiles = []; }
    }
    if (sourceUrl     !== undefined) video.sourceUrl     = String(sourceUrl).trim().slice(0, 2048);
    if (newsUrl       !== undefined) video.newsUrl       = String(newsUrl).trim().slice(0, 2048);
    if (newsPublisher !== undefined) video.newsPublisher = String(newsPublisher).trim().slice(0, 120);

    const sanitizeFiles = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((f) => f && typeof f.url === 'string' && f.url.length > 0)
        .slice(0, 5)
        .map((f) => ({
          url:      String(f.url),
          publicId: String(f.publicId || ''),
          type:     ['image', 'pdf', 'document'].includes(f.type) ? f.type : 'document',
          name:     String(f.name || '').slice(0, 200),
          size:     Number(f.size) || 0,
        }));
    if (sourceFiles !== undefined) video.sourceFiles = sanitizeFiles(sourceFiles);
    if (newsFiles   !== undefined) video.newsFiles   = sanitizeFiles(newsFiles);

    await video.save();
    return ok(res, { message: 'Video updated', video });
  } catch (err) {
    console.error('updateVideo error:', err);
    return fail(res, err.message || 'Update failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE VIDEO
// DELETE /api/videos/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteVideo = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const isOwner = video.userId.equals(req.user.id);
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return fail(res, 'Unauthorized', 403);

    await Promise.all([
      deleteFromCloudinary(video.videoPublicId, 'video'),
      video.thumbnailPublicId
        ? deleteFromCloudinary(video.thumbnailPublicId, 'image')
        : Promise.resolve(),
    ]);

    video.status = 'deleted';
    await video.save();

    return ok(res, { message: 'Video deleted successfully' });
  } catch (err) {
    console.error('deleteVideo error:', err);
    return fail(res, 'Delete failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE PIN — pin/unpin a video to the owner's profile
// PUT /api/videos/:id/pin
// Body (optional): { pinned: boolean }   if omitted, current value is flipped
// Owner-only.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_PINNED = 3;

exports.togglePin = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.userId.equals(req.user.id))     return fail(res, 'Only the owner can pin this video', 403);

    const next = typeof req.body?.pinned === 'boolean' ? req.body.pinned : !video.pinned;

    if (next) {
      const pinnedCount = await Video.countDocuments({
        userId: req.user.id, pinned: true, status: 'active', _id: { $ne: video._id },
      });
      if (pinnedCount >= MAX_PINNED) {
        return fail(res, `You can pin up to ${MAX_PINNED} videos. Unpin one first.`);
      }
    }

    video.pinned   = next;
    video.pinnedAt = next ? new Date() : null;
    await video.save();

    return ok(res, {
      message: next ? 'Video pinned' : 'Video unpinned',
      videoId: video._id,
      pinned:  video.pinned,
      pinnedAt: video.pinnedAt,
    });
  } catch (err) {
    console.error('togglePin error:', err);
    return fail(res, 'Failed to update pin', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH HASHTAGS — aggregates the `tags` array across active public videos.
// GET /api/videos/search/hashtags?q=trav
// Returns: [{ tag: 'travel', videosCount: 42 }, ...] sorted by frequency.
// ─────────────────────────────────────────────────────────────────────────────
exports.searchHashtags = async (req, res) => {
  try {
    const q     = (req.query.q || '').trim().replace(/^#/, '');
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    if (q.length < 1) return ok(res, { hashtags: [] });

    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const rows = await Video.aggregate([
      { $match: { status: 'active', visibility: 'public', tags: { $exists: true, $ne: [] } } },
      { $unwind: '$tags' },
      { $project: { tag: { $toLower: '$tags' } } },
      { $match: { tag: re } },
      { $group: { _id: '$tag', videosCount: { $sum: 1 } } },
      { $sort: { videosCount: -1, _id: 1 } },
      { $limit: limit },
      { $project: { _id: 0, tag: '$_id', videosCount: 1 } },
    ]);

    return ok(res, { hashtags: rows });
  } catch (err) {
    console.error('searchHashtags error:', err);
    return fail(res, 'Hashtag search failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH VIDEOS
// GET /api/videos/search?q=&page=1&limit=10&category=
// ─────────────────────────────────────────────────────────────────────────────
exports.searchVideos = async (req, res) => {
  try {
    const q        = (req.query.q || '').trim();
    const page     = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit    = Math.min(parseInt(req.query.limit) || 10, 30);
    const skip     = (page - 1) * limit;
    const category = req.query.category;

    if (!q) return fail(res, 'Search query is required');

    const regex  = new RegExp(q, 'i');
    const filter = {
      status: 'active', visibility: 'public',
      $or: [{ title: regex }, { description: regex }, { tags: regex }],
    };
    if (category && category !== 'all') filter.category = category;

    const [videos, total] = await Promise.all([
      Video.find(filter)
        .sort({ viewsCount: -1, likesCount: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'username fullName profileImage')
        .lean(),
      Video.countDocuments(filter),
    ]);

    return ok(res, {
      videos,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('searchVideos error:', err);
    return fail(res, 'Search failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE LIKE
// POST /api/videos/:id/like
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleLike = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const uid   = req.user.id;
    const liked = video.isLikedBy(uid);

    if (liked) {
      video.likes      = video.likes.filter(id => !id.equals(uid));
      video.likesCount = Math.max(video.likesCount - 1, 0);
    } else {
      video.likes.push(uid);
      video.likesCount += 1;
    }

    await video.save();
    return ok(res, { liked: !liked, likesCount: video.likesCount });
  } catch (err) {
    console.error('toggleLike error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE SAVE / BOOKMARK
// POST /api/videos/:id/save
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleSave = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const uid   = req.user.id;
    const saved = video.isSavedBy(uid);

    if (saved) {
      video.saves      = video.saves.filter(id => !id.equals(uid));
      video.savesCount = Math.max(video.savesCount - 1, 0);
    } else {
      video.saves.push(uid);
      video.savesCount += 1;
    }

    await video.save();
    return ok(res, { saved: !saved, savesCount: video.savesCount });
  } catch (err) {
    console.error('toggleSave error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE REPOST
// POST /api/videos/:id/repost
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleRepost = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const uid     = req.user.id;
    const videoId = video._id;

    // Toggle by attempting to delete first; insert only if no row existed.
    const deleted = await Repost.deleteOne({ userId: uid, videoId });
    let reposted;

    if (deleted.deletedCount > 0) {
      reposted = false;
      video.repostsCount = Math.max((video.repostsCount || 0) - 1, 0);
    } else {
      try {
        await Repost.create({ userId: uid, videoId, originalOwnerId: video.userId });
        reposted = true;
        video.repostsCount = (video.repostsCount || 0) + 1;
      } catch (err) {
        // Race: another request just created the same row. Treat as already-reposted.
        if (err.code === 11000) reposted = true;
        else throw err;
      }
    }

    await video.save();
    return ok(res, { reposted, repostsCount: video.repostsCount });
  } catch (err) {
    console.error('toggleRepost error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET REPOSTS BY USER
// GET /api/users/:userId/reposts?page=1&limit=30
// ─────────────────────────────────────────────────────────────────────────────
exports.getUserReposts = async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const skip  = (page - 1) * limit;

    const [reposts, total] = await Promise.all([
      Repost.find({ userId: targetUserId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path:   'videoId',
          match:  { status: { $ne: 'deleted' } },
          select: '-views -notInterested -reports -likes -saves -reposts -favorites',
          populate: { path: 'userId', select: 'username fullName profileImage' },
        })
        .lean(),
      Repost.countDocuments({ userId: targetUserId }),
    ]);

    // Drop entries whose original video was deleted (populate.match returns null)
    const videos = reposts
      .filter((r) => r.videoId)
      .map((r) => ({
        ...r.videoId,
        repostedAt: r.createdAt,
        isReposted: true,
      }));

    return ok(res, {
      videos,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getUserReposts error:', err);
    return fail(res, 'Failed to fetch reposts', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE FAVORITE
// POST /api/videos/:id/favorite
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleFavorite = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const uid       = req.user.id;
    const favorited = video.isFavoritedBy(uid);

    if (favorited) {
      video.favorites      = video.favorites.filter(id => !id.equals(uid));
      video.favoritesCount = Math.max(video.favoritesCount - 1, 0);
    } else {
      video.favorites.push(uid);
      video.favoritesCount += 1;
    }

    await video.save();
    return ok(res, { favorited: !favorited, favoritesCount: video.favoritesCount });
  } catch (err) {
    console.error('toggleFavorite error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MARK NOT INTERESTED
// POST /api/videos/:id/not-interested
// ─────────────────────────────────────────────────────────────────────────────
exports.markNotInterested = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const uid          = req.user.id;
    const alreadyMarked = video.notInterested.some(id => id.equals(uid));
    if (!alreadyMarked) {
      video.notInterested.push(uid);
      await video.save();
    }

    return ok(res, { message: 'Marked as not interested' });
  } catch (err) {
    console.error('markNotInterested error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RECORD VIEW
// POST /api/videos/:id/view
// Body: { watchTime }
// ─────────────────────────────────────────────────────────────────────────────
exports.recordView = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const watchTime    = parseInt(req.body.watchTime)    || 0;
    const lastPosition = parseInt(req.body.lastPosition) || 0;

    if (req.user) {
      if (!video.hasViewedBy(req.user.id)) {
        video.views.push({ userId: req.user.id, watchTime });
        video.viewsCount += 1;
      }
    } else {
      video.viewsCount += 1;
    }

    await video.save();

    // Mirror to WatchHistory so the "My Activity → Watch History" screen has
    // data. Upsert: re-watching the same video bumps watchedAt + replaces
    // position/duration instead of duplicating the row. Best-effort —
    // failure here must not break view recording.
    if (req.user) {
      // Save threshold: only insert/update once the viewer has actually
      // watched some of the video. 3 seconds OR 10% — whichever comes first.
      // Stops "scroll-past" videos from polluting Watch History.
      const vidDur = Math.max(1, Number(video.duration) || 0);
      const completion = Math.min(100, (Math.max(0, watchTime) / vidDur) * 100);
      const meetsThreshold = watchTime >= 3 || completion >= 10;

      if (meetsThreshold) {
        WatchHistory.findOneAndUpdate(
          { userId: req.user.id, videoId: video._id },
          {
            $set: {
              watchedAt:            new Date(),
              lastPlaybackPosition: Math.max(0, lastPosition),
              watchDuration:        Math.max(0, watchTime),
              completionPercentage: Math.max(0, Math.min(100, completion)),
            },
            $setOnInsert: { userId: req.user.id, videoId: video._id },
          },
          { upsert: true },
        ).catch((e) => console.error('WatchHistory upsert failed:', e.message));
      }
    }

    return ok(res, { viewsCount: video.viewsCount });
  } catch (err) {
    console.error('recordView error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD VIDEO
// POST /api/videos/:id/download
// ─────────────────────────────────────────────────────────────────────────────
exports.downloadVideo = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.allowDownload) return fail(res, 'Downloads are disabled for this video', 403);

    video.downloadsCount += 1;
    await video.save();

    const downloadUrl = cloudinary.url(video.videoPublicId, {
      resource_type: 'video',
      flags:         'attachment',
      sign_url:      true,
      expires_at:    Math.floor(Date.now() / 1000) + 3600,
    });

    return ok(res, { downloadUrl, downloadsCount: video.downloadsCount });
  } catch (err) {
    console.error('downloadVideo error:', err);
    return fail(res, 'Download failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// INCREMENT SHARE COUNT
// POST /api/videos/:id/share
// ─────────────────────────────────────────────────────────────────────────────
exports.shareVideo = async (req, res) => {
  try {
    const video = await Video.findByIdAndUpdate(
      req.params.id,
      { $inc: { sharesCount: 1 } },
      { new: true },
    );
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    // Mirror to SharedVideo for the "My Activity → Shared Videos" list.
    // Not deduped — every share event is its own row (timeline-style).
    // Best-effort; we don't want a logging hiccup to fail the share itself.
    if (req.user) {
      const platform = String(req.body?.platform || 'system_share').slice(0, 40);
      SharedVideo.create({
        userId:   req.user.id,
        videoId:  video._id,
        platform,
      }).catch((e) => console.error('SharedVideo write failed:', e.message));
    }

    return ok(res, { sharesCount: video.sharesCount });
  } catch (err) {
    console.error('shareVideo error:', err);
    return fail(res, 'Action failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REPORT VIDEO
// POST /api/videos/:id/report
// Body: { reason, description }
// ─────────────────────────────────────────────────────────────────────────────
exports.reportVideo = async (req, res) => {
  try {
    const { reason, description = '' } = req.body;
    if (!reason) return fail(res, 'Report reason is required');

    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    const uid          = req.user.id;
    const alreadyReported = video.reports.some(r => r.userId.equals(uid));
    if (alreadyReported) return fail(res, 'You have already reported this video');

    video.reports.push({ userId: uid, reason, description });
    video.reportCount += 1;
    if (video.reportCount >= 5) video.isReported = true;

    await video.save();
    return ok(res, { message: 'Video reported successfully' });
  } catch (err) {
    console.error('reportVideo error:', err);
    return fail(res, 'Report failed', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// COLLECTION ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
const buildCollection = (filter) => async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 12, 30);
    const skip  = (page - 1) * limit;
    const query = { ...filter(req.user.id), status: 'active' };

    const [videos, total] = await Promise.all([
      Video.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'username fullName profileImage')
        .lean(),
      Video.countDocuments(query),
    ]);

    return ok(res, { videos, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('collection error:', err);
    return fail(res, 'Failed to fetch videos', 500);
  }
};

exports.getSavedVideos    = buildCollection(uid => ({ saves:     uid }));
exports.getLikedVideos    = buildCollection(uid => ({ likes:     uid }));
exports.getFavoriteVideos = buildCollection(uid => ({ favorites: uid }));

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT ANALYSIS
// Called fire-and-forget after upload. Calls Gemini for category +
// informativeScore, then recomputes the full ranking using contentRanking
// helpers. Cheap to run when GEMINI_API_KEY is unset (skips the network call).
// ─────────────────────────────────────────────────────────────────────────────
async function runContentAnalysis(video) {
  try {
    const ai = await classifyContent({
      title:       video.title,
      description: video.description,
      tags:        video.tags,
    });

    if (ai) {
      video.aiCategory       = ai.category;
      video.informativeScore = ai.informativeScore;
      video.aiAnalyzedAt     = new Date();
    }

    const scores = scoreVideo(video, ai ? { informativeScore: ai.informativeScore } : {});
    video.tagScore         = scores.tagScore;
    video.engagementScore  = scores.engagementScore;
    video.informativeScore = scores.informativeScore;
    video.rankingScore     = scores.rankingScore;
    video.rankingUpdatedAt = new Date();

    await video.save();
    return scores;
  } catch (err) {
    console.error('runContentAnalysis error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — recompute ranking scores for every active video
// POST /api/videos/admin/recompute-rankings?ai=true|false
//
// Use this after schema changes, after tweaking weights, or to backfill
// existing videos that pre-date the ranking system. Idempotent.
//   ?ai=true  → call Gemini for every video that hasn't been analysed yet
//   default   → tag + engagement only (fast, no API cost)
// ─────────────────────────────────────────────────────────────────────────────
exports.recomputeRankings = async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return fail(res, 'Admin only', 403);

    const useAi = String(req.query.ai || 'false') === 'true';
    const videos = await Video.find({ status: 'active' });
    let analysed = 0;
    let aiCalls  = 0;

    for (const video of videos) {
      let aiResult = null;
      if (useAi && !video.aiAnalyzedAt) {
        aiResult = await classifyContent({
          title: video.title, description: video.description, tags: video.tags,
        });
        if (aiResult) {
          aiCalls++;
          video.aiCategory       = aiResult.category;
          video.informativeScore = aiResult.informativeScore;
          video.aiAnalyzedAt     = new Date();
        }
      }
      const scores = scoreVideo(video, aiResult ? { informativeScore: aiResult.informativeScore } : {});
      video.tagScore         = scores.tagScore;
      video.engagementScore  = scores.engagementScore;
      video.informativeScore = scores.informativeScore;
      video.rankingScore     = scores.rankingScore;
      video.rankingUpdatedAt = new Date();
      await video.save();
      analysed++;
    }

    return ok(res, {
      message:  `Recomputed ranking for ${analysed} videos`,
      analysed, aiCalls,
    });
  } catch (err) {
    console.error('recomputeRankings error:', err);
    return fail(res, 'Recompute failed', 500);
  }
};
