// Backend/models/Message.js
//
// Message is the single source of truth for every chat item — text, media
// (image/video/voice/audio/gif/document), reactions, replies, edits, forwards,
// stars and pins. Read-receipt state, per-user delete state, and the client-
// side idempotency key (to swallow retries) all live on this document.

const mongoose = require('mongoose');

// ── Sub-schemas ─────────────────────────────────────────────────────────────

// Emoji reaction — one document per (user, emoji) pair. A user can react
// with multiple emojis; toggling the same emoji off removes their entry.
const reactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  emoji:  { type: String, required: true, maxlength: 8 },
  reactedAt: { type: Date, default: Date.now },
}, { _id: false });

// Small snapshot of the parent message used for reply previews. Kept
// denormalised on the child so the reply chip renders without a second
// query — the source message can be deleted later and we still show
// "Original message" gracefully.
const replySnapshotSchema = new mongoose.Schema({
  messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  senderId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  preview:   { type: String, maxlength: 200, default: '' },
  type:      { type: String, default: 'text' },
}, { _id: false });

// Provenance for forwarded messages — the receiver sees "Forwarded from …".
const forwardMetaSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  fromChatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat' },
  originalMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  hops: { type: Number, default: 1, min: 1, max: 20 },
}, { _id: false });

// ── Main schema ─────────────────────────────────────────────────────────────

const messageSchema = new mongoose.Schema({
  chatId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Chat',
    required: true,
    index:    true,
  },

  senderId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
  },

  // ── Idempotency ────────────────────────────────────────────────────────
  // Client-supplied UUID. Two writes with the same key from the same sender
  // are collapsed to one — protects against the "spinner froze so the user
  // tapped send twice" duplicate. Sparse so old messages without the field
  // don't collide on a null key.
  clientMsgId: {
    type:   String,
    default: null,
    index:  { unique: true, sparse: true },
  },

  // ── Content ────────────────────────────────────────────────────────────
  text: {
    type:      String,
    default:   '',
    trim:      true,
    maxlength: 5000,
  },

  type: {
    type:    String,
    enum:    ['text', 'image', 'video', 'voice', 'audio', 'gif', 'document'],
    default: 'text',
    index:   true,
  },

  // If type === 'video', reference the shared TrueVision video document.
  videoId: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'Video',
    default: null,
  },

  // Image (chat photo) — Cloudinary secure_url + public_id.
  // The validator rejects file:// URIs so the "phone-local path leaked to
  // the DB" bug can never regress: a bad write fails loudly.
  imageUrl: {
    type:    String,
    default: null,
    validate: {
      validator: (v) => !v || !/^file:\/\//i.test(v),
      message:   'imageUrl must be a hosted URL — file:// paths are not accepted',
    },
  },
  imagePublicId: { type: String, default: null },
  imageWidth:    { type: Number, default: 0 },
  imageHeight:   { type: Number, default: 0 },

  // Voice notes / audio clips. Voice = short push-to-talk; audio = generic.
  audioUrl:       { type: String, default: null },
  audioPublicId:  { type: String, default: null },
  audioDuration:  { type: Number, default: 0 },   // seconds
  waveform:       { type: [Number], default: [] }, // optional visual data

  // GIFs — lightweight animated image (Giphy/Tenor mirror or Cloudinary).
  gifUrl: { type: String, default: null },

  // Documents (PDF, docx, xlsx, zip, etc). name + size + mime are shown
  // in the bubble; publicId lets us delete the raw asset on unsend.
  documentUrl:      { type: String, default: null },
  documentPublicId: { type: String, default: null },
  documentName:     { type: String, default: '' },
  documentSize:     { type: Number, default: 0 },
  documentMime:     { type: String, default: '' },

  // ── Threading / relations ──────────────────────────────────────────────
  replyTo:      { type: replySnapshotSchema, default: null },
  forwardedFrom: { type: forwardMetaSchema,  default: null },

  // ── Reactions / star / pin ─────────────────────────────────────────────
  reactions: { type: [reactionSchema], default: [] },
  // Users that starred this message individually (private).
  starredBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
  // Chat-wide pinned flag — visible to every member.
  pinned:   { type: Boolean, default: false, index: true },
  pinnedAt: { type: Date,    default: null },
  pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // ── Edit history ───────────────────────────────────────────────────────
  edited:   { type: Boolean, default: false },
  editedAt: { type: Date,    default: null },

  // ── Delivery status — sent → delivered → seen ─────────────────────────
  status: {
    type:    String,
    enum:    ['sent', 'delivered', 'seen'],
    default: 'sent',
    index:   true,
  },
  deliveredAt: { type: Date, default: null },
  // Legacy boolean kept during migration. Derives from status='seen'.
  seen:   { type: Boolean, default: false },
  seenAt: { type: Date,    default: null },

  // ── Deletion state ─────────────────────────────────────────────────────
  // `deleted` is the "delete for everyone" flag — shows the tombstone bubble.
  // `deletedFor` is the per-user "delete for me" set — hides the message
  // only for that user; others still see it.
  deleted:    { type: Boolean, default: false },
  deletedFor: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },

}, { timestamps: true });

// ── Indexes ─────────────────────────────────────────────────────────────────
// Pagination on the chat timeline.
messageSchema.index({ chatId: 1, createdAt: -1 });
// "Find unseen messages for a user" — hit by flushPendingDeliveries on reconnect.
messageSchema.index({ chatId: 1, status: 1 });
// Text search inside a chat (used by "search in chat").
messageSchema.index({ chatId: 1, text: 'text' });

module.exports = mongoose.model('Message', messageSchema);
