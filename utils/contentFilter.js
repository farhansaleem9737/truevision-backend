// Backend/utils/contentFilter.js
// ─────────────────────────────────────────────────────────────────────────────
// Text-based content moderation (no AI required).
// Rejects uploads whose title, description or tags contain blocked terms.
// Extend BLOCKED_TERMS with any domain-specific words you need.
// ─────────────────────────────────────────────────────────────────────────────

const BLOCKED_TERMS = [
  // Explicit sexual content
  'porn', 'porno', 'pornography', 'xxx', 'nsfw', 'nude', 'nudity', 'naked',
  'sex', 'sexual', 'sexy', 'erotic', 'erotica', 'hentai', 'onlyfans',
  'strip', 'stripper', 'webcam model', 'escort',

  // Extreme violence
  'gore', 'snuff', 'decapitat', 'behead', 'torture', 'mutilat',

  // Hate speech / slurs — left intentionally sparse to avoid false positives;
  // add specific terms your platform needs
  'hate speech', 'white supremac', 'neo-nazi',

  // Self-harm
  'suicide tutorial', 'how to kill myself', 'self harm tutorial',

  // Illegal drugs (instructional)
  'drug tutorial', 'how to make meth', 'how to make cocaine',

  // Spam / scam signals
  'click here to earn', 'free money hack', 'make money fast',
];

/**
 * Checks whether any text field contains a blocked term.
 * @param  {string[]} fields  Array of text strings to check.
 * @returns {{ blocked: boolean, term?: string }}
 */
function checkContent(...fields) {
  const combined = fields
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');  // strip punctuation for cleaner matching

  for (const term of BLOCKED_TERMS) {
    // Whole-word or partial match (partial catches plurals/conjugations)
    if (combined.includes(term)) {
      return { blocked: true, term };
    }
  }
  return { blocked: false };
}

module.exports = { checkContent };
