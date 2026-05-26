// Backend/services/nsfwModeration.js
//
// NSFW moderation using the NudeNet detector (notAI-tech/NudeNet) running
// locally inside this Node.js process via onnxruntime-node. No Python, no
// external API, no extra services.
//
//   Image flow: fetch URL → sharp letterbox preprocess → ONNX inference
//                → parse YOLOv8 outputs → map labels to SAFE/NSFW/PORN
//
//   Video flow: build N Cloudinary frame URLs (URL-based transform, no ffmpeg
//                needed) → classify each in parallel → worst frame wins.
//
// Failure mode (per spec): any error → return SAFE with `fallback: true`,
// log internally — uploads must never be blocked by moderation outages.
//
// Model:
//   The NudeNet detector ONNX file is ~80 MB and auto-downloads on first use
//   to `Backend/models/nudenet/{filename}.onnx`. Override via env:
//     NSFW_MODEL_URL   — where to download from
//     NSFW_MODEL_PATH  — where to cache the file locally
//     NSFW_INPUT_SIZE  — model input size (320 for 320n, 640 for 640m)
//
// NudeNet labels (18 classes — output order matches the model's training
// labels). The detector returns YOLOv8-style raw outputs: shape
// [1, 4 + numClasses, numAnchors] = [1, 22, 8400] for the 320n model.

const path = require('path');
const fs   = require('fs');
const fsp  = require('fs/promises');
const cloudinary = require('../config/cloudinary');

// ── Config ───────────────────────────────────────────────────────────────────
const ENABLED         = String(process.env.NSFW_MODERATION_ENABLED ?? 'true') === 'true';
const FRAME_COUNT     = Math.max(1, Math.min(10, Number(process.env.NSFW_FRAMES ?? 5)));
const REQUEST_TIMEOUT = Number(process.env.NSFW_TIMEOUT_MS ?? 30000);

const MODEL_URL  = process.env.NSFW_MODEL_URL  ||
  'https://huggingface.co/vladmandic/nudenet/resolve/main/nudenet.onnx';
const MODEL_PATH = process.env.NSFW_MODEL_PATH ||
  path.join(__dirname, '..', 'models', 'nudenet', 'nudenet.onnx');
const INPUT_SIZE = Number(process.env.NSFW_INPUT_SIZE ?? 320);

// Detection threshold (a label is "present" if any anchor scores above this).
const SCORE_THRESHOLD = Number(process.env.NSFW_SCORE_THRESHOLD ?? 0.30);

// NudeNet label list (order = class id 0..17).
const LABELS = [
  'FEMALE_GENITALIA_COVERED',
  'FACE_FEMALE',
  'BUTTOCKS_EXPOSED',
  'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_BREAST_EXPOSED',
  'ANUS_EXPOSED',
  'FEET_EXPOSED',
  'BELLY_COVERED',
  'FEET_COVERED',
  'ARMPITS_COVERED',
  'ARMPITS_EXPOSED',
  'FACE_MALE',
  'BELLY_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
  'ANUS_COVERED',
  'FEMALE_BREAST_COVERED',
  'BUTTOCKS_COVERED',
];

// Severity buckets. Anything in PORN_LABELS is hard-block territory; the
// NSFW_LABELS set is "explicit-but-not-pornographic" exposure.
const PORN_LABELS = new Set([
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
  'ANUS_EXPOSED',
]);
const NSFW_LABELS = new Set([
  'FEMALE_BREAST_EXPOSED',
  'BUTTOCKS_EXPOSED',
]);

// ── Lazy module loading ──────────────────────────────────────────────────────
// onnxruntime-node + sharp are heavy native deps; only require them if
// moderation is enabled and only on first use. Lets the server boot fast.
let _ort     = null;
let _sharp   = null;
let _session = null;
let _initPromise  = null;
let _initFailed   = false;

const lazyOrt   = () => (_ort   ||= require('onnxruntime-node'));
const lazySharp = () => (_sharp ||= require('sharp'));

// ── Helpers ──────────────────────────────────────────────────────────────────
const safeFallback = (reason) => ({
  status:     'SAFE',
  confidence: 0,
  fallback:   true,
  reason,
});

const fetchWithTimeout = async (url, options = {}, ms = REQUEST_TIMEOUT) => {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
};

