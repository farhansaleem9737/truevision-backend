// Backend/controllers/SupportController.js
//
// Help & Support backend:
//   POST /api/support/contact   — create a Contact Us ticket
//   POST /api/support/report    — create a bug report
//   GET  /api/support/tickets   — list MY tickets (paginated)
//   GET  /api/support/tickets/:id — one of MY tickets (or any, for admins)
//   GET  /api/support/faqs      — Help Center FAQ (public)
//   Admin:
//   GET   /api/support/admin/tickets     — full queue (role: admin)
//   POST  /api/support/tickets/:id/reply — reply to a ticket (admin)
//   PATCH /api/support/tickets/:id       — update status/priority/assignee (admin)
//
// Attachments are already on Cloudinary (client uploads via a signed URL and
// sends us the resulting url/publicId) — we only validate + persist metadata.

const mongoose      = require('mongoose');
const SupportTicket = require('../models/SupportTicket');
const faqs          = require('../data/faqs');

const ok   = (res, data, code = 200) => res.status(code).json({ success: true,  ...data });
const fail = (res, msg,  code = 400) => res.status(code).json({ success: false, message: msg });

const isObjectId = (s) => mongoose.Types.ObjectId.isValid(s);
const CATEGORIES = SupportTicket.CATEGORIES;

const pageParams = (req, maxLimit = 50) => {
  const page  = Math.max(parseInt(req.query.page)  || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
};

// Validate + normalize a client-supplied attachments array. Silently drops
// malformed entries so one bad item can't fail the whole submit.
const cleanAttachments = (raw) => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a.url === 'string' && /^https?:\/\//.test(a.url))
    .slice(0, 10) // hard cap
    .map((a) => ({
      url:          a.url,
      publicId:     typeof a.publicId === 'string' ? a.publicId : '',
      resourceType: ['image', 'video', 'raw'].includes(a.resourceType) ? a.resourceType : 'image',
      kind:         ['screenshot', 'recording', 'log', 'file'].includes(a.kind) ? a.kind : 'file',
      name:         typeof a.name === 'string' ? a.name.slice(0, 200) : '',
      size:         Number(a.size) || 0,
      mime:         typeof a.mime === 'string' ? a.mime.slice(0, 100) : '',
    }));
};

const cleanDiagnostics = (raw) => {
  const d = raw && typeof raw === 'object' ? raw : {};
  const str = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : '');
  return {
    device:      str(d.device),
    platform:    str(d.platform, 20),
    osVersion:   str(d.osVersion, 40),
    appVersion:  str(d.appVersion, 40),
    buildNumber: str(d.buildNumber, 40),
    network:     str(d.network, 20),
    locale:      str(d.locale, 20),
  };
};

const normalizeCategory = (c) =>
  CATEGORIES.includes(String(c || '').toLowerCase()) ? String(c).toLowerCase() : 'other';

