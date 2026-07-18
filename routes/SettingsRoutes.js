// Backend/routes/SettingsRoutes.js
//
// Account-level settings. Mounted at /api/settings in server.js.
// Every route is JWT-protected — a caller can only read/write their own row.

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/Auth');
const {
  getLanguage, updateLanguage,
  getContent, updateContent,
} = require('../controllers/SettingsController');

// ── Language ──────────────────────────────────────────────────────────────────
// GET   /api/settings/language   — current UI language for the account
// PATCH /api/settings/language   — change it { language: 'en' | 'ur' | ... }
router.get  ('/language', protect, getLanguage);
router.patch('/language', protect, updateLanguage);

// ── Content preferences ─────────────────────────────────────────────────────
// GET   /api/settings/content    — { content, availableTopics }
// PATCH /api/settings/content    — partial { autoplay, hdOnWifi, dataSaver,
//                                  personalizedRecs, hideSensitive, interestedTopics }
router.get  ('/content', protect, getContent);
router.patch('/content', protect, updateContent);

module.exports = router;
