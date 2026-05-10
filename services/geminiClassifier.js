// Backend/services/geminiClassifier.js
//
// Wraps Google's Gemini API to classify a video into a content category and
// return an "informative" rating from 1–10. Returns null on any failure so
// the caller can fall back to the deterministic tag-based scoring in
// services/contentRanking.js — the system never blocks on AI being available.
//
// Usage:
//   const ai = await classifyContent({ title, description, tags });
//   if (ai) { video.aiCategory = ai.category; video.informativeScore = ai.informativeScore; }

const MODEL    = 'gemini-1.5-flash';   // cheap + fast; swap to gemini-1.5-pro for higher quality
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 12000;

const VALID_CATEGORIES = new Set([
  'technical', 'educational', 'business', 'finance', 'motivational',
  'news', 'islamic', 'entertainment', 'music', 'other',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Prompt — strict JSON contract. Few-shot examples teach Gemini to ignore
// playful entertainment prompts and stay in the educational frame.
// ─────────────────────────────────────────────────────────────────────────────
const buildPrompt = ({ title = '', description = '', tags = [] }) => `
You are classifying a short-form video for an educational/informative content platform.

Title:       ${title}
Description: ${description}
Tags:        ${(tags || []).join(', ') || '(none)'}

Classify this content. Respond with ONLY a JSON object — no markdown, no commentary, no code fences:
{
  "category": "<one of: technical, educational, business, finance, motivational, news, islamic, entertainment, music, other>",
  "informativeScore": <integer 1-10 measuring how informative/educational the content is>,
  "reason": "<one short sentence>"
}

Few-shot examples:
- Coding tutorial:     {"category":"technical","informativeScore":9,"reason":"hands-on programming tutorial"}
- Music video:         {"category":"music","informativeScore":1,"reason":"musical performance, no learning value"}
- Motivational speech: {"category":"motivational","informativeScore":7,"reason":"thought-provoking and skill-building"}
- Cooking vlog:        {"category":"entertainment","informativeScore":3,"reason":"casual, light-skill content"}
- AI explainer:        {"category":"technical","informativeScore":10,"reason":"deep AI/ML explainer"}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Robust JSON extractor — Gemini sometimes wraps in code fences despite the
// instruction. Strip fences then locate the first {...} block.
// ─────────────────────────────────────────────────────────────────────────────
const extractJson = (text) => {
  if (!text) return null;
  // Strip ```json ... ``` and ``` ... ``` wrappers
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
};

const validate = (obj) => {
  if (!obj || typeof obj !== 'object') return null;
  let category = String(obj.category || '').toLowerCase().trim();
  if (!VALID_CATEGORIES.has(category)) category = 'other';

  let score = Number(obj.informativeScore);
  if (!Number.isFinite(score)) return null;
  score = Math.max(1, Math.min(10, Math.round(score)));

  return {
    category,
    informativeScore: score,
    reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : '',
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
const classifyContent = async ({ title, description, tags } = {}) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('[geminiClassifier] GEMINI_API_KEY not set — skipping AI analysis');
    return null;
  }

  const url = `${ENDPOINT}?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt({ title, description, tags }) }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 200,
      responseMimeType: 'application/json',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200);
      console.error(`[geminiClassifier] HTTP ${res.status} ${snippet}`);
      return null;
    }

    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = validate(extractJson(text));
    if (!parsed) {
      console.warn('[geminiClassifier] could not parse Gemini response:', String(text || '').slice(0, 200));
      return null;
    }

    console.log(`[geminiClassifier] "${(title || '').slice(0, 40)}…" → ${parsed.category} / ${parsed.informativeScore}`);
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') console.error('[geminiClassifier] timeout');
    else                            console.error('[geminiClassifier] error:', err.message);
    return null;
  }
};

module.exports = { classifyContent };
