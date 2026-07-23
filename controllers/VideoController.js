// Backend/controllers/VideoController.js
const mongoose                                                    = require('mongoose');
const Video                                                       = require('../models/Video');
const Repost                                                      = require('../models/Repost');
const User                                                        = require('../models/User');
const cloudinary                                                  = require('../config/cloudinary');
const { uploadToCloudinary, deleteFromCloudinary,
        buildQualityUrls, buildThumbnailUrl,
        buildEagerString }                          = require('../middleware/upload');
const { checkContent }                                            = require('../utils/contentFilter');
const { PUBLIC_REVIEW_FILTER, HIDDEN_REVIEW_STATES }              = require('../services/moderationPolicy');
const { scoreVideo, computeSensitivity, personalizeScore }        = require('../services/contentRanking');
const { classifyContent }                                         = require('../services/geminiClassifier');
const { classifyCloudinaryVideo }                                 = require('../services/nsfwModeration');
const aiClient                                                    = require('../services/aiClient');
const SharedVideo                                                 = require('../models/SharedVideo');
const privacy                                                     = require('../services/privacy');
const cache                                                       = require('../services/cache');
const feedCache                                                   = require('../services/feedCache');

// ── Cache TTLs + key builders ────────────────────────────────────────────
// Kept in one place so Phase-4 counter-flush + invalidation stay consistent.
const TTL = {
  feed:        30,    // 30 s — trending page turns quickly
  videoById:   300,   // 5 min — invalidated on mutation
  hashtag:     300,   // 5 min — trending tag list rarely changes
};

const kFeed      = ({ sort, category, page, limit, viewerId }) =>
  `video:feed:${sort}:${category || 'all'}:${viewerId || 'anon'}:${page}:${limit}`;
const kVideo     = (id)   => `video:byId:${id}`;
const kHashtag   = (q,l)  => `video:hashtag:${(q||'').toLowerCase()}:${l}`;

/**
 * Wipe every cached feed permutation — both the trending/new pages
 * (`video:feed:*`) AND the per-viewer personalized pools (`video:foryou:pool:*`).
 * Call this whenever a video's PUBLIC visibility changes (new approved upload,
 * admin approve/reject, block/unblock, delete) so the change surfaces on the
 * very next fetch instead of after the 30 s TTL. Cheap SCAN-based delete.
 */
