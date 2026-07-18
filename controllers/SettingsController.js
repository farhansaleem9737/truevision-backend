// Backend/controllers/SettingsController.js
//
// Account-level app settings that live as first-class User fields (not inside
// the free-form preferences blob). Currently: UI language.
//
// The language field is the single source of truth the mobile i18n system
// restores on login. We also mirror it into preferences.language so any older
// client still reading the blob stays consistent — but this controller always
// treats the top-level `user.language` as canonical.

const User = require('../models/User');
const cache = require('../services/cache');
const feedCache = require('../services/feedCache');

const ok   = (res, data, code = 200) => res.status(code).json({ success: true,  ...data });
const fail = (res, msg,  code = 400) => res.status(code).json({ success: false, message: msg });

// Keep in lockstep with the enum in models/User.js and the client languages
// registry (truevision/i18n/languages.js). Adding a language = add its code
// here + to the model enum + drop in a locale JSON on the client.
const SUPPORTED = ['en', 'ur', 'ar', 'hi', 'tr', 'fr'];
const DEFAULT_LANGUAGE = 'en';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/settings/language
// Returns the caller's saved language (falls back to 'en').
// ─────────────────────────────────────────────────────────────────────────────
exports.getLanguage = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('language').lean();
    if (!user) return fail(res, 'User not found', 404);
    const language = SUPPORTED.includes(user.language) ? user.language : DEFAULT_LANGUAGE;
    return ok(res, { language, supported: SUPPORTED });
  } catch (err) {
    console.error('getLanguage error:', err);
    return fail(res, 'Failed to fetch language', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/settings/language   Body: { language: 'en' | 'ur' | ... }
// Validates against the allowlist, persists to the canonical field, and mirrors
// into preferences.language. Ownership is implicit — a user can only ever write
// their own row (req.user.id from the JWT).
// ─────────────────────────────────────────────────────────────────────────────
exports.updateLanguage = async (req, res) => {
  try {
    const language = String(req.body?.language || '').trim().toLowerCase();
    if (!language)                    return fail(res, 'language is required');
    if (!SUPPORTED.includes(language)) {
      return fail(res, `Unsupported language "${language}". Allowed: ${SUPPORTED.join(', ')}`);
    }

    const user = await User.findById(req.user.id).select('language preferences');
    if (!user) return fail(res, 'User not found', 404);

    user.language = language;
    // Mirror into the legacy blob so old readers stay consistent.
    user.preferences = { ...(user.preferences || {}), language };
    user.markModified('preferences');
    await user.save();

    // Drop the cached /users/me payload so a subsequent fetch reflects the change.
    cache.del(`user:byId:${req.user.id}`).catch(() => {});

    return ok(res, { language, supported: SUPPORTED });
  } catch (err) {
    console.error('updateLanguage error:', err);
    return fail(res, 'Failed to update language', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// CONTENT PREFERENCES
// GET   /api/settings/content
// PATCH /api/settings/content
//
// These are the spec-named endpoints for the Content-Preferences screen. They
// read/write the SAME preferences.content blob that PUT /api/users/preferences
// uses, so both API surfaces stay perfectly consistent — there is one source
// of truth. GET also returns the canonical topic list the picker renders.
// ═════════════════════════════════════════════════════════════════════════════

// Canonical content defaults — mirror UserController.DEFAULT_PREFS.content.
const CONTENT_DEFAULTS = {
  autoplay:         true,
  hdOnWifi:         true,
  dataSaver:        false,
  personalizedRecs: true,
  hideSensitive:    false,
  interestedTopics: [],
};

// The topic list the picker offers. Sourced from the ranking lexicon so the
// two can never drift (a topic the user can pick but the engine can't score
// would be a silent dead setting).
const TOPICS = require('../services/contentRanking').AVAILABLE_TOPICS;

const normalizeContent = (stored = {}) => {
  const out = { ...CONTENT_DEFAULTS, ...stored };
  // Coerce booleans defensively; keep only known keys.
  for (const k of ['autoplay', 'hdOnWifi', 'dataSaver', 'personalizedRecs', 'hideSensitive']) {
    out[k] = out[k] === true;
  }
  out.interestedTopics = Array.isArray(out.interestedTopics)
    ? out.interestedTopics.filter((t) => typeof t === 'string').slice(0, 30)
    : [];
  return out;
};

// GET /api/settings/content
exports.getContent = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('preferences').lean();
    if (!user) return fail(res, 'User not found', 404);
    const content = normalizeContent(user.preferences?.content || {});
    return ok(res, { content, availableTopics: TOPICS });
  } catch (err) {
    console.error('getContent error:', err);
    return fail(res, 'Failed to fetch content preferences', 500);
  }
};

// PATCH /api/settings/content   Body: partial content object
exports.updateContent = async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};

    for (const k of ['autoplay', 'hdOnWifi', 'dataSaver', 'personalizedRecs', 'hideSensitive']) {
      if (k in body) patch[k] = body[k] === true;
    }
    if ('interestedTopics' in body) {
      if (!Array.isArray(body.interestedTopics)) {
        return fail(res, 'interestedTopics must be an array of strings');
      }
      // Only accept topics from the canonical list (case-insensitive), keep
      // canonical casing, de-dupe, cap at the full list length.
      const canonicalByLower = new Map(TOPICS.map((t) => [t.toLowerCase(), t]));
      const seen = new Set();
      patch.interestedTopics = body.interestedTopics
        .filter((t) => typeof t === 'string')
        .map((t) => canonicalByLower.get(t.trim().toLowerCase()))
        .filter((t) => t && !seen.has(t) && seen.add(t))
        .slice(0, TOPICS.length);
    }

    if (!Object.keys(patch).length) {
      return fail(res, 'No valid content preferences in request body');
    }

    const user = await User.findById(req.user.id).select('preferences');
    if (!user) return fail(res, 'User not found', 404);

    // Snapshot for rollback if the feed-cache invalidation fails below.
    const contentSnapshot = JSON.parse(JSON.stringify(user.preferences?.content || {}));

    user.preferences = user.preferences || {};
    user.preferences.content = { ...(user.preferences.content || {}), ...patch };
    user.markModified('preferences');
    await user.save();

    // Same cache drop as updateLanguage so /users/me reflects the change.
    cache.del(`user:byId:${req.user.id}`).catch(() => {});

    // ── Recommendation cache invalidation (AWAITED · per-user · rollback-safe) ─
    // Only recommendation-affecting keys touch the feed cache. Await it so we
    // return success only once this user's feed + pool are cleared.
    if (feedCache.affectsRecommendations(patch)) {
      try {
        await feedCache.invalidateUserFeed(req.user.id);
      } catch (err) {
        console.error('[updateContent] feed cache invalidation failed — rolling back:', err.message);
        try {
          user.preferences.content = contentSnapshot;
          user.markModified('preferences');
          await user.save();
        } catch (rbErr) {
          console.error('[updateContent] rollback save failed:', rbErr.message);
        }
        return res.status(503).json({
          success: false,
          code:    'CACHE_SYNC_FAILED',
          message: 'Could not apply your change right now. Please try again.',
        });
      }
    }

    return ok(res, {
      content: normalizeContent(user.preferences.content),
      availableTopics: TOPICS,
    });
  } catch (err) {
    console.error('updateContent error:', err);
    return fail(res, 'Failed to update content preferences', 500);
  }
};

module.exports.SUPPORTED = SUPPORTED;
module.exports.DEFAULT_LANGUAGE = DEFAULT_LANGUAGE;
module.exports.CONTENT_DEFAULTS = CONTENT_DEFAULTS;
