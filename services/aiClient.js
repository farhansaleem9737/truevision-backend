// Backend/services/aiClient.js
//
// Thin HTTP wrapper around the Python FastAPI AI microservice. Every call
// returns the FastAPI body on success; on failure it returns a sensible
// fallback so the caller can keep going (the spec is "uploads must never
// be blocked by an AI outage").
//
// The Node controllers/routes import this module — they never see the
// underlying HTTP library or the FastAPI URL directly.
//
// We use Node 18+'s built-in `fetch` instead of axios so we don't add a new
// dependency just for this client.
//
// Env vars (set in Backend/.env):
//   AI_SERVICE_URL  — base URL of the FastAPI service. Default http://localhost:8001
//   AI_API_KEY      — optional shared secret; must match FastAPI's AI_API_KEY

const BASE_URL = (process.env.AI_SERVICE_URL || 'http://localhost:8001').replace(/\/$/, '');
const API_KEY  = process.env.AI_API_KEY || '';
const TIMEOUT_MS = 30_000; // long enough for first-time model loads

// Transcription is far slower than the other calls: FFmpeg audio extraction +
// Whisper inference runs roughly 0.3–1x realtime on CPU, and the very first
// call may also download the `base` weights (~140 MB). Give it its own budget.
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.AI_TRANSCRIBE_TIMEOUT_MS) || 300_000;

// Helper: fetch with timeout via AbortController.
const fetchJson = async (method, path, body) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (API_KEY) headers['X-API-Key'] = API_KEY;
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`non-JSON response: ${text.slice(0, 200)}`); }
    if (!res.ok) {
      const detail = data?.detail || data?.message || `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
};

// Helper: POST multipart/form-data. Used by /transcribe, which is declared
// with FastAPI `File`/`Form` params so it can accept either a raw video upload
// or a video_url. We let fetch set the multipart boundary itself — setting
// Content-Type manually would omit it and FastAPI would reject the body.
const fetchForm = async (path, fields, timeoutMs = TIMEOUT_MS) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    const headers = {};
    if (API_KEY) headers['X-API-Key'] = API_KEY;
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: form,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`non-JSON response: ${text.slice(0, 200)}`); }
    if (!res.ok) {
      throw new Error(data?.detail || data?.message || `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
};

// Helper: call `fn`, log + return `fallback` on any error.
const safeCall = async (label, fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`[aiClient] ${label} failed:`, err.message);
    return { ...fallback, fallback: true, error: err.message };
  }
};

// ── /predict ────────────────────────────────────────────────────────────────
const predict = (text) =>
  safeCall(
    'predict',
    () => fetchJson('POST', '/predict', { text }),
    { category: 'Entertainment', confidence: 0, all_scores: {} },
  );

// ── /recommend ──────────────────────────────────────────────────────────────
//
// `payload` shape:
//   {
//     candidates: [{ video_id, title, description, tags, category,
//                    educational_score, watch_time_avg, likes, views,
//                    age_hours }],
//     user:       { interests, watch_history_categories },
//     educational_weight?: number,
//   }
const recommend = (payload) =>
  safeCall(
    'recommend',
    () => fetchJson('POST', '/recommend', payload),
    { items: [] },
  );

// ── /moderate ───────────────────────────────────────────────────────────────
//
// Pass `{ image_url: '...' }` for a single image, or
//      `{ image_urls: ['...', '...'] }` for video frames.
const moderate = (payload) =>
  safeCall(
    'moderate',
    () => fetchJson('POST', '/moderate', payload),
    { status: 'SAFE', confidence: 0, detections: [] },
  );

// ── /chatbot ────────────────────────────────────────────────────────────────
//
// `history` is optional — pass an array of { role: 'user' | 'bot', text }.
const chat = (message, history = []) =>
  safeCall(
    'chatbot',
    () => fetchJson('POST', '/chatbot', { message, history }),
    {
      answer: 'The assistant is offline right now. Please try again in a moment.',
      matched_question: null,
      confidence: 0,
    },
  );

// ── /transcribe ─────────────────────────────────────────────────────────────
//
// Full speech pipeline in one call: the AI service downloads the video, pulls
// the audio with FFmpeg, transcribes it with Faster-Whisper, then feeds the
// transcript to the SAME DistilBERT classifier /predict uses.
//
// Returns: { transcript, category, confidence, all_scores, language,
//            duration, processing_time, empty, segments }
//
// Like every other call here it degrades instead of throwing — a transcription
// outage must never break the upload pipeline.
const transcribe = (videoUrl, videoId) =>
  safeCall(
    'transcribe',
    () => fetchForm('/transcribe', { video_url: videoUrl, video_id: videoId }, TRANSCRIBE_TIMEOUT_MS),
    {
      transcript: '', category: null, confidence: 0, all_scores: {},
      language: '', duration: 0, processing_time: 0, empty: true, segments: [],
    },
  );

// ── /health ─────────────────────────────────────────────────────────────────
const health = () =>
  safeCall(
    'health',
    () => fetchJson('GET', '/health'),
    { status: 'down' },
  );

module.exports = { predict, recommend, moderate, chat, transcribe, health };
