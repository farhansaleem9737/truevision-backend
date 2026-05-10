// Backend/services/contentRanking.js
//
// Pure-JS ranking helpers. No DB calls, no network — call sites pass in raw
// values and read the computed scores. Splitting this from the Gemini
// classifier means we can rank without an AI key (cheaper and resilient).
//
// Scoring philosophy:
//   tagScore        — weighted by allow-list buckets (tech > educational > general)
//   engagementScore — relative to a "good engagement" target so small/large
//                     channels coexist on a single linear scale
//   informativeScore — comes from Gemini if available, else derived from tags
//   rankingScore    — 40% informative + 20% tag + 40% engagement (per spec)

// ─────────────────────────────────────────────────────────────────────────────
// Weighted tag system
// ─────────────────────────────────────────────────────────────────────────────
const TECHNICAL_TAGS = new Set([
  'coding', 'programming', 'developer', 'javascript', 'python', 'react',
  'nodejs', 'node.js', 'typescript', 'fullstack', 'backend', 'frontend',
  'webdev', 'web development', 'cybersecurity', 'security', 'devops',
  'database', 'sql', 'docker', 'kubernetes', 'cloud', 'aws', 'azure', 'gcp',
  'ai', 'ml', 'machine learning', 'data science', 'datascience', 'algorithm',
  'opensource', 'api', 'linux', 'git', 'github',
]);

const EDUCATIONAL_TAGS = new Set([
  'education', 'tutorial', 'learn', 'course', 'lecture', 'lesson', 'guide',
  'explained', 'how-to', 'howto', 'training', 'study', 'school', 'academic',
  'science', 'math', 'physics', 'history', 'language', 'english',
  'productivity', 'tips', 'tricks', 'skills',
  'business', 'finance', 'investing', 'economics', 'startup', 'entrepreneur',
  'islamic', 'quran', 'hadith', 'fiqh', 'seerah',
  'motivation', 'motivational', 'self-improvement', 'discipline',
]);

const PENALTY_TAGS = new Set([
  'music', 'song', 'dance', 'remix', 'prank', 'funny', 'comedy',
  'romance', 'love', 'fashion', 'model', 'vlog', 'meme', 'viral',
]);

const TECH_WEIGHT     = 5;
const EDU_WEIGHT      = 4;
const GENERIC_WEIGHT  = 1;
const PENALTY_WEIGHT  = -3;

const norm = (s) => (s || '').toString().trim().toLowerCase();

/**
 * Score a video's tags + title + description on a -ish-to-30+ scale.
 * Higher = more technical/educational signal.
 */
const computeTagScore = ({ tags = [], title = '', description = '', category = '' } = {}) => {
  const buckets = new Set();
  tags.forEach((t) => buckets.add(norm(t)));
  // Lightly mine the title + description for keywords without exploding the search space
  const text = `${norm(title)} ${norm(description)}`;
  [...TECHNICAL_TAGS, ...EDUCATIONAL_TAGS, ...PENALTY_TAGS].forEach((kw) => {
    if (text.includes(kw)) buckets.add(kw);
  });
  buckets.add(norm(category));

  let score = 0;
  buckets.forEach((b) => {
    if (!b) return;
    if (TECHNICAL_TAGS.has(b))   score += TECH_WEIGHT;
    else if (EDUCATIONAL_TAGS.has(b)) score += EDU_WEIGHT;
    else if (PENALTY_TAGS.has(b))     score += PENALTY_WEIGHT;
    else                               score += GENERIC_WEIGHT;
  });
  return score;
};

// ─────────────────────────────────────────────────────────────────────────────
// Engagement
// ─────────────────────────────────────────────────────────────────────────────
// Targets calibrated for a young app — adjust as the platform scales. The
// formula normalises each metric against a target and clamps to [0, 1] so
// no single signal dominates.

const TARGETS = {
  views:     1000,   // 1k views ≈ "good"
  likes:      100,
  comments:    20,
  shares:      30,
  saves:       40,
  // Watch-time proxy: total seconds watched (= duration × completionRate × views)
  watchSeconds: 30 * 1000, // 30s per view × 1k views = 30k watched seconds
};

