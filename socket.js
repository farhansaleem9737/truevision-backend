// Backend/socket.js
//
// Socket.IO server — real-time chat events + presence + typing indicators.
//
// The `sendMessage` path here delegates to ChatController's private helpers
// (createMessageDoc, updateChatAfterSend, fanOutNewMessage) so REST and
// socket writes stay in lockstep. Group chats work correctly — every
// non-sender member is marked unread via an atomic $inc, not the old
// "find(!sender)" that only picked the first non-sender.
//
// Events emitted to client:
//   newMessage / messageEdited / messageDeleted / messageReaction /
//   messagePinned / messageSeen / messageDelivered / messagesDelivered /
//   chatUpdated / typing / stopTyping / userOnline / userOffline
//
// Events received from client:
//   joinChat / leaveChat / sendMessage / markSeen / typing / stopTyping

const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const User       = require('./models/User');
const Chat       = require('./models/Chat');
const Message    = require('./models/Message');
const presence   = require('./services/presenceStore');

// Legacy alias for old callers.
const onlineUsers = {
  has: (uid) => presence.isOnline(uid),
  get: (uid) => presence.socketsFor(uid),
};

let io = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Emit to every socket a user has open. */
const emitToUser = async (userId, event, data) => {
  if (!io) return;
  const sockets = await presence.socketsFor(userId);
  sockets.forEach((sid) => io.to(sid).emit(event, data));
};

const getIO = () => io;
const presenceIsOnline = (uid) => presence.isOnline(uid);

// ── Init ────────────────────────────────────────────────────────────────────

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingInterval: 25000,
    pingTimeout:  60000,
    maxHttpBufferSize: 1e6, // 1 MB — anything bigger should upload via Cloudinary.
  });

  // ── Auth middleware — verify JWT before allowing connection ───────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user    = await User.findById(decoded.userId)
        .select('fullName username profileImage isVerified')
        .lean();
      if (!user) return next(new Error('User not found'));

      socket.userId   = user._id.toString();
      socket.userData = user;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const uid = socket.userId;
    console.log(`⚡ Socket connected: ${socket.userData.username} (${uid})`);

    const wasOffline = presence.wasOffline(uid);
    await presence.addSocket(uid, socket.id);

    // Personal room — a user's own userId is a room they can be paged on.
    socket.join(`user:${uid}`);

    if (wasOffline) {
      User.findByIdAndUpdate(uid, { isOnline: true }).exec().catch(() => {});
      broadcastOnlineStatus(uid, true);
      flushPendingDeliveries(uid).catch((err) =>
        console.error('flushPendingDeliveries error:', err),
      );
    }

    // ── Chat rooms ──────────────────────────────────────────────────────
    socket.on('joinChat',  (chatId) => chatId && socket.join(`chat:${chatId}`));
    socket.on('leaveChat', (chatId) => chatId && socket.leave(`chat:${chatId}`));

    // ── Send message (real-time path) ───────────────────────────────────
    // Delegates to the same helpers REST uses so both paths behave identically.
    socket.on('sendMessage', async (data, ack) => {
      try {
        const controller = require('./controllers/ChatController');
        const { chatId } = data || {};
        if (!chatId) return ack?.({ success: false, message: 'chatId required' });

        // Idempotency short-circuit — if this key was seen already, just
        // return the winner so the sender's optimistic bubble reconciles.
        if (data.clientMsgId) {
          const existing = await Message.findOne({ senderId: uid, clientMsgId: data.clientMsgId });
          if (existing) {
            const populated = await controller._buildMessagePayload(existing._id);
            return ack?.({ success: true, message: populated, deduped: true });
          }
        }

        const chat = await Chat.findById(chatId);
        if (!chat) return ack?.({ success: false, message: 'Chat not found' });
        if (!chat.members.some(m => m.toString() === uid)) {
          return ack?.({ success: false, message: 'Not a member' });
        }

        const message = await controller._createMessageDoc({ chat, senderId: uid, body: data });
        await controller._updateChatAfterSend({ chat, message, senderId: uid });
        await controller._fanOutNewMessage({ chat, message, senderId: uid });

        // Also let sender know about delivered status if any recipient was online.
        const populated = await controller._buildMessagePayload(message._id);
        if (populated.status === 'delivered') {
          emitToUser(uid, 'messageDelivered', {
            chatId, messageId: message._id.toString(), deliveredAt: message.deliveredAt,
          });
        }

        ack?.({ success: true, message: populated });
      } catch (err) {
        // Idempotent recovery on unique-index collision (race between
        // socket send and REST send with the same clientMsgId).
        if (err?.code === 11000 && err.keyPattern?.clientMsgId) {
          try {
            const controller = require('./controllers/ChatController');
            const existing = await Message.findOne({
              senderId: uid, clientMsgId: data?.clientMsgId,
            });
            if (existing) {
              const populated = await controller._buildMessagePayload(existing._id);
              return ack?.({ success: true, message: populated, deduped: true });
            }
          } catch (_) { /* fall through */ }
        }
        console.error('sendMessage socket error:', err);
        ack?.({ success: false, message: err.message || 'Failed' });
      }
    });

    // ── Mark seen ───────────────────────────────────────────────────────
    socket.on('markSeen', async ({ chatId }) => {
      try {
        const chat = await Chat.findById(chatId).lean();
        if (!chat) return;
        if (!chat.members.some(m => m.toString() === uid)) return;

        const now = new Date();
        await Message.updateMany(
          { chatId, senderId: { $ne: uid }, status: { $ne: 'seen' } },
          { $set: { status: 'seen', seen: true, seenAt: now } },
        );
        await Chat.updateOne({ _id: chatId }, { $set: { [`unreadCount.${uid}`]: 0 } });

        // Notify every other member their messages were seen.
        chat.members
          .map(m => m.toString())
          .filter(m => m !== uid)
          .forEach(otherId => emitToUser(otherId, 'messageSeen', { chatId, seenBy: uid, seenAt: now }));
      } catch (err) {
        console.error('markSeen error:', err);
      }
    });

    // ── Typing ──────────────────────────────────────────────────────────
    socket.on('typing', ({ chatId }) => {
      if (!chatId) return;
      presence.setTyping(chatId, uid).catch(() => {});
      socket.to(`chat:${chatId}`).emit('typing', { chatId, userId: uid, username: socket.userData.username });
    });

    socket.on('stopTyping', ({ chatId }) => {
      if (!chatId) return;
      presence.clearTyping(chatId, uid).catch(() => {});
      socket.to(`chat:${chatId}`).emit('stopTyping', { chatId, userId: uid });
    });

    // ── Disconnect ──────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`🔌 Socket disconnected: ${socket.userData?.username || uid}`);
      await presence.removeSocket(uid, socket.id);

      // Last socket for this user → mark offline + broadcast.
      if (!presence.isOnline(uid)) {
        const lastSeen = new Date();
        User.findByIdAndUpdate(uid, { isOnline: false, lastSeen }).exec().catch(() => {});
        broadcastOnlineStatus(uid, false, lastSeen);
      }
    });
  });

  return io;
};

