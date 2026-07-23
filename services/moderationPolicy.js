// Backend/services/moderationPolicy.js
//
// The single source of truth that turns an AI classification into a moderation
// DECISION for TrueVision's "informative-first" policy:
//
//   • Informative / educational / professional / Islamic … → APPROVED (publish)
//   • Entertainment / music / comedy / dance / gaming …     → BLOCKED  (hidden)
//   • Anything uncertain, or the classifier being unavailable → PENDING (manual)
//
// FUTURE-READY: moderation runs as an ordered list of pluggable "levels". Each
// level inspects the signals and may return a verdict; the first BLOCK/PENDING
// wins, otherwise the content is approved. New levels (copyright, violence,
// spam, ai-generated, medical-misinformation, political, explicit …) can be
// added to LEVELS below WITHOUT touching the upload pipeline or the controllers.

// ── Decision constants ───────────────────────────────────────────────────────
const DECISION = {
  APPROVED: 'approved',
  BLOCKED:  'blocked',
  PENDING:  'pending_review',
};

// ── Category buckets (normalised, lowercase) ─────────────────────────────────
// The AI classifier's own labels + the richer label set from the spec are all
// covered, so the policy is correct no matter which classifier backs it.
const APPROVE_CATEGORIES = new Set([
  'educational', 'education', 'professional', 'technical', 'technology', 'tech',
  'programming', 'business', 'finance', 'science', 'research', 'news',
  'islamic', 'motivational', 'motivation', 'productivity',
]);

const BLOCK_CATEGORIES = new Set([
  'entertainment', 'music', 'comedy', 'dance', 'gaming', 'game', 'meme',
  'reaction', 'lifestyle', 'celebrity', 'vlog', 'prank', 'gossip',
]);

// Informative-first gate: an approve-category still needs a minimum
// informativeness score to auto-publish (else it goes to manual review).
const MIN_INFORMATIVE_SCORE = Number(process.env.MODERATION_MIN_SCORE ?? 5);

const norm = (s) => String(s || '').trim().toLowerCase();
const clamp01 = (n) => Math.max(0, Math.min(1, n));

// ── Level 1: category / informativeness ──────────────────────────────────────
// Uses the AI category + informativeScore (1–10). `confidence` is normalised to
// 0–1 from informativeScore when an explicit confidence isn't supplied.
const categoryLevel = ({ category, informativeScore, confidence }) => {
  const cat = norm(category);
  const score = Number(informativeScore);
  const conf = typeof confidence === 'number' ? clamp01(confidence) : clamp01(score / 10);

  // No usable classification (classifier down / empty) → fail CLOSED to manual
  // review so entertainment can never slip through unclassified.
  if (!cat || Number.isNaN(score)) {
    return { decision: DECISION.PENDING, level: 'category', category: cat || 'unknown', confidence: conf, reason: 'unclassified' };
  }

  if (BLOCK_CATEGORIES.has(cat)) {
    return { decision: DECISION.BLOCKED, level: 'category', category: cat, confidence: conf, reason: `non-informative-category:${cat}` };
  }

  if (APPROVE_CATEGORIES.has(cat)) {
    if (score >= MIN_INFORMATIVE_SCORE) {
      return { decision: DECISION.APPROVED, level: 'category', category: cat, confidence: conf, reason: `informative-category:${cat}` };
    }
    // Right category but weak informativeness → let a human decide.
    return { decision: DECISION.PENDING, level: 'category', category: cat, confidence: conf, reason: `low-informative-score:${score}` };
  }

  // 'other' / unrecognised → manual review (fail closed).
  return { decision: DECISION.PENDING, level: 'category', category: cat, confidence: conf, reason: 'uncategorised' };
};

