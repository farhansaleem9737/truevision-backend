// Backend/routes/SupportRoutes.js
//
// Help & Support. Mounted at /api/support in server.js.
//   FAQs are PUBLIC (Help Center must work before/without login).
//   Everything that reads or writes a ticket requires auth.

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/Auth');
const {
  createContact,
  createReport,
  listTickets,
  getTicket,
  getFaqs,
  adminListTickets,
  replyToTicket,
  updateTicket,
} = require('../controllers/SupportController');

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/faqs', getFaqs);

// ── Authenticated (user) ────────────────────────────────────────────────────────
router.post('/contact', protect, createContact);
router.post('/report',  protect, createReport);
router.get ('/tickets', protect, listTickets);

// ── Admin (role checked inside the controller) ──────────────────────────────────
router.get  ('/admin/tickets',   protect, adminListTickets);
router.post ('/tickets/:id/reply', protect, replyToTicket);
router.patch('/tickets/:id',       protect, updateTicket);

// Keep the parameterized GET last so it doesn't shadow /admin/tickets.
router.get('/tickets/:id', protect, getTicket);

module.exports = router;
