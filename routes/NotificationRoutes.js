// Backend/routes/NotificationRoutes.js
//
// Mounted at /api/notifications. All routes authenticated.

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/Auth');

const {
  getSettings,
  updateSettings,
  registerDevice,
  removeDevice,
  getHistory,
  markRead,
  markAllRead,
  getUnreadCount,
} = require('../controllers/NotificationController');

// GET    /api/notifications/settings
router.get('/settings',    protect, getSettings);

// PATCH  /api/notifications/settings — partial boolean patch
router.patch('/settings',  protect, updateSettings);

// POST   /api/notifications/register-device — { token, platform }
router.post('/register-device',   protect, registerDevice);

// DELETE /api/notifications/remove-device — { token, platform }
router.delete('/remove-device',   protect, removeDevice);

// GET    /api/notifications/history?page=&limit=
router.get('/history',            protect, getHistory);

// PATCH  /api/notifications/history/:id/read
router.patch('/history/:id/read', protect, markRead);

// POST   /api/notifications/history/read-all
router.post('/history/read-all',  protect, markAllRead);

// GET    /api/notifications/unread-count
router.get('/unread-count',       protect, getUnreadCount);

module.exports = router;
