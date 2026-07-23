// Backend/controllers/ChatController.js
//
// All REST endpoints for chats + messages. The socket path in socket.js
// shares helpers with this file where it makes sense (previewFor,
// buildMessagePayload) — we don't want two forks of the same logic.

const mongoose = require('mongoose');
const Chat     = require('../models/Chat');
const Message  = require('../models/Message');
const User     = require('../models/User');
const push     = require('../services/pushService');
const privacy  = require('../services/privacy');

let socketModule = null;
const getSocketModule = () => {
  if (!socketModule) socketModule = require('../socket');
  return socketModule;
};

const ok   = (res, data, code = 200) => res.status(code).json({ success: true, ...data });
const fail = (res, msg,  code = 400) => res.status(code).json({ success: false, message: msg });

// ── Helpers ────────────────────────────────────────────────────────────────

/** Everyone in a chat except the sender. Group-safe (returns an array). */
const otherMembers = (chat, senderId) =>
  chat.members
    .map(m => m.toString())
    .filter(m => m !== senderId.toString());

/** Build the lastMessage snapshot stored on the Chat doc. */
const snapshotFor = (msg) => ({
  text:      push.previewFor(msg),
  senderId:  msg.senderId,
  type:      msg.type,
  createdAt: msg.createdAt,
});

/** Shape a message payload for emission to the client. */
const buildMessagePayload = async (messageId) => {
  return Message.findById(messageId)
    .populate('senderId',        'fullName username profileImage isVerified')
    .populate('videoId',         'title thumbnailUrl videoUrl userId duration')
    .populate('replyTo.senderId','fullName username')
    .populate('reactions.userId','username')
    .lean();
};

/** Emit a message + inbox update to every member of a chat + fire push
 *  notifications to any who are offline. Called after every mutating action
 *  (send, edit, react, pin, star for chat-wide events).
 */
