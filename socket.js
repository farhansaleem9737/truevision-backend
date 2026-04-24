// Backend/socket.js
//
// Socket.IO server — handles real-time chat events.
// Events emitted TO client:   newMessage, messageSeen, userOnline, userOffline, typing
// Events received FROM client: joinChat, sendMessage, markSeen, typing, stopTyping

const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const User       = require('./models/User');
const Chat       = require('./models/Chat');
const Message    = require('./models/Message');

// userId → Set<socketId>  (a user can have multiple devices connected)
const onlineUsers = new Map();

let io = null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Get all socket IDs for a user. */
const socketsFor = (userId) => onlineUsers.get(userId) || new Set();

/** Emit to every socket a user has open. */
const emitToUser = (userId, event, data) => {
  socketsFor(userId).forEach((sid) => io.to(sid).emit(event, data));
};

/** Return the io instance (for use elsewhere if needed). */
const getIO = () => io;

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: '*',           // React Native doesn't send origin — allow all in dev
      methods: ['GET', 'POST'],
    },
    pingInterval: 25000,
    pingTimeout:  60000,
  });

  // ── Auth middleware — verify JWT before allowing connection ─────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user    = await User.findById(decoded.userId).select('fullName username profileImage').lean();
      if (!user) return next(new Error('User not found'));

      socket.userId   = user._id.toString();
      socket.userData  = user;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ─────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const uid = socket.userId;
    console.log(`⚡ Socket connected: ${socket.userData.username} (${uid})`);

    // Track online
    if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());
    onlineUsers.get(uid).add(socket.id);

    // Broadcast online status to users who have a chat with this user
    broadcastOnlineStatus(uid, true);

    // ── Join a chat room ───────────────────────────────────────────────
    socket.on('joinChat', (chatId) => {
      socket.join(`chat:${chatId}`);
    });

    socket.on('leaveChat', (chatId) => {
      socket.leave(`chat:${chatId}`);
    });

    // ── Send message (real-time path) ──────────────────────────────────
    socket.on('sendMessage', async (data, ack) => {
      try {
        const { chatId, text, type = 'text', videoId, imageUrl } = data;
        if (!chatId) return ack?.({ success: false, message: 'chatId required' });

        // Verify membership
        const chat = await Chat.findById(chatId);
        if (!chat || !chat.members.some(m => m.toString() === uid)) {
          return ack?.({ success: false, message: 'Not a member' });
        }

        // Create message
        const message = await Message.create({
          chatId,
          senderId: uid,
          text:     text?.trim() || '',
          type,
          videoId:  type === 'video' ? videoId : null,
          imageUrl: type === 'image' ? imageUrl : null,
        });

        // Update chat metadata
        let preview = text?.trim() || '';
        if (type === 'video') preview = '🎬 Shared a video';
        if (type === 'image') preview = '📷 Sent an image';

        const otherUserId = chat.members.find(m => m.toString() !== uid).toString();
        const currentUnread = chat.unreadCount?.get?.(otherUserId) || 0;

        chat.lastMessage = { text: preview, senderId: uid, type, createdAt: message.createdAt };
        chat.unreadCount.set(otherUserId, currentUnread + 1);
        await chat.save();

        // Populate for emission
        const populated = await Message.findById(message._id)
          .populate('senderId', 'fullName username profileImage')
          .populate('videoId',  'title thumbnailUrl videoUrl userId duration')
          .lean();

        // Emit to everyone in the chat room (includes sender for confirmation)
        io.to(`chat:${chatId}`).emit('newMessage', populated);

        // Also emit to the OTHER user's sockets (in case they're on the inbox, not in the chat room)
        emitToUser(otherUserId, 'chatUpdated', {
          chatId,
          lastMessage: chat.lastMessage,
          unreadCount: currentUnread + 1,
        });

        ack?.({ success: true, message: populated });
      } catch (err) {
        console.error('sendMessage socket error:', err);
        ack?.({ success: false, message: err.message });
      }
    });

    // ── Mark messages as seen ──────────────────────────────────────────
    socket.on('markSeen', async ({ chatId }) => {
      try {
        const chat = await Chat.findById(chatId);
        if (!chat) return;

        await Message.updateMany(
          { chatId, senderId: { $ne: uid }, seen: false },
          { $set: { seen: true, seenAt: new Date() } },
        );

        chat.unreadCount.set(uid, 0);
        await chat.save();

        // Notify the other user their messages were seen
        const otherUserId = chat.members.find(m => m.toString() !== uid)?.toString();
        if (otherUserId) {
          emitToUser(otherUserId, 'messageSeen', { chatId, seenBy: uid });
        }
      } catch (err) {
        console.error('markSeen error:', err);
      }
    });

    // ── Typing indicators ──────────────────────────────────────────────
    socket.on('typing', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing', { chatId, userId: uid, username: socket.userData.username });
    });

    socket.on('stopTyping', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('stopTyping', { chatId, userId: uid });
    });

    // ── Disconnect ─────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${socket.userData.username}`);
      const sockets = onlineUsers.get(uid);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(uid);
          broadcastOnlineStatus(uid, false);
        }
      }
    });
  });

  return io;
};

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast online/offline to chat partners
// ─────────────────────────────────────────────────────────────────────────────
async function broadcastOnlineStatus(userId, isOnline) {
  try {
    // Find all chats this user is a member of
    const chats = await Chat.find({ members: userId }).select('members').lean();
    const partnerIds = new Set();
    chats.forEach((c) => {
      c.members.forEach((m) => {
        const mid = m.toString();
        if (mid !== userId) partnerIds.add(mid);
      });
    });
    // Notify each partner
    partnerIds.forEach((pid) => {
      emitToUser(pid, isOnline ? 'userOnline' : 'userOffline', { userId });
    });
  } catch (err) {
    console.error('broadcastOnlineStatus error:', err);
  }
}

module.exports = { initSocket, getIO, onlineUsers };