// ── Model bootstrap ──────────────────────────────────────────────────────────
// Downloads the ONNX file on first use if it isn't on disk yet. Idempotent.
async function ensureModel() {
  try {
    await fsp.access(MODEL_PATH, fs.constants.R_OK);
    return;
  } catch {
    // not present — download
  }
  await fsp.mkdir(path.dirname(MODEL_PATH), { recursive: true });
  console.log(`[nsfwModeration] Downloading NudeNet model …  ${MODEL_URL}`);
  const res = await fetchWithTimeout(MODEL_URL, {}, 5 * 60_000);
  if (!res.ok) throw new Error(`Model download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(MODEL_PATH, buf);
  console.log(`[nsfwModeration] Model cached at ${MODEL_PATH} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

async function initSession() {
  if (_session)     return _session;
  if (_initFailed)  throw new Error('moderation init previously failed');
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const ort = lazyOrt();
      // Warm up sharp early so any libvips issues surface immediately
      lazySharp();
      await ensureModel();
      _session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      console.log('[nsfwModeration] ONNX session ready. Inputs:', _session.inputNames, 'Outputs:', _session.outputNames);
      return _session;
    } catch (err) {
      _initFailed  = true;
      _initPromise = null;
      console.error('[nsfwModeration] init failed:', err.message);
      throw err;
    }
  })();
  return _initPromise;
}

