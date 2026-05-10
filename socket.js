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

    const wasOffline = !onlineUsers.has(uid);
    if (wasOffline) onlineUsers.set(uid, new Set());
    onlineUsers.get(uid).add(socket.id);

    if (wasOffline) {
      User.findByIdAndUpdate(uid, { isOnline: true }).exec().catch(() => {});
      broadcastOnlineStatus(uid, true);
      flushPendingDeliveries(uid).catch((err) =>
        console.error('flushPendingDeliveries error:', err)
      );
    }

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

        // Decide initial status: if recipient has a live socket, mark as delivered immediately
        const otherId = chat.members.find(m => m.toString() !== uid).toString();
        const recipientOnline = onlineUsers.has(otherId);
        const now = new Date();

        const message = await Message.create({
          chatId,
          senderId: uid,
          text:     text?.trim() || '',
          type,
          videoId:  type === 'video' ? videoId : null,
          imageUrl: type === 'image' ? imageUrl : null,
          status:   recipientOnline ? 'delivered' : 'sent',
          deliveredAt: recipientOnline ? now : null,
        });

        // Update chat metadata
        let preview = text?.trim() || '';
        if (type === 'video') preview = '🎬 Shared a video';
        if (type === 'image') preview = '📷 Sent an image';

        const currentUnread = chat.unreadCount?.get?.(otherId) || 0;

        chat.lastMessage = { text: preview, senderId: uid, type, createdAt: message.createdAt };
        chat.unreadCount.set(otherId, currentUnread + 1);
        await chat.save();

        // Populate for emission
        const populated = await Message.findById(message._id)
          .populate('senderId', 'fullName username profileImage')
          .populate('videoId',  'title thumbnailUrl videoUrl userId duration')
          .lean();

        // Emit to everyone in the chat room (includes sender for confirmation)
        io.to(`chat:${chatId}`).emit('newMessage', populated);

        // If recipient was online, tell sender it's already delivered
        if (recipientOnline) {
          emitToUser(uid, 'messageDelivered', {
            chatId,
            messageId: message._id.toString(),
            deliveredAt: now,
          });
        }

        // Also emit to the OTHER user's sockets (in case they're on the inbox, not in the chat room)
        emitToUser(otherId, 'chatUpdated', {
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

        const now = new Date();
        await Message.updateMany(
          { chatId, senderId: { $ne: uid }, status: { $ne: 'seen' } },
          { $set: { status: 'seen', seen: true, seenAt: now } },
        );

        chat.unreadCount.set(uid, 0);
        await chat.save();

        // Notify the other user their messages were seen
        const otherUserId = chat.members.find(m => m.toString() !== uid)?.toString();
        if (otherUserId) {
          emitToUser(otherUserId, 'messageSeen', { chatId, seenBy: uid, seenAt: now });
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
          const lastSeen = new Date();
          User.findByIdAndUpdate(uid, { isOnline: false, lastSeen }).exec().catch(() => {});
          broadcastOnlineStatus(uid, false, lastSeen);
        }
      }
    });
  });

  return io;
};

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast online/offline to chat partners
// ─────────────────────────────────────────────────────────────────────────────
async function broadcastOnlineStatus(userId, isOnline, lastSeen = null) {
  try {
    const chats = await Chat.find({ members: userId }).select('members').lean();
    const partnerIds = new Set();
    chats.forEach((c) => {
      c.members.forEach((m) => {
        const mid = m.toString();
        if (mid !== userId) partnerIds.add(mid);
      });
    });
    const payload = isOnline ? { userId } : { userId, lastSeen };
    const event   = isOnline ? 'userOnline' : 'userOffline';
    partnerIds.forEach((pid) => emitToUser(pid, event, payload));
  } catch (err) {
    console.error('broadcastOnlineStatus error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// When a user (re)connects, flip any messages sent to them while offline
// from 'sent' → 'delivered' and notify each sender in real time.
// ─────────────────────────────────────────────────────────────────────────────
async function flushPendingDeliveries(userId) {
  // Messages whose recipient is this user and that are still 'sent'
  const pending = await Message.find({
    status: 'sent',
    senderId: { $ne: userId },
  })
    .populate({ path: 'chatId', select: 'members', match: { members: userId } })
    .lean();

  const relevant = pending.filter((m) => m.chatId); // populate filter match → null if not member
  if (!relevant.length) return;

  const ids = relevant.map((m) => m._id);
  const now = new Date();
  await Message.updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'delivered', deliveredAt: now } }
  );

  // Group by sender and by chat for the outgoing notification
  const bySender = new Map(); // senderId → [{ chatId, messageId }]
  relevant.forEach((m) => {
    const sid = m.senderId.toString();
    if (!bySender.has(sid)) bySender.set(sid, []);
    bySender.get(sid).push({
      chatId: m.chatId._id.toString(),
      messageId: m._id.toString(),
    });
  });

  bySender.forEach((items, senderId) => {
    emitToUser(senderId, 'messagesDelivered', { deliveredAt: now, items });
  });
}

module.exports = { initSocket, getIO, onlineUsers };
