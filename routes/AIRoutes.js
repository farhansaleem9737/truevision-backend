// Backend/routes/AIRoutes.js
//
// Public-facing AI endpoints. Each route is a thin auth-protected proxy to
// the FastAPI service via aiClient. Mounted under /api/ai/* in server.js.
//
// The route layer keeps responsibility for:
//   • JWT auth (so the FastAPI service stays internal)
//   • Request validation / shaping
//   • Standardising the response envelope ({ success, ... })
//
// FastAPI keeps responsibility for the actual ML work.

const express   = require('express');
const router    = express.Router();
const { protect } = require('../middleware/Auth');
const ai        = require('../services/aiClient');

// ── /health — open, useful for ops dashboards ───────────────────────────────
router.get('/health', async (req, res) => {
  const data = await ai.health();
  return res.json({ success: true, ai: data });
});

// ── /predict — classify a snippet of text into one of four categories ──────
//   Body: { text: string }
router.post('/predict', protect, async (req, res) => {
  const text = (req.body?.text || '').toString();
  if (!text.trim()) {
    return res.status(400).json({ success: false, message: 'text is required' });
  }
  const data = await ai.predict(text);
  return res.json({ success: true, ...data });
});

// ── /recommend — re-rank a batch of candidate videos ───────────────────────
//   Body: { candidates: [...], user?: {...}, educational_weight?: number }
router.post('/recommend', protect, async (req, res) => {
  const { candidates, user, educational_weight } = req.body || {};
  if (!Array.isArray(candidates) || !candidates.length) {
    return res.status(400).json({ success: false, message: 'candidates[] is required' });
  }
  const data = await ai.recommend({ candidates, user, educational_weight });
  return res.json({ success: true, ...data });
});

// ── /moderate — NudeNet check for one image or a list of video frames ──────
//   Body: { image_url?: string, image_urls?: string[] }
router.post('/moderate', protect, async (req, res) => {
  const { image_url, image_urls } = req.body || {};
  if (!image_url && !(Array.isArray(image_urls) && image_urls.length)) {
    return res.status(400).json({ success: false, message: 'image_url or image_urls is required' });
  }
  const data = await ai.moderate({ image_url, image_urls });
  return res.json({ success: true, ...data });
});

// ── /chatbot — FAQ retrieval ───────────────────────────────────────────────
//   Body: { message: string, history?: [{ role, text }] }
router.post('/chatbot', protect, async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ success: false, message: 'message is required' });
  }
  const data = await ai.chat(message, Array.isArray(history) ? history : []);
  return res.json({ success: true, ...data });
});

module.exports = router;
