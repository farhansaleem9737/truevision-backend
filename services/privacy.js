// Backend/services/privacy.js
//
// SINGLE SOURCE OF TRUTH for every privacy decision in the API.
//
// Settings live in the User.preferences Mixed blob under `privacy`:
//   { privateAccount, hideOnlineStatus, hideFollowers, whoCanMessage, whoCanComment }
// (NB: the storage key is `hideFollowers` — kept for backward compatibility
//  with data already written by the client; it implements the
//  "Hide Followers List" feature.)
//
// Audience policies: 'everyone' | 'followers' | 'mutual' | 'nobody'
//   followers — the actor must be an approved follower of the owner
//   mutual    — both follow each other
//
// Every helper is defensive about input shape: it accepts a hydrated
// mongoose doc OR a .lean() object, with or without `preferences`.

const mongoose = require('mongoose');
const User = require('../models/User');

const AUDIENCE_VALUES = ['everyone', 'followers', 'mutual', 'nobody'];

const DEFAULT_PRIVACY = {
  privateAccount:   false,
  hideOnlineStatus: false,
  hideFollowers:    false,
  whoCanMessage:    'everyone',
  whoCanComment:    'everyone',
};

const idStr = (v) => String(v?._id ?? v ?? '');

/** Normalized privacy settings for a user doc/lean object. */
const getPrivacy = (user) => {
  const p = user?.preferences?.privacy || {};
  return {
    privateAccount:   p.privateAccount   === true,
    hideOnlineStatus: p.hideOnlineStatus === true,
    hideFollowers:    p.hideFollowers    === true,
    whoCanMessage:    AUDIENCE_VALUES.includes(p.whoCanMessage) ? p.whoCanMessage : 'everyone',
    whoCanComment:    AUDIENCE_VALUES.includes(p.whoCanComment) ? p.whoCanComment : 'everyone',
  };
};

/** Does `ownerUser.followers` contain `actorId`? (sync — needs followers loaded) */
const isFollower = (actorId, ownerUser) =>
  (ownerUser?.followers || []).some((f) => idStr(f) === idStr(actorId));

/** Do both users follow each other? (needs followers+following on ownerUser) */
const isMutual = (actorId, ownerUser) =>
  isFollower(actorId, ownerUser) &&
  (ownerUser?.following || []).some((f) => idStr(f) === idStr(actorId));

/** True when either user has blocked the other. One indexed query. */
const isBlockedBetween = async (aId, bId) => {
  if (!aId || !bId) return false;
  const n = await User.countDocuments({
    $or: [
      { _id: aId, blockedUsers: bId },
      { _id: bId, blockedUsers: aId },
    ],
  });
  return n > 0;
};

/**
 * Every user id that is block-related to `userId` (either direction), as a
 * Set of strings. Used to exclude blocked pairs from feeds, search, lists.
 */
const blockedIdSetFor = async (userId) => {
  if (!userId) return new Set();
  const [me, blockers] = await Promise.all([
    User.findById(userId).select('blockedUsers').lean(),
    User.find({ blockedUsers: userId }).select('_id').lean(),
  ]);
  const set = new Set();
  (me?.blockedUsers || []).forEach((id) => set.add(String(id)));
  (blockers || []).forEach((u) => set.add(String(u._id)));
  return set;
};

/**
 * Central audience check.
 * `ownerUser` must include `followers` (+ `following` for 'mutual') and
 * `preferences`. The owner always passes their own policy.
 */
const audienceAllows = (policy, actorId, ownerUser) => {
  if (idStr(actorId) === idStr(ownerUser)) return true;
  switch (policy) {
    case 'nobody':    return false;
    case 'followers': return isFollower(actorId, ownerUser);
    case 'mutual':    return isMutual(actorId, ownerUser);
    case 'everyone':
    default:          return true;
  }
};

