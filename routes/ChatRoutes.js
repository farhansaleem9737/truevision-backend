// Backend/routes/ChatRoutes.js
const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/Auth');
const ctrl = require('../controllers/ChatController');

// ── Chat list ──────────────────────────────────────────────────────────────
router.get ('/',       protect, ctrl.getMyChats);          // GET  /api/chats
router.post('/',       protect, ctrl.createOrGetChat);     // POST /api/chats             { userId }
router.post('/group',  protect, ctrl.createGroup);         // POST /api/chats/group

// ── Per-chat state (pin / mute / archive / clear) ─────────────────────────
router.patch ('/:chatId/pin',      protect, ctrl.togglePinChat);
router.patch ('/:chatId/mute',     protect, ctrl.toggleMuteChat);
router.patch ('/:chatId/archive',  protect, ctrl.toggleArchive);
router.delete('/:chatId/history',  protect, ctrl.clearChat);

// ── Messages within a chat ────────────────────────────────────────────────
router.get   ('/:chatId/messages',        protect, ctrl.getMessages);        // page or cursor
router.post  ('/:chatId/messages',        protect, ctrl.sendMessage);        // send
router.patch ('/:chatId/messages/:messageId', protect, ctrl.editMessage);    // edit text
router.delete('/:chatId/messages/:messageId', protect, ctrl.deleteMessage);  // delete for me | everyone
router.get   ('/:chatId/messages/search', protect, ctrl.searchMessages);     // ?q=

// ── Reactions / star / pin ────────────────────────────────────────────────
router.post ('/:chatId/messages/:messageId/react', protect, ctrl.reactToMessage);
router.post ('/:chatId/messages/:messageId/star',  protect, ctrl.toggleStar);
router.post ('/:chatId/messages/:messageId/pin',   protect, ctrl.togglePin);

// ── Forward ────────────────────────────────────────────────────────────────
router.post ('/forward', protect, ctrl.forwardMessages);   // { messageIds, toChatIds }

// ── Read receipts ─────────────────────────────────────────────────────────
router.put  ('/:chatId/read', protect, ctrl.markAsRead);

module.exports = router;