const invalidateFeed  = () => feedCache.invalidatePublicFeeds();
/** Drop a single video's cache after mutation. */
const invalidateVideo = (id) => cache.del(kVideo(String(id))).catch(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const ok   = (res, data, statusCode = 200) => res.status(statusCode).json({ success: true,  ...data });
const fail = (res, message, statusCode = 400) => res.status(statusCode).json({ success: false, message });

const withUserFlags = (video, userId) => {
  // Works on both mongoose Documents and lean POJOs so we can hydrate flags
  // whether the doc came from Mongo or from the Redis cache.
  const v = video.toObject ? video.toObject() : { ...video };

  // Compute personal isLiked / isSaved / … from the RAW arrays BEFORE we
  // strip anything. If we did it after, the hide-count strip below would
  // wipe the like array and every viewer would show isLiked=false.
  const uid = userId ? String(userId) : null;
  const has = (arr) => Array.isArray(arr) && uid && arr.some((id) => String(id) === uid);
  const isLiked     = has(v.likes);
  const isSaved     = has(v.saves);
  const isReposted  = has(v.reposts);
  const isFavorited = has(v.favorites);

  // ── Hide-count enforcement ────────────────────────────────────────────────
  // If the owner has toggled hideLikeCount / hideShareCount, non-owner
  // viewers must not see the numeric count anywhere. We null out the counts
  // AND the underlying likes[] array so an inspective client cannot
  // reconstruct the number by counting entries. Owner sees real values.
  const ownerId = v.userId && typeof v.userId === 'object'
    ? (v.userId._id || v.userId.id)
    : v.userId;
  const isOwner = uid && ownerId && String(ownerId) === uid;

  if (!isOwner) {
    if (v.hideLikeCount) {
      v.likesCount = null;
      v.likes      = [];  // strip the array so length can't reveal count
    }
    if (v.hideShareCount) {
      v.sharesCount = null;
    }
  }

  if (uid) {
    v.isLiked     = isLiked;
    v.isSaved     = isSaved;
    v.isReposted  = isReposted;
    v.isFavorited = isFavorited;
  }
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

    // ── Eager transcoding at upload time ──────────────────────────────────
    //
    // ROOT-CAUSE FIX for the "newest video hangs on the loading spinner"
    // bug. Previously we signed only { folder, timestamp } and left
    // Cloudinary to transcode video variants on the FIRST client request.
    // For the newest upload, that first request hits an un-derived asset
    // and Cloudinary starts transcoding synchronously — 30 s to several
    // minutes for typical iPhone HEVC .mov sources. Mobile players time
    // out. Older videos work because their transcodes are already cached
    // at Cloudinary's edge.
    //
    // The eager parameter tells Cloudinary to kick off the 720p + 360p
    // transcodes IMMEDIATELY as part of the upload. With eager_async=true
    // the upload response is still fast; by the time our /videos/create
    // controller finishes moderating + saving the DB record (10-20 s),
    // Cloudinary is almost always done. The FIRST playback then serves
    // the pre-derived asset — no on-demand wait.
    const eager       = buildEagerString();
    const eagerAsync  = 'true';

    // Signed params MUST match the FormData the client will send.
    const paramsToSign = { eager, eager_async: eagerAsync, folder, timestamp };
    const signature    = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_SECRET_KEY,
    );

    return ok(res, {
      signature,
      timestamp,
      folder,
      eager,
      eager_async: eagerAsync,
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

    // Raw (PDF/doc) attachments are stored as Cloudinary type 'private' when
    // the client opts in (?access=private). Public delivery of raw PDFs is
    // blocked on this account ("deny or ACL failure" — verified empirically),
    // and neither signed delivery URLs nor basic auth bypass it. 'private'
    // assets ARE downloadable via utils.private_download_url, which the
    // evidence-url endpoint below mints on demand. Opt-in keeps the signature
    // backward-compatible with older app builds that don't send a `type` field.
    const accessType = resourceType === 'raw' && req.query.access === 'private'
      ? 'private' : null;

    const timestamp = Math.round(Date.now() / 1000);
    const folder    = `truevision/attachments/${req.user.id}`;
    const paramsToSign = accessType
      ? { folder, timestamp, type: accessType }
      : { folder, timestamp };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_SECRET_KEY,
    );

    return ok(res, {
      signature,
      timestamp,
      folder,
      resourceType,
      ...(accessType ? { type: accessType } : {}),
      api_key:    process.env.CLOUDINARY_API_KEY,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (err) {
    console.error('getAttachmentSignature error:', err);
    return fail(res, 'Could not generate attachment signature', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE FILE URL  (short-lived authenticated download link)
// GET /api/videos/:id/evidence/:index/url?field=source|news
//
// Why this exists: raw PDF/doc delivery is blocked account-wide on Cloudinary
// (public, signed and basic-auth GETs all return 401 "deny or ACL failure"),
// so the secure_url stored in sourceFiles/newsFiles is not directly openable.
// 'private'-type assets, however, can be fetched through a time-limited
// utils.private_download_url. This endpoint:
//   1. finds the requested evidence entry,
//   2. lazily migrates legacy public assets in place (rename upload → private —
//      same public_id, so stored DB rows stay valid),
//   3. returns a fresh 10-minute download URL the app can open/download.
// Images skip all of this — image delivery is not blocked.
// ─────────────────────────────────────────────────────────────────────────────
const EVIDENCE_URL_TTL = 600; // seconds

// public_id from a stored raw delivery URL (legacy rows may lack publicId).
// e.g. https://res.cloudinary.com/<cloud>/raw/upload/v123/truevision/attachments/<uid>/x.pdf
const rawPublicIdFromUrl = (url) => {
  const m = /\/raw\/(?:upload|private|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(?:\?.*)?$/
    .exec(String(url || ''));
  try { return m ? decodeURIComponent(m[1]) : null; } catch { return m ? m[1] : null; }
};

// Destroy a raw evidence blob that may live as type 'private' (new uploads /
// lazily-migrated) or legacy public 'upload' — the wrong guess returns
// { result: 'not found' } harmlessly. Throws only when Cloudinary errored on
// every attempt without confirming deletion, so deleteVideo's cascade logger
// actually sees the failure instead of an always-fulfilled allSettled wrapper.
const destroyRawEvidence = async (publicId) => {
  let lastErr = null;
  let deleted = false;
  for (const type of ['private', 'upload']) {
    try {
      const r = await cloudinary.uploader.destroy(publicId, { resource_type: 'raw', type });
      if (r?.result === 'ok') deleted = true;
    } catch (e) { lastErr = e; }
  }
  if (!deleted && lastErr) throw lastErr;
  return { result: deleted ? 'ok' : 'not found' };
};

exports.getEvidenceFileUrl = async (req, res) => {
  try {
    const { id, index } = req.params;
    const field = req.query.field === 'news' ? 'newsFiles' : 'sourceFiles';
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) return fail(res, 'Evidence file not found', 404);

    const video = await Video.findById(id)
      .select(`${field} status userId isArchived reviewStatus visibility`)
      .lean();
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    // ── Access gates — mirror getVideoById exactly. Evidence must never be
    // MORE visible than the video it belongs to. ─────────────────────────────
    const ownerId = String(video.userId || '');
    const viewerIsOwner = req.user?.id && ownerId && ownerId === String(req.user.id);
    if (video.isArchived && !viewerIsOwner) return fail(res, 'Video not found', 404);
    if (!viewerIsOwner && HIDDEN_REVIEW_STATES.includes(video.reviewStatus)) {
      return fail(res, 'Video not found', 404);
    }
    if (!viewerIsOwner && ownerId) {
      const viewerId = req.user?.id || null;
      if (await privacy.isBlockedBetween(viewerId, ownerId)) {
        return fail(res, 'Video not found', 404);
      }
      const owner = await User.findById(ownerId).select('followers preferences').lean();
      if (video.visibility === 'private') {
        return fail(res, 'This video is private.', 403);
      }
      if (video.visibility === 'followers' && !privacy.isFollower(viewerId, owner)) {
        return fail(res, 'This video is only visible to followers.', 403);
      }
      if (!privacy.canViewContentOf(viewerId, owner)) {
        return fail(res, 'This account is private.', 403);
      }
    }

    const entry = (video[field] || [])[idx];
    if (!entry || !entry.url) return fail(res, 'Evidence file not found', 404);

    // Images deliver publicly without restriction — hand back the stored URL.
    if (entry.type === 'image') {
      return ok(res, { url: entry.url, direct: true });
    }

    // Owner-folder scoping: attachment signatures always force the folder
    // truevision/attachments/<uploaderId>/, so a legitimate evidence publicId
    // MUST live under the video owner's folder. Anything else is a forged
    // reference to someone else's asset — refuse to rename or sign it.
    const publicId = entry.publicId || rawPublicIdFromUrl(entry.url);
    if (!publicId || !publicId.startsWith(`truevision/attachments/${ownerId}/`)) {
      return fail(res, 'Evidence file not found', 404);
    }

    // Lazy one-time migration: legacy assets were uploaded as public 'upload'
    // type. rename(to_type) moves them to 'private' in place (verified: keeps
    // the same public_id). An already-migrated asset makes rename throw
    // "Resource not found" for the upload type — that exact error is the
    // expected no-op; anything else (rate limit, outage) must NOT mint a
    // link that would 404, so it fails loudly and the app shows Retry.
    try {
      await cloudinary.uploader.rename(publicId, publicId, {
        resource_type: 'raw', type: 'upload', to_type: 'private', overwrite: true,
      });
    } catch (err) {
      const msg = err?.message || err?.error?.message || '';
      const isExpectedNoOp = err?.http_code === 404 || /not found/i.test(msg);
      if (!isExpectedNoOp) {
        console.error('getEvidenceFileUrl rename error:', msg);
        return fail(res, 'Could not prepare the evidence link. Try again.', 503);
      }
    }

    const expiresAt = Math.floor(Date.now() / 1000) + EVIDENCE_URL_TTL;
    const url = cloudinary.utils.private_download_url(publicId, '', {
      resource_type: 'raw',
      type: 'private',
      expires_at: expiresAt,
    });

    return ok(res, { url, expiresAt });
  } catch (err) {
    console.error('getEvidenceFileUrl error:', err);
    return fail(res, 'Could not create evidence link', 500);
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
      // Eager-derived URLs from Cloudinary's upload response — each entry is
      // { transformation, secure_url, width, height, status }. Saved as-is
      // into the `qualities` map when present so playback URLs are the exact
      // strings Cloudinary generated (guaranteed to hit the pre-derived
      // asset). Any missing rung falls back to buildQualityUrls below.
      eagerResults  = [],
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

    console.log(`[upload] STARTED user=${req.user.id} publicId=${publicId} visibility=${visibility} dur=${duration}s bytes=${bytes}`);

    // Suspended creators (moderation action) cannot upload. Clean up the
    // already-uploaded Cloudinary asset so it doesn't linger.
    if (req.user?.isSuspended) {
      await deleteFromCloudinary(publicId, 'video').catch(() => {});
      return fail(res, 'Your account is suspended and cannot upload videos.', 403);
    }

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

    // ── qualities map: prefer Cloudinary's eager URLs when present ──────────
    //
    // Cloudinary's upload response returns each derived asset's exact
    // secure_url in the eager array. Using those verbatim guarantees the
    // player fetches the pre-transcoded file (no on-demand transcode wait
    // for the newest video — the root cause of the historical "stuck on
    // loading spinner" bug).
    //
    // buildQualityUrls() is used as the fallback for rungs that were not
    // in the eager set (144p / 240p / 480p) — those transcode lazily on
    // first request, which is fine because the player only touches them
    // when 720p / 360p are unavailable.
    const qualities = buildQualityUrls(publicId);

    if (Array.isArray(eagerResults)) {
      for (const e of eagerResults) {
        if (!e?.secure_url) continue;
        const h = Number(e.height) || 0;
        // Map by pixel height to the quality-ladder label. The exact rung
        // labels have to match what the frontend expects, so keep the map
        // 1-to-1 with QUALITY_LADDER in middleware/upload.js.
        const label =
          h >= 720 ? '720p' :
          h >= 480 ? '480p' :
          h >= 360 ? '360p' :
          h >= 240 ? '240p' :
          h >= 144 ? '144p' : null;
        if (label) qualities[label] = e.secure_url;
      }
    }

    console.log(`[createVideo] publicId=${publicId} eagerRungs=${eagerResults.map(e => e?.height).filter(Boolean).join(',') || 'none'} bytes=${bytes} fmt=${format} dur=${duration}s`);

    // Safely coerce — body values can be boolean or string "true"/"false"
    const toBool = (v, def = true) => v === undefined ? def : v === 'false' ? false : !!v;

    // ── Content type + source validation ────────────────────────────────────
    // Type is optional. If provided it must be one of fact / news / opinion.
    // Source-file arrays are sanitised to drop malformed entries (caller may
    // post partial objects mid-upload). Opinion strips all source data.
    const safeType = ['fact', 'news', 'opinion'].includes(contentType) ? contentType : null;
    // publicId is later used to mint signed download links and to destroy the
    // blob on delete — only accept ids inside the uploader's own attachments
    // folder (the signature endpoint forces that folder, so legitimate uploads
    // always match; anything else is a forged reference to a foreign asset).
    const ownAttachment = (pid) =>
      String(pid || '').startsWith(`truevision/attachments/${req.user.id}/`);
    const sanitizeFiles = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((f) => f && typeof f.url === 'string' && f.url.length > 0)
        .slice(0, 5)
        .map((f) => ({
          url:      String(f.url),
          publicId: ownAttachment(f.publicId) ? String(f.publicId) : '',
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

    // ── Sensitivity flag (drives "Hide Sensitive Content") ──────────────────
    // The video already PASSED NSFW moderation (PORN/NSFW is rejected above),
    // but borderline moderation scores or a sensitive-topic tag/title should
    // still be hidden from viewers who opted out. Fail-safe: never throw.
    const rejectThreshold = Number(process.env.NSFW_SCORE_THRESHOLD ?? 0.30);
    const sensitivity = computeSensitivity(
      { title, description, tags: tagArray },
      moderation || {},
      rejectThreshold,
    );

    // ── SYNCHRONOUS AI MODERATION — block entertainment BEFORE publishing ────
    // Classify the text (title + description + tags) with the zero-shot
    // classifier right now (no waiting for transcription), then decide via the
    // shared policy. Fail CLOSED: if the AI service is unavailable, hold for
    // manual review instead of auto-publishing — entertainment can never slip
    // through. The deeper async transcription pass still runs for ranking, but
    // it won't override this decision (its guard only fires on 'processing').
    const { decideFromClassifier } = require('../services/moderationPolicy');
    let verdict;
    try {
      const modText = [title, description, tagArray.join(' ')].filter(Boolean).join('. ').slice(0, 2000);
      console.log(`[moderation] classify input (text) user=${req.user.id} chars=${modText.length}: "${modText.slice(0, 160)}"`);
      const pred = await aiClient.predict(modText);
      // Log the RAW model output so a wrong/hardcoded confidence is visible.
      console.log(`[moderation] BART output category=${pred?.category} confidence=${typeof pred?.confidence === 'number' ? pred.confidence.toFixed(4) : pred?.confidence} fallback=${!!pred?.fallback} scores=${JSON.stringify(pred?.all_scores || {})}`);
      verdict = pred?.fallback
        ? { decision: 'pending_review', category: pred?.category || null, confidence: 0, level: 'classifier', reason: 'ai-unavailable' }
        : decideFromClassifier({ category: pred?.category, confidence: pred?.confidence });
      console.log(`[moderation] decision=${verdict.decision} category=${verdict.category} confidence=${Number(verdict.confidence).toFixed(4)} reason=${verdict.reason}`);
    } catch (e) {
      console.error('[moderation] classify failed:', e.message);
      verdict = { decision: 'pending_review', category: null, confidence: 0, level: 'classifier', reason: 'ai-error' };
    }

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
      // AI moderation decision made synchronously above. A 'blocked' /
      // 'pending_review' video is NOT publicly visible; only 'approved' shows.
      reviewStatus: verdict.decision,   // approved | blocked | pending_review
      review: {
        autoCategory: verdict.category,
        confidence:   verdict.confidence,
        decision:     verdict.decision,
        reason:       verdict.reason,
        decidedBy:    'ai',
        decidedAt:    new Date(),
        queuedAt:     new Date(),
      },
      contentType: safeType,
      isSensitive: sensitivity.isSensitive,
      moderation: {
        status:     moderation?.status || 'SAFE',
        confidence: Number(moderation?.confidence) || 0,
        reason:     sensitivity.reason,
        checkedAt:  new Date(),
      },
      ...safeSources,
      ...safeNews,
    });

    // Audit-log the synchronous decision + notify (creator, and followers on an
    // approve). Fire-and-forget so the upload response isn't held up.
    require('../services/moderationService').recordAutoDecision(video, verdict).catch(() => {});

    // Fire-and-forget deeper content analysis (transcription + ranking refresh).
    // Its moderation-decision branch is a no-op now (reviewStatus is no longer
    // 'processing'), so it never overrides the decision made above.
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

    console.log(`[upload] saved video=${video._id} user=${req.user.id} reviewStatus=${video.reviewStatus} category=${video.review?.autoCategory} confidence=${Number(video.review?.confidence ?? 0).toFixed(4)}`);

    // ── FEED PUBLISHING ────────────────────────────────────────────────────
    // Only an APPROVED video is publicly visible. Wipe the cached feed pages +
    // personalized pools so it appears on Discover/For-You/Following on the very
    // next fetch (no 30 s wait, no app restart). Blocked/pending stay hidden.
    if (video.reviewStatus === 'approved') {
      invalidateFeed();
      console.log(`[feed] published video=${video._id} → invalidated feed + foryou pools (appears immediately)`);
    } else {
      console.log(`[feed] video=${video._id} NOT published (reviewStatus=${video.reviewStatus}); withheld from feeds`);
    }

    // Decision-aware response so the client can show the right modal:
    //   approved       → "Upload Complete" (video is live)
    //   blocked        → "Video Blocked"   (entertainment) + Request Review
    //   pending_review → "Under Review"    (uncertain / AI offline)
    console.log(`[upload] FINISHED video=${video._id} reviewStatus=${video.reviewStatus} — ${video.reviewStatus === 'approved' ? 'PUBLISHED (visible in all feeds)' : 'withheld (async recovery will retry when AI is reachable)'}`);
    return ok(res, {
      message: verdict.decision === 'approved' ? 'Video published'
             : verdict.decision === 'blocked'  ? 'Video blocked'
             : 'Video under review',
      video,
      reviewStatus: video.reviewStatus,
      blocked: verdict.decision === 'blocked',
      moderation: {
        status:             moderation.status,          // NSFW verdict (SAFE/NSFW/PORN)
        confidence:         moderation.confidence,      // NSFW confidence 0–1
        category:           verdict.category,           // content category (e.g. entertainment)
        categoryConfidence: verdict.confidence,         // classifier confidence 0–1
        decision:           verdict.decision,
        reason:             verdict.reason,
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

    // isArchived: { $ne: true } is important — archived videos remain in
    // the collection but must never appear on public surfaces.
    const match = { status: 'active', visibility: 'public', isReported: { $ne: true }, isArchived: { $ne: true }, ...PUBLIC_REVIEW_FILTER };
    if (category && category !== 'all') {
      // Accept comma-separated values for multi-category filter
      // (e.g. "education,tech,business" for the "For You" tab)
      const list = String(category).split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length > 1)      match.category = { $in: list };
      else if (list.length === 1) match.category = list[0];
    }
    if (req.user?.id) match.notInterested = { $nin: [req.user.id] };

    // ── Hide Sensitive Content preference ──────────────────────────────────
    // When the viewer has enabled it, drop videos flagged sensitive at upload
    // (borderline moderation score or a sensitive-topic tag/title). Applies to
    // EVERY sort branch below because it lives on the shared match filter.
    const contentPrefs = req.user?.preferences?.content || {};
    if (contentPrefs.hideSensitive === true) {
      match.isSensitive = { $ne: true };
    }

    // Privacy: hide videos from private accounts the viewer doesn't follow
    // and from blocked pairs (either direction). Anonymous viewers exclude
    // ALL private accounts. ObjectId cast is explicit because the random
    // branch runs this match through an aggregate (no schema casting there).
    const excludedOwners = await privacy.contentExclusionsFor(req.user?.id || null);
    if (excludedOwners.length) {
      match.userId = { $nin: excludedOwners.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    // ── Personalized "For You" feed ────────────────────────────────────────
    // Requested via sort=foryou (or the legacy alias 'personalized'). Only
    // served for a signed-in user who hasn't turned personalization off; every
    // other case falls through to the global trending/new sort below, which
    // satisfies the spec's "When OFF: show generic trending feed."
    const wantsPersonalized = sort === 'foryou' || sort === 'personalized';
    const personalizationOn = contentPrefs.personalizedRecs !== false; // default ON
    if (wantsPersonalized && req.user?.id && personalizationOn) {
      return await servePersonalizedFeed({ req, res, match, page, limit });
    }

    if (sort === 'random') {
      // MongoDB $sample for a random selection — deliberately NOT cached
      // (each hit should return a different sample).
      const pipeline = [
        { $match: match },
        { $sample: { size: limit } },
        { $lookup: { from: 'users', localField: 'userId', foreignField: '_id',
            as: 'userId',
            pipeline: [{ $project: { username: 1, fullName: 1, profileImage: 1 } }] } },
        { $unwind: { path: '$userId', preserveNullAndEmptyArrays: true } },
      ];
      const videos = (await Video.aggregate(pipeline)).map((v) => withUserFlags(v, req.user?.id));
      return ok(res, { videos, pagination: { page: 1, limit, total: videos.length, pages: 1 } });
    }

    const sortMap = {
      // Ranking algorithm-driven trending: combo of informativeScore, tagScore,
      // engagementScore — sorted DESC, with createdAt as a secondary key so two
      // equally-ranked videos surface the fresher one.
      trending: { rankingScore: -1, createdAt: -1 },
      new:      { createdAt: -1 },
      // foryou/personalized reach here only when personalization is OFF or the
      // viewer is anonymous → serve the generic trending feed (per spec).
      foryou:       { rankingScore: -1, createdAt: -1 },
      personalized: { rankingScore: -1, createdAt: -1 },
    };
    const sortQuery = sortMap[sort] || sortMap.new;
    const skip      = (page - 1) * limit;

    // ── Cache-aside: same {sort, category, page, limit, viewer} → same result
    // for 30 s. The `viewerId` component is critical: the notInterested filter
    // is per-user, so sharing across viewers would leak filter state.
    const cacheKey = kFeed({
      sort, category, page, limit,
      viewerId: req.user?.id?.toString(),
    });

    // Register this key against the viewer so their feed can be invalidated
    // in a targeted, scan-free way when they change a recommendation setting.
    // Anonymous viewers can't change preferences, so we only track signed-in.
    if (req.user?.id) feedCache.trackUserFeedKey(req.user.id, cacheKey);

    const [videos, total] = await cache.withCache(cacheKey, TTL.feed, async () => {
      return Promise.all([
        Video.find(match)
          .sort(sortQuery)
          .skip(skip)
          .limit(limit)
          .populate('userId', 'username fullName profileImage')
          .lean(),
        Video.countDocuments(match),
      ]);
    });

    // Order matters: withUserFlags first (computes flags from raw arrays,
    // then strips hidden counts), markReposts second (overwrites isReposted
    // with the authoritative Repost-collection answer).
    const sanitized = videos.map((v) => withUserFlags(v, req.user?.id));
    const enriched  = await markReposts(sanitized, req.user?.id);

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
// PERSONALIZED FEED  (sort=foryou, signed-in + personalizedRecs on)
//
// Strategy: build a candidate POOL (top-quality + fresh videos passing the
// shared match filter), re-rank the whole pool for THIS viewer with
// personalizeScore (topic affinity + following + recency on top of the global
// rankingScore), then paginate deterministically from the ranked list. The
// ranked ID order is cached per-viewer for the feed TTL so successive pages
// stay consistent and cheap. When the pool is exhausted we page into the
// long tail by createdAt so the feed never dead-ends.
// ─────────────────────────────────────────────────────────────────────────────
const POOL_SIZE = 200;

async function servePersonalizedFeed({ req, res, match, page, limit }) {
  try {
    const viewerId = req.user.id;
    const prefs    = req.user.preferences?.content || {};
    const interestedTopics = Array.isArray(prefs.interestedTopics) ? prefs.interestedTopics : [];
    const followingSet = new Set((req.user.following || []).map((id) => String(id)));

    // Candidate pool: newest 200 that pass the filter, pre-sorted by quality
    // then recency. Cached per viewer so pagination is stable within the TTL.
    // The key is the well-known per-user pool key that invalidateUserFeed()
    // clears directly (no tracking needed — it's not viewerId-in-the-middle).
    const poolKey = feedCache.foryouPoolKey(viewerId);
    const pool = await cache.withCache(poolKey, TTL.feed, async () =>
      Video.find(match)
        .sort({ rankingScore: -1, createdAt: -1 })
        .limit(POOL_SIZE)
        .populate('userId', 'username fullName profileImage')
        .lean(),
    );

    const now = Date.now();
    const ranked = pool
      .map((v) => ({ v, s: personalizeScore(v, { interestedTopics, followingSet, now }) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.v);

    const skip = (page - 1) * limit;
    let slice = ranked.slice(skip, skip + limit);

    // Long-tail continuation: once the personalized pool is used up, keep the
    // feed going with older content by recency (still filtered + de-duped).
    if (slice.length < limit) {
      const seen = new Set(ranked.map((v) => String(v._id)));
      const need = limit - slice.length;
      const tailSkip = Math.max(0, skip - ranked.length);
      const tail = await Video.find({ ...match, _id: { $nin: [...seen].map((id) => new mongoose.Types.ObjectId(id)) } })
        .sort({ createdAt: -1 })
        .skip(tailSkip)
        .limit(need)
        .populate('userId', 'username fullName profileImage')
        .lean();
      slice = slice.concat(tail);
    }

    const sanitized = slice.map((v) => withUserFlags(v, viewerId));
    const enriched  = await markReposts(sanitized, viewerId);

    // total is an estimate for the client's pagination; the feed is effectively
    // infinite via the long-tail continuation above.
    const total = Math.max(ranked.length, skip + enriched.length);

    return ok(res, {
      videos: enriched,
      personalized: true,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('servePersonalizedFeed error:', err);
    return fail(res, 'Failed to fetch personalized feed', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET FOLLOWING FEED
// GET /api/videos/following?page=1&limit=10
//
// Videos from ONLY the creators the signed-in user currently follows. Newest
// first. Approved + public only (same visibility rules as the main feed). The
// follow set is read LIVE from the DB (not the cached token), so following a
// creator surfaces their videos immediately and unfollowing removes them on the
// next fetch — no restart, no stale membership. Not server-cached: correctness
// (fresh membership) is prioritised over a 30 s cache, and the query is a single
// indexed lookup ({ userId, status, createdAt } compound index).
// ─────────────────────────────────────────────────────────────────────────────
exports.getFollowingFeed = async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);
    const skip  = (page - 1) * limit;
    const viewerId = req.user.id;

    // Live follow set from the DB — guarantees unfollow/ follow reflect at once.
    const me = await User.findById(viewerId).select('following').lean();
    let followingIds = (me?.following || []).map((id) => String(id));

    // Exclude blocked users (either direction) even if a stale follow edge exists.
    const excluded = await privacy.contentExclusionsFor(viewerId);
    if (excluded.length) {
      const exclSet = new Set(excluded.map(String));
      followingIds = followingIds.filter((id) => !exclSet.has(id));
    }

    console.log(`[followingFeed] viewer=${viewerId} follows=${followingIds.length} page=${page}`);

    if (!followingIds.length) {
      return ok(res, { videos: [], pagination: { page, limit, total: 0, pages: 0 } });
    }

    const objIds = followingIds.map((id) => new mongoose.Types.ObjectId(id));
    const match = {
      userId:     { $in: objIds },
      status:     'active',
      visibility: 'public',
      isReported: { $ne: true },
      isArchived: { $ne: true },
      ...PUBLIC_REVIEW_FILTER,   // only approved (hides blocked/pending/rejected)
    };

    // Respect the viewer's "Hide Sensitive Content" preference (parity with feed).
    const contentPrefs = req.user?.preferences?.content || {};
    if (contentPrefs.hideSensitive === true) match.isSensitive = { $ne: true };

    const [videos, total] = await Promise.all([
      Video.find(match)
        .sort({ createdAt: -1 })   // newest upload first (spec)
        .skip(skip)
        .limit(limit)
        .populate('userId', 'username fullName profileImage')
        .lean(),
      Video.countDocuments(match),
    ]);

    const sanitized = videos.map((v) => withUserFlags(v, viewerId));
    const enriched  = await markReposts(sanitized, viewerId);

    console.log(`[followingFeed] returned=${enriched.length}/${total}`);

    return ok(res, {
      videos: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getFollowingFeed error:', err);
    return fail(res, 'Failed to fetch following feed', 500);
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
    // Cache-aside — video docs rarely change vs. how often the player fetches
    // them. Invalidated on toggleLike/toggleSave/toggleRepost/updateVideo below.
    // withUserFlags still runs live per-request so isLiked/isSaved stay correct
    // for the *current* viewer even when the doc is served from cache.
    const videoDoc = await cache.withCache(
      kVideo(req.params.id),
      TTL.videoById,
      async () => Video.findById(req.params.id)
        .populate('userId',       'username fullName profileImage')
        .populate('pinnedComment')
        .lean(),
    );

    if (!videoDoc || videoDoc.status === 'deleted') return fail(res, 'Video not found', 404);

    // Archived videos are owner-only: a direct link (or a stale client
    // holding the id) must 404 for everyone except the uploader. Without
    // this check, archive would only hide the video from lists, not from
    // direct fetches.
    const docOwnerId = videoDoc.userId?._id || videoDoc.userId;
    const viewerIsOwner = req.user?.id && docOwnerId && String(docOwnerId) === String(req.user.id);
    if (videoDoc.isArchived && !viewerIsOwner) return fail(res, 'Video not found', 404);

    // Moderation queue: videos still processing / blocked / rejected are
    // owner-only (the owner needs to open the block screen + request review).
    // Everyone else gets a plain 404. Legacy videos have no reviewStatus and
    // pass through untouched.
    if (!viewerIsOwner && HIDDEN_REVIEW_STATES.includes(videoDoc.reviewStatus)) {
      return fail(res, 'Video not found', 404);
    }

    // ── Privacy enforcement (live, never cached) ─────────────────────────
    // 1. Blocked pairs get a plain 404 — blocking is never revealed.
    // 2. Per-video visibility: 'private' → owner only; 'followers' → owner
    //    or approved follower.
    // 3. Account-level: private accounts show content only to the owner and
    //    approved followers. Anonymous viewers fail every non-public check.
    if (!viewerIsOwner && docOwnerId) {
      const viewerId = req.user?.id || null;
      if (await privacy.isBlockedBetween(viewerId, docOwnerId)) {
        return fail(res, 'Video not found', 404);
      }

      const owner = await User.findById(docOwnerId)
        .select('followers preferences blockedUsers')
        .lean();

      if (videoDoc.visibility === 'private') {
        return res.status(403).json({ success: false, code: 'VIDEO_PRIVATE', message: 'This video is private.' });
      }
      if (videoDoc.visibility === 'followers' && !privacy.isFollower(viewerId, owner)) {
        return res.status(403).json({ success: false, code: 'VIDEO_PRIVATE', message: 'This video is only visible to followers.' });
      }
      if (!privacy.canViewContentOf(viewerId, owner)) {
        return res.status(403).json({ success: false, code: 'ACCOUNT_PRIVATE', message: 'This account is private.' });
      }
    }

    // ALWAYS run withUserFlags — even for anonymous viewers — because it
    // also enforces the hideLikeCount/hideShareCount strip. Passing a null
    // userId strips counts without computing personal flags.
    const data = withUserFlags(videoDoc, req.user?.id);
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

    // Privacy gate: blocked pairs and private accounts the viewer doesn't
    // follow get an empty grid with isPrivate:true — same response shape as
    // the normal path so the client's list/pagination handling never breaks.
    if (!isOwner) {
      const [owner, blocked] = await Promise.all([
        User.findById(req.params.userId).select('followers preferences blockedUsers').lean(),
        privacy.isBlockedBetween(req.user?.id || null, req.params.userId),
      ]);
      if (blocked || !privacy.canViewContentOf(req.user?.id || null, owner)) {
        return ok(res, {
          videos: [],
          isPrivate: true,
          pagination: { page, limit, total: 0, pages: 0 },
        });
      }
    }

    // Archived videos never appear in the main profile grid — even for the
    // owner. They live in a separate /archived list. Non-owners are also
    // restricted to public visibility.
    const filter  = { userId: req.params.userId, status: 'active', isArchived: { $ne: true } };
    // Non-owners never see queued/blocked/rejected uploads; the owner sees all
    // of their own (with a status badge) so they can find the block screen.
    if (!isOwner) Object.assign(filter, { visibility: 'public' }, PUBLIC_REVIEW_FILTER);

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

    // withUserFlags enforces the hide-count strip for non-owner viewers.
    // (The social arrays are already excluded by the .select above, so the
    // per-user flags come back false here — the grid doesn't use them.)
    const sanitized = videos.map((v) => withUserFlags(v, req.user?.id));
    const enriched  = await markReposts(sanitized, req.user?.id);

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
            allowDownload, allowComments, allowDuet, allowRemix,
            hideLikeCount, hideShareCount, location,
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
    if (allowDownload  !== undefined) video.allowDownload  = !!allowDownload;
    if (allowComments  !== undefined) video.allowComments  = !!allowComments;
    if (allowDuet      !== undefined) video.allowDuet      = !!allowDuet;
    if (allowRemix     !== undefined) video.allowRemix     = !!allowRemix;
    if (hideLikeCount  !== undefined) video.hideLikeCount  = !!hideLikeCount;
    if (hideShareCount !== undefined) video.hideShareCount = !!hideShareCount;
    if (location       !== undefined) video.location       = String(location || '').trim().slice(0, 120);

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

    // Same folder-scoping rule as createVideo: a publicId outside the owner's
    // attachments folder is forged and must not be stored (it would later be
    // renamed/signed/destroyed as if it were this user's asset).
    const ownAttachment = (pid) =>
      String(pid || '').startsWith(`truevision/attachments/${req.user.id}/`);
    const sanitizeFiles = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((f) => f && typeof f.url === 'string' && f.url.length > 0)
        .slice(0, 5)
        .map((f) => ({
          url:      String(f.url),
          publicId: ownAttachment(f.publicId) ? String(f.publicId) : '',
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

    const videoId = video._id;

    // ── Cascade deletes across every collection that references this video ──
    // Runs in parallel — none depend on each other. Errors on any one
    // collection are logged but do not fail the whole delete: leaving a
    // stray comment doc is preferable to blocking the user from removing
    // the media entirely.
    const Comment       = require('../models/Comment');
    const Message       = require('../models/Message');
    // SharedVideo/Repost — same directory; lazy-loaded to keep the top of
    // this controller free of imports that are only used for deletes.
    const results = await Promise.allSettled([
      // Cloudinary media
      deleteFromCloudinary(video.videoPublicId, 'video'),
      video.thumbnailPublicId
        ? deleteFromCloudinary(video.thumbnailPublicId, 'image')
        : Promise.resolve(),

      // sourceFiles + newsFiles — user-attached Cloudinary evidence blobs.
      // publicId may be absent on legacy rows (derive it from the stored URL,
      // like getEvidenceFileUrl does) and is only trusted inside the owner's
      // attachments folder. Raw docs may live as type 'private' (new uploads /
      // lazily-migrated) or legacy public 'upload' — destroyRawEvidence tries
      // both and throws on real failures so the cascade logger records them.
      ...[...(Array.isArray(video.sourceFiles) ? video.sourceFiles : []),
          ...(Array.isArray(video.newsFiles)   ? video.newsFiles   : [])]
        .map((f) => {
          if (!f) return Promise.resolve();
          const pid = f.publicId || (f.type !== 'image' ? rawPublicIdFromUrl(f.url) : null);
          if (!pid || !String(pid).startsWith(`truevision/attachments/${String(video.userId)}/`)) {
            return Promise.resolve();   // no usable owner-scoped reference
          }
          return f.type === 'image'
            ? deleteFromCloudinary(pid, 'image')
            : destroyRawEvidence(pid);
        }),

      // MongoDB cascades — comments, share log, reposts
      Comment.deleteMany({ videoId }),
      SharedVideo.deleteMany({ videoId }),
      Repost.deleteMany({ videoId }),

      // Chat messages that shared this reel: keep the message row (the
      // conversation history should not lose a bubble) but strip the ref
      // and rewrite it as a tombstone so the client renders "reel deleted"
      // instead of a broken card pointing at a 404.
      Message.updateMany(
        { videoId },
        // Field is `text` on the Message schema — `content` would be silently
        // stripped by strict mode and the tombstone would render empty.
        { $set: { videoId: null, type: 'text', text: 'This reel was deleted by its owner.' } },
      ),
    ]);

    // Structured log so a failed cloudinary purge doesn't disappear silently.
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(`[deleteVideo] cascade step #${i} failed:`, r.reason?.message || r.reason);
      }
    });

    // Finally, hard-delete the Video document. We used to soft-mark it
    // status='deleted' but that leaves an orphan row that pollutes admin
    // queries and stops the user from re-uploading with the same title
    // without confusion. Full delete is the Instagram behavior.
    await Video.deleteOne({ _id: videoId });

    // Invalidate cached feed and single-video entries — the model's
    // post-save hook doesn't fire on deleteOne.
    invalidateFeed();
    invalidateVideo(videoId);

    return ok(res, {
      message: 'Video deleted permanently',
      videoId,
    });
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
// TOGGLE LIKE-COUNT VISIBILITY  (owner-only)
// PUT /api/videos/:id/hide-like-count   Body (optional): { hidden: boolean }
// If body omitted, flips the current value.
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleLikeCountVisibility = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.userId.equals(req.user.id))     return fail(res, 'Only the owner can change this', 403);

    const next = typeof req.body?.hidden === 'boolean' ? req.body.hidden : !video.hideLikeCount;
    video.hideLikeCount = next;
    await video.save();

    return ok(res, {
      message: next ? 'Like count hidden from others' : 'Like count visible to everyone',
      videoId: video._id,
      hideLikeCount: video.hideLikeCount,
    });
  } catch (err) {
    console.error('toggleLikeCountVisibility error:', err);
    return fail(res, 'Failed to update visibility', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE SHARE-COUNT VISIBILITY  (owner-only)
// PUT /api/videos/:id/hide-share-count   Body (optional): { hidden: boolean }
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleShareCountVisibility = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.userId.equals(req.user.id))     return fail(res, 'Only the owner can change this', 403);

    const next = typeof req.body?.hidden === 'boolean' ? req.body.hidden : !video.hideShareCount;
    video.hideShareCount = next;
    await video.save();

    return ok(res, {
      message: next ? 'Share count hidden from others' : 'Share count visible to everyone',
      videoId: video._id,
      hideShareCount: video.hideShareCount,
    });
  } catch (err) {
    console.error('toggleShareCountVisibility error:', err);
    return fail(res, 'Failed to update visibility', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE ARCHIVE  (owner-only)
// PUT /api/videos/:id/archive   Body (optional): { archived: boolean }
// Archived videos remain in the DB but disappear from every public surface
// (feed / trending / search / user grid / recommendations). Owner can restore
// via the same endpoint with archived=false OR by calling the /archived list
// and toggling from there. No Cloudinary work — the media stays put.
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleArchive = async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);
    if (!video.userId.equals(req.user.id))     return fail(res, 'Only the owner can archive this video', 403);

    const next = typeof req.body?.archived === 'boolean' ? req.body.archived : !video.isArchived;
    video.isArchived = next;
    video.archivedAt = next ? new Date() : null;

    // Archiving a pinned video quietly unpins it — pinned rows are only
    // useful on a visible profile grid, so keeping the flag while archived
    // creates a confusing "pinned but hidden" state.
    if (next && video.pinned) {
      video.pinned   = false;
      video.pinnedAt = null;
    }

    await video.save();

    return ok(res, {
      message: next ? 'Video archived' : 'Video restored',
      videoId: video._id,
      isArchived: video.isArchived,
      archivedAt: video.archivedAt,
    });
  } catch (err) {
    console.error('toggleArchive error:', err);
    return fail(res, 'Failed to change archive state', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ARCHIVED VIDEOS  (owner-only list)
// GET /api/videos/archived?page=1&limit=12
// ─────────────────────────────────────────────────────────────────────────────
exports.getArchivedVideos = async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 12, 50);
    const skip  = (page - 1) * limit;

    const filter = {
      userId:     req.user.id,
      status:     'active',
      isArchived: true,
    };

    const [videos, total] = await Promise.all([
      Video.find(filter)
        .sort({ archivedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Video.countDocuments(filter),
    ]);

    return ok(res, {
      videos,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getArchivedVideos error:', err);
    return fail(res, 'Failed to fetch archived videos', 500);
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

    // Cache-aside — same query text returns the same aggregation for 5 min.
    // Not invalidated on video upload (a slight staleness on very-fresh
    // videos is acceptable for a search suggestion list).
    const rows = await cache.withCache(kHashtag(q, limit), TTL.hashtag, async () => {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      return Video.aggregate([
        { $match: { status: 'active', visibility: 'public', isArchived: { $ne: true }, ...PUBLIC_REVIEW_FILTER, tags: { $exists: true, $ne: [] } } },
        { $unwind: '$tags' },
        { $project: { tag: { $toLower: '$tags' } } },
        { $match: { tag: re } },
        { $group: { _id: '$tag', videosCount: { $sum: 1 } } },
        { $sort: { videosCount: -1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 0, tag: '$_id', videosCount: 1 } },
      ]);
    });

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

    // Escape user input — a raw "(" would throw (500) and crafted patterns
    // enable ReDoS. Same escape as searchHashtags/searchUsers.
    const regex  = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const filter = {
      status: 'active', visibility: 'public', isArchived: { $ne: true }, ...PUBLIC_REVIEW_FILTER,
      $or: [{ title: regex }, { description: regex }, { tags: regex }],
    };
    if (category && category !== 'all') filter.category = category;

    // Privacy: private accounts the viewer doesn't follow + blocked pairs
    // never surface in search results (authed and anonymous alike).
    const excludedOwners = await privacy.contentExclusionsFor(req.user?.id || null);
    if (excludedOwners.length) filter.userId = { $nin: excludedOwners };

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
      // Hide-count strip applies to search results too.
      videos: videos.map((v) => withUserFlags(v, req.user?.id)),
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

    // Blocked pairs can't interact — either direction.
    if (await privacy.isBlockedBetween(req.user.id, video.userId)) {
      return fail(res, 'You cannot interact with this content.', 403);
    }

    const uid   = req.user.id;
    const liked = video.isLikedBy(uid);

    if (liked) {
      video.likes      = video.likes.filter(id => !id.equals(uid));
      video.likesCount = Math.max(video.likesCount - 1, 0);
    } else {
      video.likes.push(uid);
      video.likesCount += 1;

      // Notify the uploader (pref-gated + history row inside the center;
      // self-likes are filtered there too). Fire-and-forget.
      const notificationCenter = require('../services/notificationCenter');
      notificationCenter.notify(video.userId, 'likes', {
        title: `@${req.user.username} liked your video`,
        body:  video.title ? `"${String(video.title).slice(0, 80)}"` : '',
        fromUserId: uid,
        data: { videoId: video._id.toString(), type: 'like' },
      }).catch(() => {});
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

    // Blocked pairs can't interact — either direction.
    if (await privacy.isBlockedBetween(req.user.id, video.userId)) {
      return fail(res, 'You cannot interact with this content.', 403);
    }

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

    // Blocked pairs can't interact — either direction.
    if (await privacy.isBlockedBetween(req.user.id, video.userId)) {
      return fail(res, 'You cannot interact with this content.', 403);
    }

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

    const isOwner = req.user.id === String(targetUserId);

    // Privacy gate: blocked pairs and private accounts the viewer doesn't
    // follow get an empty grid with isPrivate:true — same response shape as
    // getUserVideos so the client's list/pagination handling never breaks.
    if (!isOwner) {
      const [owner, blocked] = await Promise.all([
        User.findById(targetUserId).select('followers preferences blockedUsers').lean(),
        privacy.isBlockedBetween(req.user.id, targetUserId),
      ]);
      if (blocked || !privacy.canViewContentOf(req.user.id, owner)) {
        return ok(res, {
          videos: [],
          isPrivate: true,
          pagination: { page, limit, total: 0, pages: 0 },
        });
      }
    }

    // Never surface reposts of creators whose content is hidden from the
    // viewer (private accounts they don't follow, blocked pairs).
    const excluded     = await privacy.contentExclusionsFor(req.user.id);
    const repostFilter = { userId: targetUserId, originalOwnerId: { $nin: excluded } };

    const [reposts, total] = await Promise.all([
      Repost.find(repostFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path:   'videoId',
          match:  { status: 'active', isArchived: { $ne: true }, ...(isOwner ? {} : { visibility: 'public', ...PUBLIC_REVIEW_FILTER }) },
          select: '-views -notInterested -reports -likes -saves -reposts -favorites',
          populate: { path: 'userId', select: 'username fullName profileImage' },
        })
        .lean(),
      Repost.countDocuments(repostFilter),
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

    // Blocked pairs can't interact — either direction.
    if (await privacy.isBlockedBetween(req.user.id, video.userId)) {
      return fail(res, 'You cannot interact with this content.', 403);
    }

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
    // The owner can always download their own reel — the allowDownload
    // toggle only gates other viewers.
    const isOwner = req.user?.id && video.userId.equals(req.user.id);
    if (!video.allowDownload && !isOwner) return fail(res, 'Downloads are disabled for this video', 403);

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
    // Try to buffer the counter in Redis first — if that succeeds, we skip
    // the Mongo $inc for this call. The flusher in services/counterBuffer.js
    // batches accumulated deltas into a single bulkWrite every 30 s.
    const counterBuffer = require('../services/counterBuffer');
    const buffered = await counterBuffer.bumpVideo(req.params.id, 'sharesCount', 1);

    // Either buffered → just read the current doc; or fallback → $inc live.
    const video = buffered
      ? await Video.findById(req.params.id)
      : await Video.findByIdAndUpdate(
          req.params.id,
          { $inc: { sharesCount: 1 } },
          { new: true },
        );
    if (!video || video.status === 'deleted') return fail(res, 'Video not found', 404);

    // Mirror to SharedVideo for the "My Activity → Shared Videos" list.
    // Not deduped — every share event is its own row (timeline-style).
    // Best-effort; we don't want a logging hiccup to fail the share itself.
    // Anonymous callers still bump the counter above but leave no history.
    if (req.user) {
      const platform = String(req.body?.platform || 'system_share').slice(0, 40);
      // Recipient when the video was shared into a chat — optional.
      const toUserId = mongoose.Types.ObjectId.isValid(req.body?.toUserId)
        ? req.body.toUserId
        : null;
      SharedVideo.create({
        userId:   req.user.id,
        videoId:  video._id,
        platform,
        toUserId,
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
    // Videos archived by their owner should also disappear from the current
    // user's saved / liked / favorite lists — the video is effectively
    // unavailable until the owner restores it.
    const query = { ...filter(req.user.id), status: 'active', isArchived: { $ne: true }, ...PUBLIC_REVIEW_FILTER };

    const [videos, total] = await Promise.all([
      Video.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'username fullName profileImage')
        .lean(),
      Video.countDocuments(query),
    ]);

    return ok(res, {
      // Saved/liked/favorites lists include other creators' videos, so the
      // hide-count strip applies here too.
      videos: videos.map((v) => withUserFlags(v, req.user?.id)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('collection error:', err);
    return fail(res, 'Failed to fetch videos', 500);
  }
};

exports.getSavedVideos    = buildCollection(uid => ({ saves:     uid }));
exports.getLikedVideos    = buildCollection(uid => ({ likes:     uid }));
exports.getFavoriteVideos = buildCollection(uid => ({ favorites: uid }));

// ─────────────────────────────────────────────────────────────────────────────
// SPEECH-TO-TEXT PIPELINE  (FFmpeg → Faster-Whisper → BART zero-shot → MongoDB)
//
// Runs after the existing ranking pass so it can never delay or race it. All
// writes are targeted $set updates on the transcription sub-document, so a
// concurrent save() elsewhere (e.g. createVideo's initial scoring) can't be
// clobbered and vice-versa.
//
// Never throws: a transcription outage must not affect the upload pipeline.
// ─────────────────────────────────────────────────────────────────────────────

// Zero-shot (BART) labels → the existing `aiCategory` enum. Only labels with a
// clean enum equivalent are mapped; "Poetry" has none, so it's intentionally
// left out (the transcript + confidence are still stored, just not adopted as
// the ranking category).
const TRANSCRIPT_CATEGORY_MAP = {
  educational:   'educational',
  technical:     'technical',
  professional:  'business',     // closest enum bucket for professional content
  news:          'news',
  entertainment: 'entertainment',
  islamic:       'islamic',
};

async function runTranscription(video) {
  if (!video?.videoUrl) return null;

  try {
    const res = await aiClient.transcribe(video.videoUrl, String(video._id));

    // aiClient degrades instead of throwing — `fallback` marks a failed call.
    if (res.fallback) {
      await Video.updateOne({ _id: video._id }, {
        $set: {
          'transcription.status': 'failed',
          'transcription.error':  String(res.error || 'AI service unavailable').slice(0, 300),
          'transcription.transcribedAt': new Date(),
        },
      });
      return null;
    }

    const empty = !!res.empty || !String(res.transcript || '').trim();

    // Persist the BART text-moderation decision so the "Decision Engine" stage
    // isn't dropped (ACCEPT / REVIEW / null-when-empty).
    const decision = empty ? null : (['ACCEPT', 'REVIEW'].includes(res.moderation) ? res.moderation : null);

    const set = {
      'transcription.text':             String(res.transcript || ''),
      'transcription.language':         String(res.language || ''),
      'transcription.category':         empty ? null : (res.category ?? null),
      'transcription.confidence':       empty ? 0 : Number(res.confidence) || 0,
      'transcription.moderation':       decision,
      'transcription.moderationReason': empty ? '' : String(res.moderation_reason || '').slice(0, 120),
      'transcription.processingTimeMs': Math.round((Number(res.processing_time) || 0) * 1000),
      'transcription.audioDuration':    Number(res.duration) || 0,
      'transcription.engine':           `faster-whisper:${process.env.WHISPER_MODEL || 'base'}`,
      'transcription.status':           empty ? 'empty' : 'done',
      'transcription.error':            '',
      'transcription.transcribedAt':    new Date(),
    };

    // Feed the recommendation engine: adopt the transcript-derived category
    // only when it maps cleanly AND nothing has classified this video yet
    // (never clobber a Gemini result).
    const mapped = TRANSCRIPT_CATEGORY_MAP[String(res.category || '').toLowerCase()];
    if (!empty && mapped && !video.aiCategory) {
      set.aiCategory   = mapped;
      set.aiAnalyzedAt = new Date();
    }

    await Video.updateOne({ _id: video._id }, { $set: set });

    console.log(`[transcription] video=${video._id} lang=${res.language || '?'} empty=${empty} category=${res.category ?? 'none'} confidence=${Number(res.confidence || 0).toFixed(4)} decision=${decision ?? 'none'} chars=${String(res.transcript || '').length}`);

    // ── CONTENT-BASED RE-MODERATION (spec #4) ──────────────────────────────
    // The synchronous upload check only saw TEXT metadata (title/desc/tags), so
    // an entertainment video with informative-sounding metadata can slip through
    // as "approved". Now that we have the SPOKEN content, re-run the SAME
    // classifier policy on the transcript. If the real content is Entertainment
    // (or any block category) at/above the block threshold, DOWNGRADE the video.
    // Rules: only ever make the decision STRICTER (approved → blocked/pending),
    // never looser; never override a human admin.
    if (!empty && res.category) {
      const { decideFromClassifier } = require('../services/moderationPolicy');
      const moderationService = require('../services/moderationService');
      const contentVerdict = decideFromClassifier({ category: res.category, confidence: res.confidence });
      const current = await Video.findById(video._id).select('reviewStatus review').lean();
      const decidedByAdmin = current?.review?.decidedBy === 'admin';
      const cur = current?.reviewStatus;

      console.log(`[moderation] transcript re-check video=${video._id} → decision=${contentVerdict.decision} category=${contentVerdict.category} confidence=${Number(contentVerdict.confidence).toFixed(4)} reason=${contentVerdict.reason} | current=${cur} admin=${decidedByAdmin}`);

      const upgrade  = ['pending_review', 'processing'].includes(cur) && contentVerdict.decision !== cur;
      const downgrade = cur === 'approved' && (contentVerdict.decision === 'blocked' || contentVerdict.decision === 'pending_review');

      if (!decidedByAdmin && (upgrade || downgrade)) {
        const fresh = await Video.findById(video._id);
        if (fresh) {
          const prev = fresh.reviewStatus;
          moderationService.applyVerdictToDoc(fresh, contentVerdict);
          await fresh.save();
          await moderationService.recordAutoDecision(fresh, contentVerdict).catch(() => {});
          invalidateFeed(); // visibility changed either way → refresh cached feeds
          if (contentVerdict.decision === 'approved') {
            console.log(`[feed] PUBLISHED (transcript) video=${video._id} ${prev} → approved (content=${res.category}); feeds/discover/foryou invalidated`);
          } else {
            console.log(`[moderation] transcript ${upgrade ? 'RESOLVED' : 'DOWNGRADED'} video=${video._id} ${prev} → ${contentVerdict.decision} (content=${res.category}); feeds invalidated`);
          }
        }
      }
    }

    return res;
  } catch (err) {
    console.error('runTranscription error:', err.message);
    await Video.updateOne({ _id: video._id }, {
      $set: {
        'transcription.status': 'failed',
        'transcription.error':  String(err.message || 'unknown').slice(0, 300),
        'transcription.transcribedAt': new Date(),
      },
    }).catch(() => {});
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECOVERY — resolve a video held ONLY because the AI was unavailable.
//
// Root-cause fix for "new uploads never leave pending_review". The synchronous
// upload check fails CLOSED when the AI service is unreachable (reason
// 'ai-unavailable') or when the metadata was low-confidence — and, previously,
// nothing ever re-evaluated that video, so it stayed hidden from every feed
// forever. This function re-runs the REAL BART classification and applies the
// resulting verdict, publishing (approved) or blocking (entertainment) based
// purely on the model output — no manual step, no hardcoded ids/categories.
//
// Safe by construction:
//   • only touches videos in a non-terminal AI state (pending_review/processing)
//   • never overrides an admin decision
//   • if the AI is STILL unavailable it leaves the video pending (a later
//     trigger — the async pass, the transcript pass, or the backfill route —
//     retries), so decisions are always AI-driven, never guessed.
// Returns the verdict applied, or null if it left the video unchanged.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveAutoModeration(video, { text, source = 'retry' } = {}) {
  try {
    if (!video) return null;
    const RECOVERABLE = ['pending_review', 'processing'];
    if (video.review?.decidedBy === 'admin') return null;      // never override a human
    if (!RECOVERABLE.includes(video.reviewStatus)) return null; // approved/blocked/rejected are terminal

    const modText = (text && text.trim())
      ? text.trim().slice(0, 2000)
      : [video.title, video.description, (video.tags || []).join(' ')].filter(Boolean).join('. ').slice(0, 2000);
    if (!modText) return null;

    const { decideFromClassifier } = require('../services/moderationPolicy');
    const moderationService        = require('../services/moderationService');

    console.log(`[moderation] recovery attempt video=${video._id} source=${source} current=${video.reviewStatus} chars=${modText.length}`);
    const pred = await aiClient.predict(modText);
    if (pred?.fallback) {
      console.log(`[moderation] recovery SKIPPED video=${video._id} — AI still unavailable (${pred.error || 'no service'}); stays ${video.reviewStatus}`);
      return null; // AI down → leave pending; another trigger retries later
    }

    const verdict = decideFromClassifier({ category: pred?.category, confidence: pred?.confidence });
    console.log(`[moderation] recovery classified video=${video._id} → category=${verdict.category} confidence=${Number(verdict.confidence).toFixed(4)} decision=${verdict.decision} reason=${verdict.reason}`);

    const prev = video.reviewStatus;
    moderationService.applyVerdictToDoc(video, verdict);
    await video.save();

    if (verdict.decision === prev) {
      console.log(`[moderation] recovery video=${video._id} remains ${verdict.decision} (genuinely uncertain); refreshed confidence`);
      return verdict;
    }

    await moderationService.recordAutoDecision(video, verdict).catch(() => {});
    if (verdict.decision === 'approved') {
      invalidateFeed(); // publish everywhere at once (feed + discover + foryou pools)
      console.log(`[feed] PUBLISHED (recovery/${source}) video=${video._id} ${prev} → approved; feeds/discover/foryou invalidated → visible to everyone`);
    } else {
      console.log(`[moderation] recovery video=${video._id} ${prev} → ${verdict.decision} (${verdict.reason})`);
    }
    return verdict;
  } catch (e) {
    console.error('resolveAutoModeration error:', e.message);
    return null;
  }
}

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
    console.log(`[recommendation] video=${video._id} ranking updated rankingScore=${Number(video.rankingScore || 0).toFixed(3)} informativeScore=${video.informativeScore} aiCategory=${video.aiCategory || 'n/a'}`);

    // ── RECOVERY (root-cause fix) ──────────────────────────────────────────
    // If the synchronous upload decision failed closed (AI was unavailable) or
    // was low-confidence, the video is stuck in pending_review and hidden from
    // every feed. Re-run the REAL classification now and publish/block on the
    // model's output. No-op for already approved/blocked/admin-decided videos.
    await resolveAutoModeration(video, { source: 'post-upload' }).catch((e) =>
      console.error('resolveAutoModeration(post-upload) error:', e.message));

    return scores;
  } catch (err) {
    console.error('runContentAnalysis error:', err.message);
    return null;
  } finally {
    // Speech-to-text runs in its OWN error boundary, decoupled from the ranking
    // save above — so a scoreVideo/save() failure can never skip transcription
    // (and vice-versa). It writes only its own transcription sub-document.
    await runTranscription(video).catch((e) =>
      console.error('runTranscription error:', e.message));
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
    if (!req.admin && req.user?.role !== 'admin') return fail(res, 'Admin only', 403);

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

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — re-moderate every video stuck in pending_review / processing
// POST /api/videos/admin/remoderate-pending
//
// Recovery backfill: resolves videos that were held ONLY because the AI service
// was unavailable at upload time (reason 'ai-unavailable') or were low-confidence.
// Re-runs the REAL classification on each and publishes/blocks on the model's
// output. Run this once after (re)starting the AI service to un-stick any
// already-uploaded videos. Idempotent; never touches admin-decided videos.
// ─────────────────────────────────────────────────────────────────────────────
exports.remoderatePending = async (req, res) => {
  try {
    if (!req.admin && req.user?.role !== 'admin') return fail(res, 'Admin only', 403);

    const videos = await Video.find({
      status: 'active',
      reviewStatus: { $in: ['pending_review', 'processing'] },
      'review.decidedBy': { $ne: 'admin' },
    });

    console.log(`[backfill] remoderate-pending: ${videos.length} candidate videos`);
    let approved = 0, blocked = 0, stillPending = 0, skipped = 0;
    for (const v of videos) {
      const verdict = await resolveAutoModeration(v, { source: 'backfill' });
      if (!verdict)                             skipped++;
      else if (verdict.decision === 'approved') approved++;
      else if (verdict.decision === 'blocked')  blocked++;
      else                                       stillPending++;
    }
    console.log(`[backfill] done: approved=${approved} blocked=${blocked} stillPending=${stillPending} skipped=${skipped}`);

    return ok(res, {
      message: `Re-moderated ${videos.length} pending video(s)`,
      total: videos.length, approved, blocked, stillPending, skipped,
    });
  } catch (err) {
    console.error('remoderatePending error:', err);
    return fail(res, 'Re-moderation failed', 500);
  }
};
