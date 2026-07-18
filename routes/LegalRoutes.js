// Backend/routes/LegalRoutes.js
//
// Legal documents. Mounted at /api/legal in server.js. PUBLIC — terms and
// privacy must be readable before login.

const express = require('express');
const router  = express.Router();
const { getTerms, getPrivacy } = require('../controllers/LegalController');

router.get('/terms',   getTerms);
router.get('/privacy', getPrivacy);

module.exports = router;
