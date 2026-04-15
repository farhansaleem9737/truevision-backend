// Backend/controllers/VideoController.js
const Video                                                       = require('../models/Video');
const cloudinary                                                  = require('../config/cloudinary');
const { uploadToCloudinary, deleteFromCloudinary,
        buildQualityUrls, buildThumbnailUrl }       = require('../middleware/upload');
const { checkContent }                                            = require('../utils/contentFilter');

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

    const thumbnailUrl = buildThumbnailUrl(publicId);
    const qualities    = buildQualityUrls(publicId);

    // Safely coerce — body values can be boolean or string "true"/"false"
    const toBool = (v, def = true) => v === undefined ? def : v === 'false' ? false : !!v;

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
    });

    return ok(res, { message: 'Video uploaded successfully', video }, 201);
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
    if (category && category !== 'all') match.category = category;
    if (req.user?.id) match.notInterested = { $nin: [req.user.id] };

    if (sort === 'random') {
      // MongoDB $sample for a random selection
      const pipeline = [
        { $match: match },
        { $sample: { size: limit } },
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id',
            as: 'userId',
            pipeline: [{ $project: { username: 1, fullName: 1, profileImage: 1 } }] } },
        { $unwind: { path: '$userId', preserveNullAndEmpty: true } },
      ];
      const videos = await Video.aggregate(pipeline);
      return ok(res, { videos, pagination: { page: 1, limit, total: videos.length, pages: 1 } });
    }

    const sortMap = {
      trending: { viewsCount: -1, likesCount: -1 },
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

    return ok(res, {
      videos,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getFeed error:', err);
    return fail(res, 'Failed to fetch feed', 500);
  }
};

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
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-views -notInterested -reports -likes -saves -reposts -favorites')
        .lean(),
      Video.countDocuments(filter),
    ]);

    return ok(res, {
      videos,
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
            allowDownload, allowComments, allowDuet } = req.body;

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

    const uid      = req.user.id;
    const reposted = video.isRepostedBy(uid);

    if (reposted) {
      video.reposts      = video.reposts.filter(id => !id.equals(uid));
      video.repostsCount = Math.max(video.repostsCount - 1, 0);
    } else {
      video.reposts.push(uid);
      video.repostsCount += 1;
    }

    await video.save();
    return ok(res, { reposted: !reposted, repostsCount: video.repostsCount });
  } catch (err) {
    console.error('toggleRepost error:', err);
    return fail(res, 'Action failed', 500);
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

    const watchTime = parseInt(req.body.watchTime) || 0;

    if (req.user) {
      if (!video.hasViewedBy(req.user.id)) {
        video.views.push({ userId: req.user.id, watchTime });
        video.viewsCount += 1;
      }
    } else {
      video.viewsCount += 1;
    }

    await video.save();
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
