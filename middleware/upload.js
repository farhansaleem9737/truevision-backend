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

// ── Build quality variant URLs from a Cloudinary public_id ───────────────────
// Cloudinary generates these lazily on first request, then caches them.
// No need to wait for eager transforms at upload time.
const buildQualityUrls = (publicId) => {
  const urls = {};
  QUALITY_LADDER.forEach(({ label, width, height }) => {
    urls[label] = cloudinary.url(publicId, {
      resource_type:  'video',
      secure:         true,
      transformation: [{ width, height, crop: 'limit', format: 'mp4', video_codec: 'auto', quality: 'auto' }],
    });
  });
  return urls;
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
  QUALITY_LADDER,
};