const shapeTicket = (t) => ({
  _id:         t._id,
  type:        t.type,
  title:       t.title,
  description: t.description,
  category:    t.category,
  email:       t.email,
  attachments: t.attachments,
  logs:        t.logs ? true : false,   // don't ship the raw log blob back to the list
  diagnostics: t.diagnostics,
  status:      t.status,
  priority:    t.priority,
  replies:     t.replies,
  createdAt:   t.createdAt,
  updatedAt:   t.updatedAt,
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/support/contact
// ═════════════════════════════════════════════════════════════════════════════
exports.createContact = async (req, res) => {
  try {
    const { subject, title, message, description, category, email, attachments, diagnostics, priority } = req.body || {};

    const finalTitle = String(subject || title || '').trim();
    const finalBody  = String(message || description || '').trim();
    if (finalTitle.length < 3)  return fail(res, 'Please enter a subject (at least 3 characters).');
    if (finalBody.length < 10)  return fail(res, 'Please describe your issue (at least 10 characters).');

    const ticket = await SupportTicket.create({
      type:        'contact',
      title:       finalTitle.slice(0, 200),
      description: finalBody.slice(0, 8000),
      category:    normalizeCategory(category),
      email:       String(email || '').trim().toLowerCase().slice(0, 254),
      attachments: cleanAttachments(attachments),
      diagnostics: cleanDiagnostics(diagnostics),
      priority:    ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal',
      createdBy:   req.user.id,
    });

    return ok(res, { ticket: shapeTicket(ticket), message: 'Your message has been sent.' }, 201);
  } catch (err) {
    console.error('createContact error:', err);
    return fail(res, 'Failed to submit your message', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/support/report  (bug report)
// ═════════════════════════════════════════════════════════════════════════════
exports.createReport = async (req, res) => {
  try {
    const { subject, title, message, description, category, email, attachments, diagnostics, logs, priority } = req.body || {};

    const finalTitle = String(subject || title || '').trim() || 'Bug report';
    const finalBody  = String(message || description || '').trim();
    if (finalBody.length < 10) return fail(res, 'Please describe the problem (at least 10 characters).');

    const ticket = await SupportTicket.create({
      type:        'bug',
      title:       finalTitle.slice(0, 200),
      description: finalBody.slice(0, 8000),
      category:    category ? normalizeCategory(category) : 'bug',
      email:       String(email || '').trim().toLowerCase().slice(0, 254),
      attachments: cleanAttachments(attachments),
      logs:        typeof logs === 'string' ? logs.slice(0, 100000) : '',
      diagnostics: cleanDiagnostics(diagnostics),
      // Bugs default to higher priority so they surface in the queue.
      priority:    ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'high',
      createdBy:   req.user.id,
    });

    return ok(res, { ticket: shapeTicket(ticket), message: 'Your report has been submitted. Thank you!' }, 201);
  } catch (err) {
    console.error('createReport error:', err);
    return fail(res, 'Failed to submit your report', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/support/tickets  — my tickets
// ═════════════════════════════════════════════════════════════════════════════
exports.listTickets = async (req, res) => {
  try {
    const { page, limit, skip } = pageParams(req);
    const filter = { createdBy: req.user.id };
    if (req.query.type && ['contact', 'bug'].includes(req.query.type)) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;

    const [rows, total] = await Promise.all([
      SupportTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupportTicket.countDocuments(filter),
    ]);

    return ok(res, {
      tickets: rows.map(shapeTicket),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('listTickets error:', err);
    return fail(res, 'Failed to fetch tickets', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/support/tickets/:id
// ═════════════════════════════════════════════════════════════════════════════
exports.getTicket = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return fail(res, 'Invalid ticket id');

    const ticket = await SupportTicket.findById(id).lean();
    if (!ticket) return fail(res, 'Ticket not found', 404);

    const isOwner = String(ticket.createdBy) === String(req.user.id);
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return fail(res, 'Ticket not found', 404);

    return ok(res, { ticket: shapeTicket(ticket) });
  } catch (err) {
    console.error('getTicket error:', err);
    return fail(res, 'Failed to fetch ticket', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/support/faqs  (public) — optional ?category= & ?q= filtering
// ═════════════════════════════════════════════════════════════════════════════
exports.getFaqs = (req, res) => {
  try {
    const category = String(req.query.category || '').toLowerCase();
    const q        = String(req.query.q || '').trim().toLowerCase();

    let articles = faqs.articles;
    if (category) articles = articles.filter((a) => a.category === category);
    if (q) {
      articles = articles.filter(
        (a) => a.question.toLowerCase().includes(q) || a.answer.toLowerCase().includes(q),
      );
    }

    return ok(res, {
      version:    faqs.version,
      updatedAt:  faqs.updatedAt,
      categories: faqs.categories,
      articles,
      popular:    faqs.articles.filter((a) => a.popular),
    });
  } catch (err) {
    console.error('getFaqs error:', err);
    return fail(res, 'Failed to fetch FAQs', 500);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN
// ═════════════════════════════════════════════════════════════════════════════
const requireAdmin = (req, res) => {
  if (req.user.role !== 'admin') { fail(res, 'Admin access required', 403); return false; }
  return true;
};

// GET /api/support/admin/tickets
exports.adminListTickets = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { page, limit, skip } = pageParams(req, 100);
    const filter = {};
    if (req.query.status)   filter.status   = req.query.status;
    if (req.query.type)     filter.type     = req.query.type;
    if (req.query.priority) filter.priority = req.query.priority;

    const [rows, total] = await Promise.all([
      SupportTicket.find(filter)
        .sort({ priority: -1, createdAt: -1 })
        .skip(skip).limit(limit)
        .populate('createdBy', 'username fullName email')
        .lean(),
      SupportTicket.countDocuments(filter),
    ]);

    return ok(res, {
      tickets: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('adminListTickets error:', err);
    return fail(res, 'Failed to fetch tickets', 500);
  }
};

// POST /api/support/tickets/:id/reply  — admin reply (flips to in_progress)
exports.replyToTicket = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { id } = req.params;
    const message = String(req.body?.message || '').trim();
    if (!isObjectId(id)) return fail(res, 'Invalid ticket id');
    if (message.length < 1) return fail(res, 'Reply message is required');

    const ticket = await SupportTicket.findByIdAndUpdate(
      id,
      {
        $push: { replies: { authorId: req.user.id, authorRole: 'admin', message: message.slice(0, 5000) } },
        $set:  { status: 'in_progress', assignedTo: req.user.id },
      },
      { new: true },
    ).lean();
    if (!ticket) return fail(res, 'Ticket not found', 404);

    return ok(res, { ticket: shapeTicket(ticket) });
  } catch (err) {
    console.error('replyToTicket error:', err);
    return fail(res, 'Failed to reply', 500);
  }
};

// PATCH /api/support/tickets/:id  — admin update status/priority/assignee
exports.updateTicket = async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const { id } = req.params;
    if (!isObjectId(id)) return fail(res, 'Invalid ticket id');

    const patch = {};
    if (['open', 'in_progress', 'resolved', 'closed'].includes(req.body?.status)) patch.status = req.body.status;
    if (['low', 'normal', 'high', 'urgent'].includes(req.body?.priority))          patch.priority = req.body.priority;
    if (req.body?.assignedTo && isObjectId(req.body.assignedTo))                    patch.assignedTo = req.body.assignedTo;
    if (!Object.keys(patch).length) return fail(res, 'No valid fields to update');

    const ticket = await SupportTicket.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
    if (!ticket) return fail(res, 'Ticket not found', 404);

    return ok(res, { ticket: shapeTicket(ticket) });
  } catch (err) {
    console.error('updateTicket error:', err);
    return fail(res, 'Failed to update ticket', 500);
  }
};
