// Backend/services/cloudinaryFolders.js
//
// One place that owns the Cloudinary folder taxonomy. Every controller that
// signs an upload should go through `foldersFor(userId).<kind>` instead of
// building folder strings ad-hoc, so folder naming stays consistent as new
// media surfaces are added.
//
// Folders currently used elsewhere (kept identical for backward compat):
//   truevision/videos/{userId}          → VideoController.getUploadSignature
//   truevision/attachments/{userId}     → VideoController.getAttachmentSignature
//   truevision/profiles/{userId}        → UserController.getProfileImageSignature
//
// Additional folders scaffolded here for future features (chat media,
// stories, covers, notifications, banners, categories, thumbnails).

const ROOT = 'truevision';

/**
 * Returns a map of well-known folder paths for a given user. Use it like:
 *   const folders = foldersFor(req.user.id);
 *   const folder  = folders.chatImages;   // → 'truevision/chat/images/<uid>'
 *
 * For app-wide (non-user-scoped) folders, `userId` is optional.
 */
exports.foldersFor = (userId) => {
  const u = userId ? String(userId) : null;
  const perUser  = (segment) => u ? `${ROOT}/${segment}/${u}` : `${ROOT}/${segment}`;
  const appWide  = (segment) => `${ROOT}/${segment}`;

  return {
    // ── User media ─────────────────────────────────────────────────────
    profile:      perUser('profiles'),
    cover:        perUser('covers'),

    // ── Video media ────────────────────────────────────────────────────
    videos:       perUser('videos'),
    thumbnails:   perUser('videos/thumbnails'),
    drafts:       perUser('videos/drafts'),
    edits:        perUser('videos/edits'),

    // ── Chat media ─────────────────────────────────────────────────────
    chatImages:   perUser('chat/images'),
    chatVideos:   perUser('chat/videos'),
    chatVoice:    perUser('chat/voice'),
    chatDocs:     perUser('chat/documents'),

    // ── Stories ────────────────────────────────────────────────────────
    storyImages:  perUser('stories/images'),
    storyVideos:  perUser('stories/videos'),

    // ── Supporting-evidence / news files (existing feature) ────────────
    attachments:  perUser('attachments'),

    // ── Help & Support (contact attachments, bug-report media/logs) ────
    support:       perUser('support'),

    // ── App-wide assets (managed by admins, not per-user) ──────────────
    notifications: appWide('notifications'),
    banners:       appWide('banners'),
    categories:    appWide('categories'),
  };
};

/**
 * Resolve a folder + resource type for a "kind" string sent by the client.
 * Central switch so we don't sprinkle strings across controllers.
 *
 * Returns { folder, resourceType } or null if the kind isn't recognised.
 */
exports.resolveKind = (kind, userId) => {
  const F = exports.foldersFor(userId);
  switch (kind) {
    case 'profile':       return { folder: F.profile,       resourceType: 'image' };
    case 'cover':         return { folder: F.cover,         resourceType: 'image' };
    case 'video':         return { folder: F.videos,        resourceType: 'video' };
    case 'thumbnail':     return { folder: F.thumbnails,    resourceType: 'image' };
    case 'chat-image':    return { folder: F.chatImages,    resourceType: 'image' };
    case 'chat-video':    return { folder: F.chatVideos,    resourceType: 'video' };
    case 'chat-voice':    return { folder: F.chatVoice,     resourceType: 'video' }; // voice notes = short audio, video type works
    case 'chat-doc':      return { folder: F.chatDocs,      resourceType: 'raw'   };
    case 'story-image':   return { folder: F.storyImages,   resourceType: 'image' };
    case 'story-video':   return { folder: F.storyVideos,   resourceType: 'video' };
    case 'attachment':    return { folder: F.attachments,   resourceType: 'raw'   };
    case 'attachment-image': return { folder: F.attachments, resourceType: 'image' };
    // ── Help & Support ──────────────────────────────────────────────────
    case 'support-image': return { folder: F.support,        resourceType: 'image' };
    case 'support-video': return { folder: F.support,        resourceType: 'video' };
    case 'support-doc':   return { folder: F.support,        resourceType: 'raw'   };
    default: return null;
  }
};
