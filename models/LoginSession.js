// Backend/models/LoginSession.js
//
// One row per successful sign-in (password, Google, email-verify, 2FA).
// Powers the Security screen's "Login Activity" list and gives logout-all
// something concrete to revoke.
//
// "Current session" detection: the JWT carries an `iat` (issued-at, seconds).
// We persist that same value here as `tokenIat`; a request's session is the
// row whose tokenIat matches the presented token. No token material is
// stored — knowing iat alone cannot forge a JWT.
//
// Geo fields are best-effort (ip-api.com with a 2s timeout at login);
// blank when the lookup fails or the IP is LAN/localhost.

const mongoose = require('mongoose');

const loginSessionSchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },

  // Matches the JWT's iat claim (seconds since epoch). Unique per user in
  // practice (two sign-ins in the same second on the same account are
  // indistinguishable — acceptable for an activity log).
  tokenIat: { type: Number, required: true, index: true },

  // ── Device ────────────────────────────────────────────────────────────
  deviceName:  { type: String, default: '',  maxlength: 120 }, // "Samsung SM-A515F"
  deviceOS:    { type: String, default: '',  maxlength: 60  }, // "Android 14" / "iOS 17.4"
  appVersion:  { type: String, default: '',  maxlength: 30  },
  userAgent:   { type: String, default: '',  maxlength: 300 }, // web / unknown clients

  // ── Network / location (best-effort) ─────────────────────────────────
  ip:      { type: String, default: '', maxlength: 60 },
  city:    { type: String, default: '', maxlength: 80 },
  region:  { type: String, default: '', maxlength: 80 },
  country: { type: String, default: '', maxlength: 80 },

  // ── Lifecycle ─────────────────────────────────────────────────────────
  loginAt:      { type: Date, default: Date.now },
  logoutAt:     { type: Date, default: null },
  revokedAt:    { type: Date, default: null },   // set by logout-all / remote revoke
  lastActiveAt: { type: Date, default: Date.now },

  // How the session was created — useful in the details view.
  method: {
    type:    String,
    enum:    ['password', 'google', 'email-verify', '2fa'],
    default: 'password',
  },
}, { timestamps: true });

// Activity list reads: newest first for one user.
loginSessionSchema.index({ userId: 1, loginAt: -1 });
// Session resolution on revoke: (userId, tokenIat).
loginSessionSchema.index({ userId: 1, tokenIat: 1 });

// Cap stored history: keep the latest 50 sessions per user. Called
// fire-and-forget after each insert.
loginSessionSchema.statics.trimOld = async function (userId, keep = 50) {
  const excess = await this.find({ userId })
    .sort({ loginAt: -1 })
    .skip(keep)
    .select('_id')
    .lean();
  if (excess.length) {
    await this.deleteMany({ _id: { $in: excess.map((d) => d._id) } });
  }
};

module.exports = mongoose.model('LoginSession', loginSessionSchema);
