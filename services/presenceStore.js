// Backend/services/presenceStore.js
//
// Online-presence + typing indicators + unread counts, backed by Redis when
// available and by an in-memory Map when it isn't. The socket.js code that
// used the old raw Map now goes through this store — same behaviour, but
// state now survives Node restarts (when Redis is up) and can be shared
// across processes.
//
// Redis keys:
//   presence:sockets:<userId>   SET of active socket ids for that user
//   typing:<chatId>:<userId>    STRING with 5s TTL (auto-expires)
//   unread:<userId>             HASH { <chatId>: <count> }

const { client, isReady } = require('../config/redis');

// In-memory shadow used when Redis is down. Same shape as the old Map so
// socket.js semantics don't change.
const localSockets = new Map();  // userId -> Set<socketId>

const kSockets = (uid)          => `presence:sockets:${uid}`;
const kTyping  = (chatId, uid)  => `typing:${chatId}:${uid}`;
const kUnread  = (uid)          => `unread:${uid}`;

// ── Presence — add / remove a socket for a user ────────────────────────────

exports.addSocket = async (userId, socketId) => {
  // Always update the local shadow — it's used as a fallback and also lets
  // in-process operations (like same-machine socket lookups) stay fast.
  if (!localSockets.has(userId)) localSockets.set(userId, new Set());
  localSockets.get(userId).add(socketId);

  if (isReady()) {
    try { await client.sadd(kSockets(userId), socketId); } catch (_) { /* swallow */ }
  }
};

exports.removeSocket = async (userId, socketId) => {
  const set = localSockets.get(userId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) localSockets.delete(userId);
  }

  if (isReady()) {
    try { await client.srem(kSockets(userId), socketId); } catch (_) { /* swallow */ }
  }
};

/** Get all socket ids for a user. Reads Redis first; falls back to local. */
exports.socketsFor = async (userId) => {
  if (isReady()) {
    try {
      const ids = await client.smembers(kSockets(userId));
      if (ids && ids.length) return new Set(ids);
    } catch (_) { /* fall through to local */ }
  }
  return localSockets.get(userId) || new Set();
};

/** Was the user offline before adding this socket? Used to decide whether
 *  to fire 'userOnline' broadcasts. Cheap check against local map. */
exports.wasOffline = (userId) => !localSockets.has(userId);

/** True if the user currently has at least one live socket in local memory. */
exports.isOnline = (userId) => localSockets.has(userId);

// ── Typing indicators — TTL-based (auto-cleanup) ───────────────────────────

const TYPING_TTL_S = 5;

/** Mark a user typing in a chat. Auto-expires in 5 s if no stopTyping arrives. */
exports.setTyping = async (chatId, userId) => {
  if (isReady()) {
    try { await client.set(kTyping(chatId, userId), '1', 'EX', TYPING_TTL_S); }
    catch (_) { /* no-op */ }
  }
};

exports.clearTyping = async (chatId, userId) => {
  if (isReady()) {
    try { await client.del(kTyping(chatId, userId)); }
    catch (_) { /* no-op */ }
  }
};

// ── Unread counts — per-user hash keyed by chatId ──────────────────────────

exports.incrementUnread = async (userId, chatId, by = 1) => {
  if (isReady()) {
    try { return await client.hincrby(kUnread(userId), chatId, by); }
    catch (_) { return null; }
  }
  return null;
};

exports.resetUnread = async (userId, chatId) => {
  if (isReady()) {
    try { await client.hdel(kUnread(userId), chatId); }
    catch (_) { /* no-op */ }
  }
};

/** Returns { chatId: count, ... }. Empty object when Redis is offline. */
exports.getUnreadMap = async (userId) => {
  if (isReady()) {
    try { return (await client.hgetall(kUnread(userId))) || {}; }
    catch (_) { return {}; }
  }
  return {};
};