const fanOutNewMessage = async ({ chat, message, senderId }) => {
  const S = getSocketModule();
  const io = S.getIO();
  if (!io) return;

  const populated = await buildMessagePayload(message._id);

  // Anyone joined to the chat room gets the message live.
  io.to(`chat:${chat._id}`).emit('newMessage', populated);

  // Everyone in the chat also gets an inbox nudge (in case they're on
  // the list screen, not inside the conversation).
  for (const otherId of otherMembers(chat, senderId)) {
    const unread = chat.unreadCount?.get?.(otherId) || 0;
    S.emitToUser(otherId, 'chatUpdated', {
      chatId:      chat._id,
      lastMessage: chat.lastMessage,
      unreadCount: unread,
    });
  }

  // Push notifications for offline recipients that haven't muted this chat.
  const mutedSet = new Set((chat.mutedBy || []).map(u => u.toString()));
  const recipients = otherMembers(chat, senderId)
    .filter(uid => !mutedSet.has(uid))
    .filter(uid => !S.presenceIsOnline(uid));

  if (recipients.length) {
    // Route through notificationCenter.notifyMany: enforces each recipient's
    // preferences.notifications.messages toggle, writes in-app history rows,
    // and attaches unread badges — in a FIXED number of queries rather than
    // 4 per recipient (matters for group chats). Chat-level mute + presence
    // were already filtered above.
    const notificationCenter = require('../services/notificationCenter');
    const sender = populated.senderId || {};
    const title = chat.type === 'group'
      ? `${sender.username || 'Someone'} • ${chat.groupName || 'Group'}`
      : sender.username || 'New message';
    const body = push.previewFor(message);
    const data = {
      chatId:    chat._id.toString(),
      senderId:  senderId.toString(),
      messageId: message._id.toString(),
      type:      message.type,
    };

    await notificationCenter.notifyMany(
      recipients,
      'messages',
      () => ({ title, body, data }),
      { fromUserId: senderId },
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chats
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyChats = async (req, res) => {
  try {
    const userId = req.user.id;
    const includeArchived = req.query.archived === '1';

    const query = { members: userId };
    if (!includeArchived) query.archivedBy = { $ne: userId };
    else                  query.archivedBy = userId;

    const chats = await Chat.find(query)
      .populate('members', 'fullName username profileImage isOnline lastSeen isVerified preferences')
      .populate('lastMessage.senderId', 'username')
      .sort({ updatedAt: -1 })
      .lean();

    // Shape each chat for the client — includes user-specific flags.
    const shaped = chats.map((chat) => {
      // Presence policy: members who hide their online status come back with
      // isOnline=false / lastSeen=null (and the raw preferences blob stripped).
      const members = (chat.members || []).map(m => privacy.applyPresencePolicy(m, userId));
      const other = members.find(m => m._id.toString() !== userId);
      const unreadCount = chat.unreadCount?.[userId] || 0;
      // Mute is active if the user is in mutedBy AND either has no expiry
      // ("Always") or the expiry is still in the future. A lapsed expiry reads
      // as unmuted (cleaned up on the next toggle).
      const inMuted   = (chat.mutedBy || []).some(u => u.toString() === userId);
      const muteUntil = chat.mutedUntil?.[userId] ? new Date(chat.mutedUntil[userId]) : null;
      const muteActive = inMuted && (!muteUntil || muteUntil.getTime() > Date.now());
      return {
        _id:         chat._id,
        type:        chat.type,
        otherUser:   other || { _id: null, fullName: 'Deleted User', username: 'deleted', profileImage: null },
        groupName:   chat.groupName,
        groupImage:  chat.groupImage,
        members:     chat.type === 'group' ? members : undefined,
        lastMessage: chat.lastMessage,
        unreadCount,
        // Per-user derived state.
        isPinned:   (chat.pinnedBy   || []).some(u => u.toString() === userId),
        isMuted:    muteActive,
        muteUntil:  muteActive && muteUntil ? muteUntil : null,
        isArchived: (chat.archivedBy || []).some(u => u.toString() === userId),
        updatedAt:  chat.updatedAt,
      };
    });

    // Pinned chats bubble to the top, then chronological.
    shaped.sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    return ok(res, { chats: shaped });
  } catch (err) {
    console.error('getMyChats error:', err);
    return fail(res, 'Failed to load chats', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats — create/get 1-on-1
// ─────────────────────────────────────────────────────────────────────────────
exports.createOrGetChat = async (req, res) => {
  try {
    const myId    = req.user.id;
    const otherId = req.body.userId;

    if (!otherId)         return fail(res, 'userId is required');
    if (myId === otherId) return fail(res, 'Cannot create a chat with yourself');
    if (!mongoose.Types.ObjectId.isValid(otherId)) return fail(res, 'Invalid userId');

    const otherUser = await User.findById(otherId)
      .select('followers following preferences blockedUsers');
    if (!otherUser) return fail(res, 'User not found', 404);

    let chat = await Chat.findOne({
      type: 'single',
      members: { $all: [myId, otherId], $size: 2 },
    }).populate('members', 'fullName username profileImage isOnline lastSeen isVerified preferences');

    if (!chat) {
      // Messaging policy gates NEW conversations only — an existing chat can
      // still be opened (each send is re-checked separately in sendMessage).
      const verdict = await privacy.canMessage(myId, otherUser);
      if (!verdict.allowed) {
        return res.status(403).json({ success: false, code: verdict.code, message: verdict.message });
      }
      chat = await Chat.create({ type: 'single', members: [myId, otherId] });
      chat = await Chat.findById(chat._id)
        .populate('members', 'fullName username profileImage isOnline lastSeen isVerified preferences');
    }

    const other = privacy.applyPresencePolicy(
      chat.members.find(m => m._id.toString() !== myId),
      myId,
    );

    return ok(res, {
      chat: {
        _id:         chat._id,
        type:        chat.type,
        otherUser:   other,
        lastMessage: chat.lastMessage,
        unreadCount: 0,
        updatedAt:   chat.updatedAt,
      },
    });
  } catch (err) {
    console.error('createOrGetChat error:', err);
    return fail(res, 'Failed to create chat', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats/group
// ─────────────────────────────────────────────────────────────────────────────
exports.createGroup = async (req, res) => {
  try {
    const myId = req.user.id;
    const { memberIds = [], groupName, groupImage = '' } = req.body || {};

    const trimmed = (groupName || '').trim();
    if (!trimmed)            return fail(res, 'Group name is required');
    if (trimmed.length > 80) return fail(res, 'Group name is too long (max 80)');
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return fail(res, 'At least one other member is required');
    }

    const others = [...new Set(memberIds.map(String))].filter(id => id && id !== myId);
    if (!others.length) return fail(res, 'Please add at least one other member');

    const found = await User.find({ _id: { $in: others } }).select('_id');
    if (found.length !== others.length) return fail(res, 'One or more users do not exist');

    let chat = await Chat.create({
      type:      'group',
      members:   [myId, ...others],
      groupName: trimmed,
      groupImage,
      createdBy: myId,
    });

    chat = await Chat.findById(chat._id)
      .populate('members', 'fullName username profileImage isOnline lastSeen isVerified preferences')
      .lean();
    chat.members = chat.members.map(m => privacy.applyPresencePolicy(m, myId));

    return ok(res, { chat }, 201);
  } catch (err) {
    console.error('createGroup error:', err);
    return fail(res, 'Failed to create group', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chats/:chatId/messages?page=1&limit=30&before=<msgId>
//   Backwards-compatible pagination — supports either page-based or
//   cursor-based fetching. `before=<msgId>` returns older messages.
// ─────────────────────────────────────────────────────────────────────────────
exports.getMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 30);
    const before = req.query.before;
    const skip  = (page - 1) * limit;

    const chat = await Chat.findById(chatId).lean();
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) {
      return fail(res, 'Not a member of this chat', 403);
    }

    // Cleared-history horizon: only messages after clearedAt[userId].
    const clearedAt = chat.clearedAt?.[userId];
    const filter = {
      chatId,
      deleted: false,
      deletedFor: { $ne: userId },
      ...(clearedAt ? { createdAt: { $gt: new Date(clearedAt) } } : {}),
    };

    if (before && mongoose.Types.ObjectId.isValid(before)) {
      const anchor = await Message.findById(before).select('createdAt').lean();
      if (anchor) filter.createdAt = { ...(filter.createdAt || {}), $lt: anchor.createdAt };
    }

    const messages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .skip(before ? 0 : skip)
      .limit(limit)
      .populate('senderId',         'fullName username profileImage isVerified')
      .populate('videoId',          'title thumbnailUrl videoUrl userId duration')
      .populate('replyTo.senderId', 'fullName username')
      .populate('reactions.userId', 'username')
      .lean();

    const total = await Message.countDocuments({ chatId, deleted: false });

    return ok(res, {
      messages:   messages.reverse(),
      page,
      totalPages: Math.ceil(total / limit),
      hasMore:    messages.length === limit,
    });
  } catch (err) {
    console.error('getMessages error:', err);
    return fail(res, 'Failed to load messages', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats/:chatId/messages
//   Supports text/image/video/voice/audio/gif/document + reply + forward.
//   Idempotent via clientMsgId — a retry with the same key returns the
//   original message instead of creating a duplicate.
// ─────────────────────────────────────────────────────────────────────────────
exports.sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const body = req.body || {};

    // Idempotency short-circuit — if this key already exists, return it.
    if (body.clientMsgId) {
      const existing = await Message.findOne({ senderId: userId, clientMsgId: body.clientMsgId });
      if (existing) {
        const populated = await buildMessagePayload(existing._id);
        return ok(res, { message: populated }, 200);
      }
    }

    const chat = await Chat.findById(chatId);
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) {
      return fail(res, 'Not a member of this chat', 403);
    }

    // Messaging policy — re-checked on EVERY 1-on-1 send because settings
    // (whoCanMessage, blocks) can change after the chat exists. Groups skip it.
    if (chat.type === 'single') {
      const otherId = otherMembers(chat, userId)[0];
      const other = otherId
        ? await User.findById(otherId).select('followers following preferences blockedUsers')
        : null;
      const verdict = await privacy.canMessage(userId, other);
      if (!verdict.allowed) {
        return res.status(403).json({ success: false, code: verdict.code, message: verdict.message });
      }
    }

    const message = await createMessageDoc({ chat, senderId: userId, body });

    // Persist chat metadata + bump unread for every other member.
    await updateChatAfterSend({ chat, message, senderId: userId });

    await fanOutNewMessage({ chat, message, senderId: userId });

    const populated = await buildMessagePayload(message._id);
    return ok(res, { message: populated }, 201);
  } catch (err) {
    // Duplicate-key surfaces from the sparse-unique index on clientMsgId.
    // Treat as "already sent" and return the winner.
    if (err?.code === 11000 && err.keyPattern?.clientMsgId) {
      const existing = await Message.findOne({
        senderId: req.user.id,
        clientMsgId: req.body?.clientMsgId,
      });
      if (existing) {
        const populated = await buildMessagePayload(existing._id);
        return ok(res, { message: populated }, 200);
      }
    }
    console.error('sendMessage error:', err);
    return fail(res, 'Failed to send message', 500);
  }
};

// Shared create helper — used by REST + socket paths so the two never drift.
async function createMessageDoc({ chat, senderId, body }) {
  const {
    text, type = 'text', videoId, imageUrl, imagePublicId, imageWidth, imageHeight,
    audioUrl, audioPublicId, audioDuration, waveform,
    gifUrl,
    documentUrl, documentPublicId, documentName, documentSize, documentMime,
    replyTo, forwardedFrom, clientMsgId,
  } = body;

  // Basic per-type validation.
  if (type === 'text'  && !text?.trim())    throw new Error('Message text is required');
  if (type === 'image' && !imageUrl)         throw new Error('imageUrl is required for image messages');
  if (type === 'video' && !videoId)          throw new Error('videoId is required for video messages');
  if (type === 'voice' && !audioUrl)         throw new Error('audioUrl is required for voice messages');
  if (type === 'audio' && !audioUrl)         throw new Error('audioUrl is required for audio messages');
  if (type === 'gif'   && !gifUrl)           throw new Error('gifUrl is required for gif messages');
  if (type === 'document' && !documentUrl)   throw new Error('documentUrl is required for documents');

  // Decide initial delivery status by asking the presence store whether
  // any recipient is currently online.
  const S = getSocketModule();
  const others = otherMembers(chat, senderId);
  const anyoneOnline = others.some(uid => S.presenceIsOnline(uid));
  const now = new Date();

  return Message.create({
    chatId:  chat._id,
    senderId,
    // undefined (not null) when absent — the sparse unique index skips only
    // MISSING fields; an explicit null would be indexed and collide.
    clientMsgId: clientMsgId || undefined,
    text:    text?.trim() || '',
    type,
    videoId:  type === 'video' ? videoId : null,
    imageUrl: type === 'image' ? imageUrl : null,
    imagePublicId: type === 'image' ? (imagePublicId || null) : null,
    imageWidth:  type === 'image' ? (imageWidth  || 0) : 0,
    imageHeight: type === 'image' ? (imageHeight || 0) : 0,
    audioUrl:      (type === 'voice' || type === 'audio') ? audioUrl      : null,
    audioPublicId: (type === 'voice' || type === 'audio') ? (audioPublicId || null) : null,
    audioDuration: (type === 'voice' || type === 'audio') ? (audioDuration || 0) : 0,
    waveform:      (type === 'voice' || type === 'audio') ? (waveform || []) : [],
    gifUrl:        type === 'gif' ? gifUrl : null,
    documentUrl:      type === 'document' ? documentUrl : null,
    documentPublicId: type === 'document' ? (documentPublicId || null) : null,
    documentName:     type === 'document' ? (documentName || 'Document') : '',
    documentSize:     type === 'document' ? (documentSize || 0) : 0,
    documentMime:     type === 'document' ? (documentMime || '') : '',
    replyTo:       replyTo       || null,
    forwardedFrom: forwardedFrom || null,
    status:        anyoneOnline  ? 'delivered' : 'sent',
    deliveredAt:   anyoneOnline  ? now : null,
  });
}

// Atomic-ish chat metadata update after a send. Uses positional $inc on
// unreadCount so concurrent sends can't clobber each other.
async function updateChatAfterSend({ chat, message, senderId }) {
  const preview = snapshotFor(message);
  const $inc = {};
  otherMembers(chat, senderId).forEach(uid => {
    $inc[`unreadCount.${uid}`] = 1;
  });
  await Chat.updateOne(
    { _id: chat._id },
    {
      $set: { lastMessage: preview, updatedAt: new Date() },
      // Un-archive the chat for anyone it was archived by — a new message
      // pulls it back to the inbox, mirroring WhatsApp behaviour.
      $pull: { archivedBy: { $in: chat.members } },
      ...(Object.keys($inc).length ? { $inc } : {}),
    },
  );
  // Reflect the change on our in-memory chat doc for downstream callers.
  chat.lastMessage = preview;
  otherMembers(chat, senderId).forEach(uid => {
    const cur = chat.unreadCount?.get?.(uid) || 0;
    chat.unreadCount.set(uid, cur + 1);
  });

  // Sharing a video into a chat is a share event for the activity screen.
  // Fire-and-forget — a logging failure must never fail the send. The model
  // is lazy-required here to avoid an import cycle at module load.
  if (message.type === 'video' && message.videoId) {
    const SharedVideo = require('../models/SharedVideo');
    const others = otherMembers(chat, senderId);
    SharedVideo.create({
      userId:   senderId,
      videoId:  message.videoId,
      platform: 'chat',
      toUserId: chat.type === 'single' ? (others[0] || null) : null,
    }).catch(() => {});
  }
}

// Export for socket.js
exports._createMessageDoc      = createMessageDoc;
exports._updateChatAfterSend   = updateChatAfterSend;
exports._fanOutNewMessage      = fanOutNewMessage;
exports._buildMessagePayload   = buildMessagePayload;
exports._otherMembers          = otherMembers;

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/chats/:chatId/read
// ─────────────────────────────────────────────────────────────────────────────
exports.markAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;

    const chat = await Chat.findById(chatId);
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) {
      return fail(res, 'Not a member of this chat', 403);
    }

    await Message.updateMany(
      { chatId, senderId: { $ne: userId }, status: { $ne: 'seen' } },
      { $set: { status: 'seen', seen: true, seenAt: new Date() } },
    );

    await Chat.updateOne({ _id: chatId }, { $set: { [`unreadCount.${userId}`]: 0 } });

    // Tell the OTHER sockets their messages were seen.
    const S = getSocketModule();
    otherMembers(chat, userId).forEach(uid => {
      S.emitToUser(uid, 'messageSeen', { chatId, seenBy: userId, seenAt: new Date() });
    });

    return ok(res, { message: 'Marked as read' });
  } catch (err) {
    console.error('markAsRead error:', err);
    return fail(res, 'Failed to mark as read', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/chats/:chatId/messages/:messageId?scope=me|everyone
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId, messageId } = req.params;
    const scope = (req.query.scope || 'me').toLowerCase();

    const message = await Message.findOne({ _id: messageId, chatId });
    if (!message) return fail(res, 'Message not found', 404);

    if (scope === 'everyone') {
      if (message.senderId.toString() !== userId) {
        return fail(res, 'Only the sender can delete for everyone', 403);
      }
      message.deleted = true;
      message.text    = '';
      // Destroy the Cloudinary assets BEFORE nulling the pointers — otherwise
      // delete-for-everyone permanently orphans chat images / voice notes /
      // documents in storage (publicIds are wiped, nothing can clean them up
      // later). Best-effort: a storage failure never blocks the delete.
      try {
        const cloudinary = require('../config/cloudinary');
        const destroys = [];
        if (message.imagePublicId)    destroys.push(cloudinary.uploader.destroy(message.imagePublicId,    { resource_type: 'image' }));
        if (message.audioPublicId)    destroys.push(cloudinary.uploader.destroy(message.audioPublicId,    { resource_type: 'video' })); // voice notes are 'video' type
        if (message.documentPublicId) destroys.push(cloudinary.uploader.destroy(message.documentPublicId, { resource_type: 'raw' }));
        if (destroys.length) Promise.allSettled(destroys).then((rs) => rs.forEach((r) => {
          if (r.status === 'rejected') console.warn('[deleteMessage] cloudinary destroy failed:', r.reason?.message);
        }));
      } catch (_) { /* best-effort */ }
      // Wipe media pointers so the tombstone bubble has nothing to render.
      message.imageUrl = null;
      message.audioUrl = null;
      message.gifUrl   = null;
      message.documentUrl = null;
      await message.save();

      // Broadcast so live clients replace the bubble with a tombstone.
      const S = getSocketModule();
      S.getIO()?.to(`chat:${chatId}`).emit('messageDeleted', {
        chatId, messageId: message._id, scope: 'everyone',
      });
    } else {
      // "Delete for me" — hide from this user only.
      await Message.updateOne({ _id: messageId }, { $addToSet: { deletedFor: userId } });
    }

    return ok(res, { message: 'Deleted' });
  } catch (err) {
    console.error('deleteMessage error:', err);
    return fail(res, 'Failed to delete message', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/chats/:chatId/messages/:messageId — edit text
// ─────────────────────────────────────────────────────────────────────────────
exports.editMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId, messageId } = req.params;
    const { text } = req.body || {};
    const trimmed = (text || '').trim();
    if (!trimmed) return fail(res, 'Text is required');

    const message = await Message.findOne({ _id: messageId, chatId });
    if (!message) return fail(res, 'Message not found', 404);
    if (message.senderId.toString() !== userId) return fail(res, 'Not your message', 403);
    if (message.type !== 'text') return fail(res, 'Only text messages can be edited', 400);
    if (message.deleted)         return fail(res, 'Deleted messages cannot be edited', 400);

    message.text     = trimmed;
    message.edited   = true;
    message.editedAt = new Date();
    await message.save();

    const S = getSocketModule();
    S.getIO()?.to(`chat:${chatId}`).emit('messageEdited', {
      chatId, messageId, text: trimmed, editedAt: message.editedAt,
    });

    return ok(res, { message });
  } catch (err) {
    console.error('editMessage error:', err);
    return fail(res, 'Failed to edit message', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats/:chatId/messages/:messageId/react   { emoji }
//   Toggles the reaction — sending the same emoji again removes it.
// ─────────────────────────────────────────────────────────────────────────────
exports.reactToMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId, messageId } = req.params;
    const emoji = (req.body?.emoji || '').trim();
    if (!emoji || emoji.length > 8) return fail(res, 'Invalid emoji');

    const chat = await Chat.findById(chatId).select('type members').lean();
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) return fail(res, 'Not a member', 403);

    // In 1:1 chats a block in either direction disables interactions.
    if (chat.type === 'single') {
      const otherId = otherMembers(chat, userId)[0];
      if (otherId && await privacy.isBlockedBetween(userId, otherId)) {
        return fail(res, 'You cannot interact with this content.', 403);
      }
    }

    const message = await Message.findOne({ _id: messageId, chatId });
    if (!message) return fail(res, 'Message not found', 404);

    const idx = message.reactions.findIndex(r =>
      r.userId.toString() === userId && r.emoji === emoji,
    );
    if (idx >= 0) message.reactions.splice(idx, 1);
    else          message.reactions.push({ userId, emoji });
    await message.save();

    const S = getSocketModule();
    S.getIO()?.to(`chat:${chatId}`).emit('messageReaction', {
      chatId, messageId,
      reactions: message.reactions.map(r => ({ userId: r.userId, emoji: r.emoji })),
    });

    return ok(res, { reactions: message.reactions });
  } catch (err) {
    console.error('reactToMessage error:', err);
    return fail(res, 'Failed to react', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats/:chatId/messages/:messageId/star
// ─────────────────────────────────────────────────────────────────────────────
exports.toggleStar = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId, messageId } = req.params;
    const chat = await Chat.findById(chatId).select('members').lean();
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) return fail(res, 'Not a member', 403);

    const msg = await Message.findOne({ _id: messageId, chatId });
    if (!msg) return fail(res, 'Message not found', 404);

    const has = msg.starredBy.some(u => u.toString() === userId);
    const update = has
      ? { $pull: { starredBy: userId } }
      : { $addToSet: { starredBy: userId } };
    await Message.updateOne({ _id: messageId }, update);
    return ok(res, { starred: !has });
  } catch (err) {
    console.error('toggleStar error:', err);
    return fail(res, 'Failed to toggle star', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats/:chatId/messages/:messageId/pin
//   Chat-wide pin. Caps at 3 pinned messages per chat (WhatsApp behaviour).
// ─────────────────────────────────────────────────────────────────────────────
exports.togglePin = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId, messageId } = req.params;
    const chat = await Chat.findById(chatId);
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) return fail(res, 'Not a member', 403);

    const msg = await Message.findOne({ _id: messageId, chatId });
    if (!msg) return fail(res, 'Message not found', 404);

    if (msg.pinned) {
      msg.pinned = false; msg.pinnedAt = null; msg.pinnedBy = null;
      await msg.save();
      await Chat.updateOne({ _id: chatId }, { $pull: { pinnedMessages: { messageId } } });
    } else {
      if ((chat.pinnedMessages || []).length >= 3) {
        return fail(res, 'Only 3 pinned messages allowed. Unpin one first.', 400);
      }
      msg.pinned = true; msg.pinnedAt = new Date(); msg.pinnedBy = userId;
      await msg.save();
      await Chat.updateOne(
        { _id: chatId },
        { $push: { pinnedMessages: { messageId, pinnedAt: msg.pinnedAt, pinnedBy: userId } } },
      );
    }

    const S = getSocketModule();
    S.getIO()?.to(`chat:${chatId}`).emit('messagePinned', {
      chatId, messageId, pinned: msg.pinned,
    });

    return ok(res, { pinned: msg.pinned });
  } catch (err) {
    console.error('togglePin error:', err);
    return fail(res, 'Failed to pin', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats/:chatId/forward  { messageIds: [...], toChatIds: [...] }
// ─────────────────────────────────────────────────────────────────────────────
exports.forwardMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageIds = [], toChatIds = [] } = req.body || {};
    if (!Array.isArray(messageIds) || !messageIds.length) return fail(res, 'messageIds required');
    if (!Array.isArray(toChatIds)   || !toChatIds.length)  return fail(res, 'toChatIds required');

    let sourceMessages = await Message.find({ _id: { $in: messageIds } }).lean();
    if (!sourceMessages.length) return fail(res, 'Nothing to forward', 404);

    // Only messages from chats the requester belongs to may be forwarded —
    // otherwise arbitrary message ids could be exfiltrated.
    const sourceChatIds = [...new Set(sourceMessages.map(m => String(m.chatId)))];
    const memberSourceChats = await Chat.find({ _id: { $in: sourceChatIds }, members: userId }).select('_id');
    const memberSourceSet = new Set(memberSourceChats.map(c => String(c._id)));
    sourceMessages = sourceMessages.filter(m => memberSourceSet.has(String(m.chatId)));
    if (!sourceMessages.length) return fail(res, 'Nothing to forward', 404);

    const targetChats = await Chat.find({ _id: { $in: toChatIds }, members: userId });
    if (!targetChats.length) return fail(res, 'No accessible target chats', 403);

    // Build one message per (source × target) pair. hops++ prevents ping-pong.
    let created = 0;
    let skipped = 0;
    for (const chat of targetChats) {
      // Respect messaging privacy per target: blocks and whoCanMessage.
      if (chat.type === 'single') {
        const otherId = otherMembers(chat, userId)[0];
        if (otherId) {
          const other = await User.findById(otherId).select('followers following preferences blockedUsers');
          const verdict = await privacy.canMessage(userId, other);
          if (!verdict.allowed) { skipped += 1; continue; }
        }
      }
      for (const source of sourceMessages) {
        const body = {
          text: source.text || '',
          type: source.type,
          videoId:  source.videoId,
          imageUrl: source.imageUrl, imagePublicId: source.imagePublicId,
          imageWidth: source.imageWidth, imageHeight: source.imageHeight,
          audioUrl: source.audioUrl, audioPublicId: source.audioPublicId,
          audioDuration: source.audioDuration, waveform: source.waveform,
          gifUrl: source.gifUrl,
          documentUrl: source.documentUrl, documentPublicId: source.documentPublicId,
          documentName: source.documentName, documentSize: source.documentSize, documentMime: source.documentMime,
          forwardedFrom: {
            fromUserId:        source.senderId,
            fromChatId:        source.chatId,
            originalMessageId: source._id,
            hops:              Math.min(20, (source.forwardedFrom?.hops || 0) + 1),
          },
        };
        const message = await createMessageDoc({ chat, senderId: userId, body });
        await updateChatAfterSend({ chat, message, senderId: userId });
        await fanOutNewMessage({ chat, message, senderId: userId });
        created += 1;
      }
    }

    return ok(res, { message: 'Forwarded', count: created, skipped });
  } catch (err) {
    console.error('forwardMessages error:', err);
    return fail(res, 'Failed to forward', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chats/:chatId/messages/search?q=…
// ─────────────────────────────────────────────────────────────────────────────
exports.searchMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const q = (req.query.q || '').trim();
    if (!q) return ok(res, { messages: [] });

    const chat = await Chat.findById(chatId).select('members').lean();
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) return fail(res, 'Not a member', 403);

    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const messages = await Message.find({
      chatId,
      deleted: false,
      deletedFor: { $ne: userId },
      text: { $regex: escaped, $options: 'i' },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('senderId', 'fullName username profileImage')
      .lean();

    return ok(res, { messages: messages.reverse() });
  } catch (err) {
    console.error('searchMessages error:', err);
    return fail(res, 'Failed to search', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-chat state — pin / mute / archive / clear
// ─────────────────────────────────────────────────────────────────────────────

const toggleUserFlag = (field) => async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const chat = await Chat.findById(chatId).select('members').lean();
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) return fail(res, 'Not a member', 403);

    const already = await Chat.exists({ _id: chatId, [field]: userId });
    const update = already
      ? { $pull: { [field]: userId } }
      : { $addToSet: { [field]: userId } };
    await Chat.updateOne({ _id: chatId }, update);
    return ok(res, { [field.replace('By', '')]: !already });
  } catch (err) {
    console.error(`toggle ${field} error:`, err);
    return fail(res, 'Failed', 500);
  }
};

exports.togglePinChat    = toggleUserFlag('pinnedBy');
exports.toggleArchive    = toggleUserFlag('archivedBy');

// Mute — supports timed mutes (8h / 24h / 1 week) and "Always", plus unmute.
// Backward compatible: with no `duration` in the body it behaves as a plain
// on/off toggle (used by the inbox swipe action), muting "Always" when off.
const MUTE_DURATIONS = {
  '8h':  8  * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '1w':  7  * 24 * 60 * 60 * 1000,
};
exports.toggleMuteChat = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const { duration } = req.body || {};

    const chat = await Chat.findById(chatId).select('members mutedBy').lean();
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) return fail(res, 'Not a member', 403);

    const alreadyMuted = (chat.mutedBy || []).some(u => u.toString() === userId);
    const key = `mutedUntil.${userId}`;

    // Resolve the requested action.
    let mute;        // final muted state
    let until = null;
    if (duration === undefined || duration === null) {
      mute = !alreadyMuted;          // legacy toggle → mute "Always"
    } else if (duration === 'off') {
      mute = false;
    } else if (duration === 'always') {
      mute = true;
    } else if (MUTE_DURATIONS[duration]) {
      mute = true;
      until = new Date(Date.now() + MUTE_DURATIONS[duration]);
    } else {
      return fail(res, 'Invalid mute duration');
    }

    const update = mute
      ? { $addToSet: { mutedBy: userId }, ...(until ? { $set: { [key]: until } } : { $unset: { [key]: '' } }) }
      : { $pull: { mutedBy: userId }, $unset: { [key]: '' } };
    await Chat.updateOne({ _id: chatId }, update);

    return ok(res, { muted: mute, muteUntil: until });
  } catch (err) {
    console.error('toggleMuteChat error:', err);
    return fail(res, 'Failed', 500);
  }
};

// Clear-history — only for the requesting user; other members keep the messages.
// `undo:true` in the body removes the just-set horizon again (powers the Undo
// snackbar) so previously-cleared messages become visible to this user once more.
exports.clearChat = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const undo = req.body?.undo === true;
    const chat = await Chat.findById(chatId).select('members').lean();
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) return fail(res, 'Not a member', 403);

    if (undo) {
      await Chat.updateOne({ _id: chatId }, { $unset: { [`clearedAt.${userId}`]: '' } });
      return ok(res, { message: 'Clear undone', restored: true });
    }

    await Chat.updateOne(
      { _id: chatId },
      { $set: { [`clearedAt.${userId}`]: new Date(), [`unreadCount.${userId}`]: 0 } },
    );
    return ok(res, { message: 'Chat cleared for you' });
  } catch (err) {
    console.error('clearChat error:', err);
    return fail(res, 'Failed to clear chat', 500);
  }
};