/**
 * May `actorId` start a conversation with / message `ownerUser`?
 * Returns { allowed, message } — `message` is the client-facing error.
 * Block and policy failures intentionally share one message so blocking
 * is never revealed.
 */
const canMessage = async (actorId, ownerUser) => {
  const DENIED = { allowed: false, code: 'MESSAGES_NOT_ALLOWED', message: "This user isn't accepting messages." };
  if (!ownerUser) return DENIED;
  if (idStr(actorId) === idStr(ownerUser)) return { allowed: true };
  if (await isBlockedBetween(actorId, ownerUser._id)) return DENIED;
  const { whoCanMessage } = getPrivacy(ownerUser);
  return audienceAllows(whoCanMessage, actorId, ownerUser) ? { allowed: true } : DENIED;
};

/** May `actorId` comment on a video owned by `ownerUser`? */
const canComment = async (actorId, ownerUser) => {
  const DENIED = { allowed: false, code: 'COMMENTS_NOT_ALLOWED', message: "You can't comment on this video." };
  if (!ownerUser) return DENIED;
  if (idStr(actorId) === idStr(ownerUser)) return { allowed: true };
  if (await isBlockedBetween(actorId, ownerUser._id)) return DENIED;
  const { whoCanComment } = getPrivacy(ownerUser);
  return audienceAllows(whoCanComment, actorId, ownerUser) ? { allowed: true } : DENIED;
};

/**
 * May `viewerId` see the content (videos) of `ownerUser`?
 * Private accounts show content only to the owner and approved followers.
 * Blocked pairs never see each other's content (async check is separate —
 * callers that already have a blocked set should consult it instead).
 */
const canViewContentOf = (viewerId, ownerUser) => {
  if (idStr(viewerId) === idStr(ownerUser)) return true;
  const { privateAccount } = getPrivacy(ownerUser);
  if (!privateAccount) return true;
  return isFollower(viewerId, ownerUser);
};

/**
 * Owner ids whose videos must be hidden from `viewerId`:
 *   private accounts the viewer doesn't follow  ∪  blocked pairs.
 * Anonymous viewers (null) exclude ALL private accounts.
 * Returns an array of string ids ready for a `$nin` filter.
 */
const contentExclusionsFor = async (viewerId) => {
  const privateFilter = { 'preferences.privacy.privateAccount': true };
  if (viewerId) {
    privateFilter._id = { $ne: viewerId };
    privateFilter.followers = { $ne: viewerId };
  }
  const [privateOwners, blockedSet] = await Promise.all([
    User.find(privateFilter).select('_id').lean(),
    blockedIdSetFor(viewerId),
  ]);
  const set = new Set(privateOwners.map((u) => String(u._id)));
  blockedSet.forEach((id) => set.add(id));
  return [...set];
};

/**
 * Presence policy for API payloads. Returns a shallow copy of `userLike`
 * with isOnline/lastSeen nulled when the user hides their status (and the
 * viewer isn't the user themself), and the raw `preferences` blob removed
 * so it never leaks through population.
 */
const applyPresencePolicy = (userLike, viewerId = null) => {
  if (!userLike) return userLike;
  const out = { ...(userLike.toObject ? userLike.toObject() : userLike) };
  const hidden = getPrivacy(out).hideOnlineStatus && idStr(out) !== idStr(viewerId);
  if (hidden) {
    if ('isOnline' in out) out.isOnline = false;
    out.lastSeen = null;
  }
  delete out.preferences;
  return out;
};

/** Is presence (Online / Last seen) visible to others for this user? */
const presenceVisible = (userLike) => !getPrivacy(userLike).hideOnlineStatus;

module.exports = {
  AUDIENCE_VALUES,
  DEFAULT_PRIVACY,
  getPrivacy,
  isFollower,
  isMutual,
  isBlockedBetween,
  blockedIdSetFor,
  audienceAllows,
  canMessage,
  canComment,
  canViewContentOf,
  contentExclusionsFor,
  applyPresencePolicy,
  presenceVisible,
};
