// Backend/models/SupportTicket.js
//
// One row per user-submitted support request. Covers both the "Contact Us"
// form (type: 'contact') and "Report a Problem" bug reports (type: 'bug').
// Attachments are already-uploaded Cloudinary assets (the client uploads
// directly via a signed URL, then sends us the resulting url/publicId).
//
// Admin workflow: staff (role 'admin') can list all tickets, reply (pushes a
// reply + flips status to 'in_progress'), assign, and change status/priority.

const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema({
  url:          { type: String, required: true },
  publicId:     { type: String, default: '' },
  resourceType: { type: String, enum: ['image', 'video', 'raw'], default: 'image' },
  kind:         { type: String, enum: ['screenshot', 'recording', 'log', 'file'], default: 'file' },
  name:         { type: String, default: '' },
  size:         { type: Number, default: 0 },
  mime:         { type: String, default: '' },
}, { _id: false });

const replySchema = new mongoose.Schema({
  authorId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorRole: { type: String, enum: ['user', 'admin'], default: 'admin' },
  message:    { type: String, required: true, trim: true, maxlength: 5000 },
}, { timestamps: true });

// Diagnostics captured automatically by the client at submit time.
const diagnosticsSchema = new mongoose.Schema({
  device:      { type: String, default: '' },   // e.g. "Samsung SM-G991B"
  platform:    { type: String, default: '' },   // 'android' | 'ios' | 'web'
  osVersion:   { type: String, default: '' },
  appVersion:  { type: String, default: '' },
  buildNumber: { type: String, default: '' },
  network:     { type: String, default: '' },   // 'wifi' | 'cellular' | 'none'
  locale:      { type: String, default: '' },
}, { _id: false });

const CATEGORIES = [
  'account', 'videos', 'comments', 'messaging', 'privacy',
  'security', 'uploads', 'notifications', 'payments', 'bug', 'other',
];

const supportTicketSchema = new mongoose.Schema({
  // Origin form.
  type: { type: String, enum: ['contact', 'bug'], required: true, index: true },

  title:       { type: String, required: [true, 'Subject is required'], trim: true, maxlength: 200 },
  description: { type: String, required: [true, 'Message is required'],  trim: true, maxlength: 8000 },

  category: { type: String, enum: CATEGORIES, default: 'other', index: true },

  email: { type: String, trim: true, lowercase: true, default: '' },

  attachments: { type: [attachmentSchema], default: [] },

  // Bug reports may include a captured console/crash log blob.
  logs: { type: String, default: '', maxlength: 100000 },

  diagnostics: { type: diagnosticsSchema, default: () => ({}) },

  status:   { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open', index: true },
  priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },

  createdBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  replies: { type: [replySchema], default: [] },
}, { timestamps: true });

// Fast "my tickets, newest first" + admin queue queries.
supportTicketSchema.index({ createdBy: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, priority: -1, createdAt: -1 });

supportTicketSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
module.exports.CATEGORIES = CATEGORIES;
