// Backend/controllers/ChatController.js
const Chat    = require('../models/Chat');
const Message = require('../models/Message');
const User    = require('../models/User');

const ok   = (res, data, code = 200) => res.status(code).json({ success: true, ...data });
const fail = (res, msg,  code = 400) => res.status(code).json({ success: false, message: msg });

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chats — list all chats for the logged-in user
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyChats = async (req, res) => {
  try {
    const userId = req.user.id;

    const chats = await Chat.find({ members: userId })
      .populate('members', 'fullName username profileImage')
      .populate('lastMessage.senderId', 'username')
      .sort({ updatedAt: -1 })
      .lean();

    // Shape each chat for the client
    const shaped = chats.map((chat) => {
      const other = chat.members.find(m => m._id.toString() !== userId);
      return {
        _id:         chat._id,
        otherUser:   other || { _id: null, fullName: 'Deleted User', username: 'deleted', profileImage: null },
        lastMessage: chat.lastMessage,
        unreadCount: chat.unreadCount?.get?.(userId) || chat.unreadCount?.[userId] || 0,
        updatedAt:   chat.updatedAt,
      };
    });

    return ok(res, { chats: shaped });
  } catch (err) {
    console.error('getMyChats error:', err);
    return fail(res, 'Failed to load chats', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats — create or get existing 1-on-1 chat
// Body: { userId }  (the other user's ID)
// ─────────────────────────────────────────────────────────────────────────────
exports.createOrGetChat = async (req, res) => {
  try {
    const myId    = req.user.id;
    const otherId = req.body.userId;

    if (!otherId) return fail(res, 'userId is required');
    if (myId === otherId) return fail(res, 'Cannot create a chat with yourself');

    // Check other user exists
    const otherUser = await User.findById(otherId).select('fullName username profileImage');
    if (!otherUser) return fail(res, 'User not found', 404);

    // Find existing chat between these two users
    let chat = await Chat.findOne({
      members: { $all: [myId, otherId], $size: 2 },
    }).populate('members', 'fullName username profileImage');

    if (!chat) {
      // Create new chat
      chat = await Chat.create({ members: [myId, otherId] });
      chat = await Chat.findById(chat._id)
        .populate('members', 'fullName username profileImage');
    }

    const other = chat.members.find(m => m._id.toString() !== myId);

    return ok(res, {
      chat: {
        _id:         chat._id,
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
// GET /api/chats/:chatId/messages?page=1&limit=30
// ─────────────────────────────────────────────────────────────────────────────
exports.getMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 30);
    const skip  = (page - 1) * limit;

    // Verify membership
    const chat = await Chat.findById(chatId).lean();
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) {
      return fail(res, 'Not a member of this chat', 403);
    }

    const messages = await Message.find({ chatId, deleted: false })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('senderId',  'fullName username profileImage')
      .populate('videoId',   'title thumbnailUrl videoUrl userId duration')
      .lean();

    const total = await Message.countDocuments({ chatId, deleted: false });

    return ok(res, {
      messages: messages.reverse(), // oldest → newest for rendering
      page,
      totalPages: Math.ceil(total / limit),
      hasMore:    page * limit < total,
    });
  } catch (err) {
    console.error('getMessages error:', err);
    return fail(res, 'Failed to load messages', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chats/:chatId/messages — send a message (REST fallback)
// Body: { text, type?, videoId?, imageUrl? }
// ─────────────────────────────────────────────────────────────────────────────
exports.sendMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const { text, type = 'text', videoId, imageUrl } = req.body;

    if (type === 'text' && !text?.trim()) return fail(res, 'Message text is required');
    if (type === 'video' && !videoId)     return fail(res, 'videoId is required for video messages');

    // Verify membership
    const chat = await Chat.findById(chatId);
    if (!chat) return fail(res, 'Chat not found', 404);
    if (!chat.members.some(m => m.toString() === userId)) {
      return fail(res, 'Not a member of this chat', 403);
    }

    // Create the message
    const message = await Message.create({
      chatId,
      senderId: userId,
      text:     text?.trim() || '',
      type,
      videoId:  type === 'video' ? videoId : null,
      imageUrl: type === 'image' ? imageUrl : null,
    });

    // Determine preview text for lastMessage
    let preview = text?.trim() || '';
    if (type === 'video') preview = '🎬 Shared a video';
    if (type === 'image') preview = '📷 Sent an image';

    // Update chat lastMessage + bump unread for the OTHER user
    const otherUserId = chat.members.find(m => m.toString() !== userId).toString();
    const currentUnread = chat.unreadCount?.get?.(otherUserId) || 0;

    chat.lastMessage = {
      text:      preview,
      senderId:  userId,
      type,
      createdAt: message.createdAt,
    };
    chat.unreadCount.set(otherUserId, currentUnread + 1);
    await chat.save();

    // Populate for response
    const populated = await Message.findById(message._id)
      .populate('senderId', 'fullName username profileImage')
      .populate('videoId',  'title thumbnailUrl videoUrl userId duration')
      .lean();

    return ok(res, { message: populated }, 201);
  } catch (err) {
    console.error('sendMessage error:', err);
    return fail(res, 'Failed to send message', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/chats/:chatId/read — mark all messages as read
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

    // Mark all unseen messages from the OTHER user as seen
    await Message.updateMany(
      { chatId, senderId: { $ne: userId }, seen: false },
      { $set: { seen: true, seenAt: new Date() } },
    );

    // Reset unread counter for this user
    chat.unreadCount.set(userId, 0);
    await chat.save();

    return ok(res, { message: 'Marked as read' });
  } catch (err) {
    console.error('markAsRead error:', err);
    return fail(res, 'Failed to mark as read', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/chats/:chatId/messages/:messageId — soft-delete a message
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId, messageId } = req.params;

    const message = await Message.findOne({ _id: messageId, chatId });
    if (!message) return fail(res, 'Message not found', 404);
    if (message.senderId.toString() !== userId) {
      return fail(res, 'You can only delete your own messages', 403);
    }

    message.deleted = true;
    message.text    = '';
    await message.save();

    return ok(res, { message: 'Message deleted' });
  } catch (err) {
    console.error('deleteMessage error:', err);
    return fail(res, 'Failed to delete message', 500);
  }
};
