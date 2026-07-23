// Backend/routes/AdminRoutes.js
// Mounted at /api/admin. Login is public (rate-limited); everything else is
// behind requireAdmin + a general rate limiter.

const express      = require('express');
const { rateLimit } = require('express-rate-limit');
const router       = express.Router();
const { requireAdmin } = require('../middleware/adminAuth');
const admin        = require('../controllers/AdminController');

// Brute-force guard on login: 10 attempts / 15 min / IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again later.' },
});

// General admin API limiter: 120 req/min/IP.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Slow down.' },
});

// ── Public (rate-limited) ──────────────────────────────────────────────────
router.post('/login', loginLimiter, admin.login);

// ── Protected (admin JWT required) ─────────────────────────────────────────
router.use(requireAdmin);
router.use(apiLimiter);

router.get('/me',                     admin.me);
router.get('/stats',                  admin.stats);
router.get('/videos',                 admin.listVideos);
router.get('/videos/:videoId',        admin.videoDetail);
router.post('/videos/:videoId/action', admin.action);
router.get('/reviews',                admin.listReviews);
router.get('/audit',                  admin.auditLog);

// ── Operational tools (previously only reachable via a User.role==='admin'
// that nothing in the product can grant — dead endpoints). Mounted here under
// the real AdminUser trust domain; their in-controller gates accept req.admin.
const videoOps = require('../controllers/VideoController');
router.post('/ops/recompute-rankings', videoOps.recomputeRankings);
router.post('/ops/remoderate-pending', videoOps.remoderatePending);

// Support-ticket administration (list / reply / status) — same situation.
const support = require('../controllers/SupportController');
router.get('/support/tickets',            support.adminListTickets);
router.post('/support/tickets/:id/reply', support.replyToTicket);
router.patch('/support/tickets/:id',      support.updateTicket);

module.exports = router;
