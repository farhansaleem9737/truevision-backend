// Backend/routes/AppRoutes.js
//
// App metadata + health. Mounted at /api/app in server.js. PUBLIC by design —
// the About screen and update checker run before/without a session.

const express = require('express');
const router  = express.Router();
const { getVersion, getInfo, getChangelog } = require('../controllers/AppController');

router.get('/version',   getVersion);
router.get('/info',      getInfo);
router.get('/changelog', getChangelog);

module.exports = router;