// ── Decision straight from a zero-shot classifier (BART /predict) ────────────
// Unlike categoryLevel (which gates on informativeScore 1–10), this maps a
// classifier's { category, confidence 0–1 } directly — used for the SYNCHRONOUS
// block-before-publish check at upload time.
//
// Thresholds: we BLOCK content the model is CONFIDENT is entertainment, APPROVE
// confident informative content, and — by default — PUBLISH everything the model
// is uncertain about (unknown / low-confidence / uncategorised) instead of
// silently trapping it in pending_review where it would never appear in any feed.
//
// Rationale: "uncertain" is NOT "bad". A short clip whose sparse metadata BART
// can't confidently label (top score ~0.2) is not entertainment — hiding it is
// what made new uploads invisible. NSFW is a SEPARATE hard gate (nsfwModeration),
// so publishing uncertain category-content here never lets explicit material
// through. Confident entertainment is still blocked, and the async transcript
// pass can still downgrade an approved video whose SPOKEN content is entertainment.
//
// Set MODERATION_PUBLISH_ON_UNCERTAIN=false to restore strict informative-first
// gating (hide anything the model isn't confident about).
const BLOCK_CONF   = Number(process.env.MODERATION_BLOCK_CONFIDENCE   ?? 0.45);
const APPROVE_CONF = Number(process.env.MODERATION_APPROVE_CONFIDENCE ?? 0.40);
const PUBLISH_ON_UNCERTAIN = String(process.env.MODERATION_PUBLISH_ON_UNCERTAIN ?? 'true') !== 'false';

function decideFromClassifier({ category, confidence } = {}) {
  const cat  = norm(category);
  const conf = clamp01(Number(confidence) || 0);

  // 1) CONFIDENT entertainment / non-informative → BLOCK (safety — unchanged).
  if (cat && BLOCK_CATEGORIES.has(cat) && conf >= BLOCK_CONF) {
    return { decision: DECISION.BLOCKED, level: 'classifier', category: cat, confidence: conf, reason: `non-informative-category:${cat}` };
  }
  // 2) CONFIDENT informative → APPROVE.
  if (cat && APPROVE_CATEGORIES.has(cat) && conf >= APPROVE_CONF) {
    return { decision: DECISION.APPROVED, level: 'classifier', category: cat, confidence: conf, reason: `informative-category:${cat}` };
  }
  // 3) UNCERTAIN (unknown / low-confidence anything / uncategorised).
  if (PUBLISH_ON_UNCERTAIN) {
    return { decision: DECISION.APPROVED, level: 'classifier', category: cat || 'unknown', confidence: conf, reason: cat ? `published-uncertain:${cat}` : 'published-unclassified' };
  }
  return { decision: DECISION.PENDING, level: 'classifier', category: cat || 'unknown', confidence: conf, reason: cat ? `low-confidence:${cat}` : 'unclassified' };
}

// Ordered pipeline. Add future levels here; each is `(signals) => verdict|null`.
// A level returning BLOCKED or PENDING short-circuits; APPROVED lets the next
// level run; the content is approved only if NO level blocks or defers.
const LEVELS = [
  categoryLevel,
  // e.g. copyrightLevel, violenceLevel, spamLevel, aiGeneratedLevel, …
];

/**
 * Decide the moderation outcome for a set of AI signals.
 * @param {{category?:string, informativeScore?:number, confidence?:number, nsfw?:string}} signals
 * @returns {{decision:'approved'|'blocked'|'pending_review', level:string, category:string, confidence:number, reason:string}}
 */
function decideModeration(signals = {}) {
  let last = null;
  for (const level of LEVELS) {
    const verdict = level(signals);
    if (!verdict) continue;
    last = verdict;
    if (verdict.decision === DECISION.BLOCKED || verdict.decision === DECISION.PENDING) {
      return verdict; // first block/defer wins
    }
  }
  // Every level approved (or none ran) → approved.
  return last || { decision: DECISION.PENDING, level: 'none', category: 'unknown', confidence: 0, reason: 'no-signal' };
}

// Review states that must be HIDDEN from every public surface. Note 'approved'
// and any legacy doc missing the field are NOT here, so `$nin` keeps them
// visible without a data migration.
const HIDDEN_REVIEW_STATES = ['processing', 'blocked', 'pending_review', 'rejected', 'changes_requested'];

// Drop-in Mongo filter fragment for public queries (feed / search / trending /
// other users' grids): `{ ...base, ...PUBLIC_REVIEW_FILTER }`.
const PUBLIC_REVIEW_FILTER = { reviewStatus: { $nin: HIDDEN_REVIEW_STATES } };

module.exports = {
  decideModeration,
  decideFromClassifier,
  DECISION,
  APPROVE_CATEGORIES,
  BLOCK_CATEGORIES,
  MIN_INFORMATIVE_SCORE,
  HIDDEN_REVIEW_STATES,
  PUBLIC_REVIEW_FILTER,
};
