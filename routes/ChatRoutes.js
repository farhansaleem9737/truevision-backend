// Backend/routes/ChatRoutes.js
const express  = require('express');
const router   = express.Router();
const { protect } = require('../middleware/Auth');
const {
  getMyChats,
  createOrGetChat,
  getMessages,
  sendMessage,
  markAsRead,
  deleteMessage,
} = require('../controllers/ChatController');

// ── Chat list ────────────────────────────────────────────────────────────────
router.get('/',      protect, getMyChats);        // GET  /api/chats
router.post('/',     protect, createOrGetChat);    // POST /api/chats  { userId }

// ── Messages within a chat ───────────────────────────────────────────────────
router.get('/:chatId/messages',  protect, getMessages);  // GET  /api/chats/:chatId/messages?page=1
router.post('/:chatId/messages', protect, sendMessage);  // POST /api/chats/:chatId/messages

// ── Read receipts ────────────────────────────────────────────────────────────
router.put('/:chatId/read', protect, markAsRead);        // PUT  /api/chats/:chatId/read

// ── Delete / unsend ──────────────────────────────────────────────────────────
router.delete('/:chatId/messages/:messageId', protect, deleteMessage);

module.exports = router;
