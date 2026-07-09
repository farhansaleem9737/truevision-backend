// Backend/middleware/upload.js
const multer     = require('multer');
const cloudinary = require('../config/cloudinary');

// ── Multer: hold file in memory, then stream to Cloudinary ───────────────────
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('video/')) return cb(null, true);
  cb(new Error('Only video files are allowed (mp4, mov, avi, webm…)'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB hard limit
});

// ── Quality definitions (used for on-demand URL construction) ─────────────────
const QUALITY_LADDER = [
  { label: '144p',  width: 256,  height: 144  },
  { label: '240p',  width: 426,  height: 240  },
  { label: '360p',  width: 640,  height: 360  },
  { label: '480p',  width: 854,  height: 480  },
  { label: '720p',  width: 1280, height: 720  },
];

// ── Upload a Buffer to Cloudinary ─────────────────────────────────────────────
// No eager transforms — the main video is capped at 720p via transformation.
// Quality variant URLs are constructed on-demand by buildQualityUrls() below.
// This makes uploads complete in seconds instead of minutes.
const uploadToCloudinary = (buffer, extraOptions = {}) => {
  return new Promise((resolve, reject) => {
    const options = {
      resource_type: 'video',
      // Hard cap: any video above 720p is automatically downscaled at storage time
      transformation: [{ width: 1280, height: 720, crop: 'limit', quality: 'auto' }],
      // No eager transforms here — avoids multi-minute server wait
      ...extraOptions,
    };

    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });

    stream.end(buffer);
  });
};

// ── Build a single transformation option object for a given rung. ────────────
// Exported so the eager-transformation string signed at upload time can be
// built from the SAME shape — Cloudinary caches derived files by
// transformation string, so any drift between eager and URL-generated
// transforms would cause a costly re-transcode on first playback (which is
// exactly the bug we're preventing).
const qualityTransform = ({ width, height }) => ({
  width, height,
  crop:        'limit',
  quality:     'auto',
  video_codec: 'auto',
  format:      'mp4',
});

// ── Build quality variant URLs from a Cloudinary public_id ───────────────────
// URLs match the eager-transform strings signed at upload time. On the first
// playback request Cloudinary serves the derived file that was pre-generated
// (or fast-tracks it if the async eager job hasn't quite finished).
const buildQualityUrls = (publicId) => {
  const urls = {};
  QUALITY_LADDER.forEach((rung) => {
    urls[rung.label] = cloudinary.url(publicId, {
      resource_type:  'video',
      secure:         true,
      transformation: [qualityTransform(rung)],
    });
  });
  return urls;
};

// ── Build the eager transformation string to sign at upload time ────────────
//
// Cloudinary starts transcoding as part of the upload response. With
// `eager_async: true` the upload returns quickly and the transform runs in
// the background; the response STILL contains the eager URL, and by the
// time our /videos/create controller finishes moderating + saving the DB
// record, Cloudinary is typically done.
//
// The result: the FIRST playback request from a mobile player is served by
// the pre-existing derived asset — no on-demand transcode wait. This is the
// exact WhatsApp / Reels pattern for direct-upload flows.
//
// Which rungs to eager? We pick 720p + 360p:
//   720p → the primary URL the player uses on Wi-Fi/4G
//   360p → the fallback for data-saver + our slow-network resilience path
// Larger rungs are still generated lazily on demand — they don't matter for
// first-play, so paying the eager cost for them wastes uploader wall-time.
const EAGER_RUNGS = ['720p', '360p'];

const buildEagerString = () => {
  const transforms = EAGER_RUNGS
    .map((label) => QUALITY_LADDER.find((r) => r.label === label))
    .filter(Boolean)
    .map((rung) => cloudinary.utils.generate_transformation_string(qualityTransform(rung)));
  return transforms.join('|');
};

// ── Build a thumbnail URL from a public_id (frame at 2 seconds) ──────────────
const buildThumbnailUrl = (publicId) =>
  cloudinary.url(publicId, {
    resource_type:  'video',
    secure:         true,
    format:         'jpg',
    transformation: [{ start_offset: '2', width: 480, height: 854, crop: 'fill', quality: 'auto' }],
  });

// ── Delete an asset from Cloudinary ──────────────────────────────────────────
const deleteFromCloudinary = (publicId, resourceType = 'video') =>
  cloudinary.uploader.destroy(publicId, { resource_type: resourceType });

module.exports = {
  upload,
  uploadToCloudinary,
  deleteFromCloudinary,
  buildQualityUrls,
  buildThumbnailUrl,
  buildEagerString,
  QUALITY_LADDER,
  EAGER_RUNGS,
};