// ── Presence broadcast ─────────────────────────────────────────────────────
// Batched per-user rather than per-chat so a user with 500 partners doesn't
// fan out 500 individual queries. One aggregation + one Set = one emit per
// partner instead of one per chat.
async function broadcastOnlineStatus(userId, isOnline, lastSeen = null) {
  try {
    const chats = await Chat.find({ members: userId }).select('members').lean();
    const partners = new Set();
    chats.forEach((c) => c.members.forEach((m) => {
      const mid = m.toString();
      if (mid !== userId) partners.add(mid);
    }));
    const payload = isOnline ? { userId } : { userId, lastSeen };
    const event   = isOnline ? 'userOnline' : 'userOffline';
    partners.forEach((pid) => emitToUser(pid, event, payload));
  } catch (err) {
    console.error('broadcastOnlineStatus error:', err);
  }
}

// ── Pending-delivery flush ─────────────────────────────────────────────────
// On (re)connect, mark every 'sent' message that landed in one of the user's
// chats as 'delivered' and tell each sender in real-time.
async function flushPendingDeliveries(userId) {
  // Restrict the initial scan to chats the user actually belongs to.
  const myChats = await Chat.find({ members: userId }).select('_id').lean();
  const myChatIds = myChats.map(c => c._id);
  if (!myChatIds.length) return;

  const pending = await Message.find({
    chatId:  { $in: myChatIds },
    senderId:{ $ne: userId },
    status:  'sent',
  }).select('_id chatId senderId').lean();

  if (!pending.length) return;

  const now = new Date();
  const ids = pending.map(m => m._id);
  await Message.updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'delivered', deliveredAt: now } },
  );

  // Group by sender for batched delivery notifications.
  const bySender = new Map();
  pending.forEach((m) => {
    const sid = m.senderId.toString();
    if (!bySender.has(sid)) bySender.set(sid, []);
    bySender.get(sid).push({ chatId: m.chatId.toString(), messageId: m._id.toString() });
  });

  bySender.forEach((items, senderId) => {
    emitToUser(senderId, 'messagesDelivered', { deliveredAt: now, items });
  });
}

module.exports = {
  initSocket,
  getIO,
  emitToUser,
  presenceIsOnline,
  onlineUsers, // legacy
};
