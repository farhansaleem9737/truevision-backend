// Backend/controllers/LegalController.js
//
//   GET /api/legal/terms    — Terms of Service (structured sections)
//   GET /api/legal/privacy  — Privacy Policy (structured sections)
//
// Public — legal docs must be viewable before login. Content lives in
// data/legal.js; this controller only serves it and sets caching headers so
// the client (and any CDN) can cache aggressively between version bumps.

const { terms, privacy } = require('../data/legal');

const serveDoc = (doc) => (req, res) => {
  try {
    // Legal text changes rarely — allow a day of shared caching. The client
    // also caches locally for offline reading.
    res.set('Cache-Control', 'public, max-age=86400');
    return res.status(200).json({ success: true, document: doc });
  } catch (err) {
    console.error('serveDoc error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch document' });
  }
};

exports.getTerms   = serveDoc(terms);
exports.getPrivacy = serveDoc(privacy);