const ratio = (value, target) => {
  if (!target) return 0;
  return Math.max(0, Math.min(1, (value || 0) / target));
};

/**
 * Compute engagement on a 0–10 scale from real metrics.
 * Weights match the spec: watchTime 0.4, completion 0.3, like/comment/share 0.1 each.
 */
const computeEngagementScore = (v = {}) => {
  const views      = v.viewsCount    || 0;
  const likes      = v.likesCount    || 0;
  const comments   = v.commentsCount || 0;
  const shares     = v.sharesCount   || 0;

  const totalWatchSeconds = v.totalWatchSeconds
    ?? (v.duration || 0) * (v.completionRate || 0.5) * views;

  // Normalised 0–1 components
  const watchTime  = ratio(totalWatchSeconds, TARGETS.watchSeconds);
  const completion = Math.max(0, Math.min(1, v.completionRate || 0));
  const likeRatio  = views > 0 ? ratio(likes / views, 0.05)        : ratio(likes,    TARGETS.likes);
  const cmntRatio  = views > 0 ? ratio(comments / views, 0.01)     : ratio(comments, TARGETS.comments);
  const shareRatio = views > 0 ? ratio(shares / views, 0.005)      : ratio(shares,   TARGETS.shares);

  const weighted =
      watchTime  * 0.4
    + completion * 0.3
    + likeRatio  * 0.1
    + cmntRatio  * 0.1
    + shareRatio * 0.1;

  return Number((weighted * 10).toFixed(2)); // 0–10
};

// ─────────────────────────────────────────────────────────────────────────────
// Informative score fallback — used when Gemini analysis isn't available.
// Maps tagScore into a 0–10 rough proxy.
// ─────────────────────────────────────────────────────────────────────────────
const informativeFromTags = (tagScore) => {
  if (tagScore >= 25) return 10;
  if (tagScore >= 18) return 8;
  if (tagScore >= 12) return 7;
  if (tagScore >=  8) return 6;
  if (tagScore >=  4) return 5;
  if (tagScore >=  1) return 3;
  if (tagScore <=  -3) return 1;
  return 4;
};

// ─────────────────────────────────────────────────────────────────────────────
// Combined ranking score
// rankingScore = informativeScore*0.4 + tagScore*0.2 + engagementScore*0.4
// All inputs normalised to 0–10 first so the weighted sum stays in 0–10.
// ─────────────────────────────────────────────────────────────────────────────
const tagScoreToTen = (tagScore) => Math.max(0, Math.min(10, (tagScore + 5) / 4));

const computeRankingScore = ({ informativeScore = 0, tagScore = 0, engagementScore = 0 } = {}) => {
  const i = Math.max(0, Math.min(10, informativeScore));
  const t = tagScoreToTen(tagScore);
  const e = Math.max(0, Math.min(10, engagementScore));
  return Number((i * 0.4 + t * 0.2 + e * 0.4).toFixed(3));
};

// ─────────────────────────────────────────────────────────────────────────────
// Top-level helper: take a Video document, return the three component scores
// plus the combined ranking. Pass through any AI-derived `informativeScore`
// (from a previous Gemini analysis) — we don't recompute that here.
// ─────────────────────────────────────────────────────────────────────────────
const scoreVideo = (video, opts = {}) => {
  const tagScore = computeTagScore({
    tags: video.tags, title: video.title,
    description: video.description, category: video.category,
  });

  const engagementScore = computeEngagementScore(video);

  // Prefer the AI-derived score; fall back to tag-based proxy
  const informativeScore = (typeof opts.informativeScore === 'number')
    ? opts.informativeScore
    : (video.informativeScore > 0 ? video.informativeScore : informativeFromTags(tagScore));

  const rankingScore = computeRankingScore({ informativeScore, tagScore, engagementScore });

  return { tagScore, engagementScore, informativeScore, rankingScore };
};

module.exports = {
  computeTagScore,
  computeEngagementScore,
  computeRankingScore,
  informativeFromTags,
  scoreVideo,
  // Exposed for tests
  TECHNICAL_TAGS, EDUCATIONAL_TAGS, PENALTY_TAGS,
};