// ── Preprocess: letterbox to INPUT_SIZE x INPUT_SIZE, RGB, normalized 0..1 ──
// YOLOv8 expects CHW float32 tensors.
async function preprocess(imageBuffer) {
  const sharp = lazySharp();
  const ort   = lazyOrt();

  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width  || INPUT_SIZE;
  const h = meta.height || INPUT_SIZE;

  const scale = Math.min(INPUT_SIZE / w, INPUT_SIZE / h);
  const newW  = Math.max(1, Math.round(w * scale));
  const newH  = Math.max(1, Math.round(h * scale));
  const padW  = INPUT_SIZE - newW;
  const padH  = INPUT_SIZE - newH;

  const raw = await sharp(imageBuffer)
    .removeAlpha()
    .resize(newW, newH, { fit: 'fill' })
    .extend({
      top:    Math.floor(padH / 2),
      bottom: Math.ceil(padH / 2),
      left:   Math.floor(padW / 2),
      right:  Math.ceil(padW / 2),
      background: { r: 114, g: 114, b: 114 }, // YOLO-standard grey pad
    })
    .raw()
    .toBuffer(); // HWC uint8

  const N   = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    out[i]         = raw[i * 3]     / 255; // R plane
    out[i + N]     = raw[i * 3 + 1] / 255; // G plane
    out[i + 2 * N] = raw[i * 3 + 2] / 255; // B plane
  }
  return new ort.Tensor('float32', out, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

// ── Parse YOLOv8 raw output → max score per class ────────────────────────────
// Handles both common output layouts:
//   • [1, 4 + numClasses, numAnchors]   — standard YOLOv8 raw
//   • [1, numAnchors, 4 + numClasses]   — transposed export
// We don't need exact boxes for classification, just the max class score.
function parseOutput(tensor) {
  const data = tensor.data;
  const dims = tensor.dims;
  if (dims.length !== 3) {
    throw new Error(`unexpected output dims: ${dims.join('x')}`);
  }
  const numClasses = LABELS.length;
  const expectedStride = 4 + numClasses; // 22

  // Decide layout: which axis equals 22?
  let numAnchors, stride, transposed;
  if (dims[1] === expectedStride) {
    stride     = dims[1];
    numAnchors = dims[2];
    transposed = false;            // [1, 22, A]
  } else if (dims[2] === expectedStride) {
    stride     = dims[2];
    numAnchors = dims[1];
    transposed = true;             // [1, A, 22]
  } else {
    throw new Error(`output has no axis equal to ${expectedStride} (got ${dims.join('x')})`);
  }

  const maxScores = new Array(numClasses).fill(0);

  for (let c = 0; c < numClasses; c++) {
    const channel = 4 + c;
    let best = 0;
    if (transposed) {
      for (let a = 0; a < numAnchors; a++) {
        const v = data[a * stride + channel];
        if (v > best) best = v;
      }
    } else {
      const base = channel * numAnchors;
      for (let a = 0; a < numAnchors; a++) {
        const v = data[base + a];
        if (v > best) best = v;
      }
    }
    maxScores[c] = best;
  }
  return maxScores;
}

// Map per-class max scores → {status, confidence}
function classifyScores(maxScores) {
  let pornScore = 0, pornLabel = null;
  let nsfwScore = 0, nsfwLabel = null;
  let maxExposed = 0;

  for (let i = 0; i < LABELS.length; i++) {
    const label = LABELS[i];
    const score = maxScores[i];
    if (score < SCORE_THRESHOLD) continue;

    if (PORN_LABELS.has(label)) {
      if (score > pornScore) { pornScore = score; pornLabel = label; }
      if (score > maxExposed) maxExposed = score;
    } else if (NSFW_LABELS.has(label)) {
      if (score > nsfwScore) { nsfwScore = score; nsfwLabel = label; }
      if (score > maxExposed) maxExposed = score;
    }
  }

  if (pornScore > 0) {
    return { status: 'PORN', confidence: pornScore, label: pornLabel };
  }
  if (nsfwScore > 0) {
    return { status: 'NSFW', confidence: nsfwScore, label: nsfwLabel };
  }
  // SAFE — confidence is "how confidently safe": higher when no exposed
  // detections came near the threshold.
  return { status: 'SAFE', confidence: Math.max(0, 1 - maxExposed) };
}

// ── Public: classify a single image URL ──────────────────────────────────────
async function classifyImageUrl(imageUrl) {
  if (!ENABLED)  return safeFallback('moderation_disabled');
  if (!imageUrl) return safeFallback('missing_url');

  try {
    const session = await initSession();

    const imgRes = await fetchWithTimeout(imageUrl);
    if (!imgRes.ok) throw new Error(`image fetch ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());

    const input = await preprocess(buf);
    const feeds = { [session.inputNames[0]]: input };
    const out   = await session.run(feeds);
    const tensor = out[session.outputNames[0]];

    const scores = parseOutput(tensor);
    return classifyScores(scores);
  } catch (err) {
    console.error('[nsfwModeration] classifyImageUrl failed:', err.message);
    return safeFallback(err.message);
  }
}

// ── Build N Cloudinary frame URLs evenly across the duration ─────────────────
function buildFrameUrls(publicId, duration) {
  const dur = Number(duration) > 0 ? Number(duration) : 10;
  const offsets = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const pct = (i + 1) / (FRAME_COUNT + 1);
    offsets.push(Math.max(0.1, Math.min(dur - 0.1, dur * pct)));
  }
  return offsets.map((seconds) =>
    cloudinary.url(publicId, {
      resource_type:  'video',
      secure:         true,
      format:         'jpg',
      transformation: [{
        start_offset: seconds.toFixed(2),
        width:        320,
        height:       240,
        crop:         'fill',
        quality:      'auto',
      }],
    }),
  );
}

// ── Public: classify a Cloudinary-hosted video by sampling frames ────────────
async function classifyCloudinaryVideo({ publicId, duration }) {
  if (!ENABLED)  return safeFallback('moderation_disabled');
  if (!publicId) return safeFallback('missing_publicId');

  const urls    = buildFrameUrls(publicId, duration);
  const results = await Promise.all(urls.map((u) => classifyImageUrl(u)));

  // Pick the worst frame. PORN > NSFW > SAFE; within the same bucket the
  // higher confidence wins.
  const rank = { SAFE: 0, NSFW: 1, PORN: 2 };
  let worst  = results[0];
  for (const r of results) {
    if (rank[r.status] > rank[worst.status]) worst = r;
    else if (r.status === worst.status && r.confidence > worst.confidence) worst = r;
  }

  // If every frame fell back to SAFE due to an error, mark the aggregate
  // result as a fallback so the caller can log it.
  const allFallback = results.every((r) => r.fallback);

  return {
    status:     worst.status,
    confidence: Number((worst.confidence || 0).toFixed(3)),
    ...(allFallback ? { fallback: true } : {}),
    details: {
      frames: results.map((r, i) => ({
        url:        urls[i],
        status:     r.status,
        confidence: Number((r.confidence || 0).toFixed(3)),
        ...(r.label    ? { label:    r.label }    : {}),
        ...(r.fallback ? { fallback: true }       : {}),
      })),
    },
  };
}

module.exports = {
  classifyImageUrl,
  classifyCloudinaryVideo,
  // Test hooks
  _internals: { classifyScores, parseOutput, buildFrameUrls, LABELS, PORN_LABELS, NSFW_LABELS },
};
