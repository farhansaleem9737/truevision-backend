//Backend/models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
  fullName: {
    type: String,
    required: [true, 'Full name is required'],
    trim: true,
    minlength: [2, 'Full name must be at least 2 characters'],
    maxlength: [50, 'Full name cannot exceed 50 characters']
  },
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    lowercase: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [30, 'Username cannot exceed 30 characters'],
    match: [/^[a-z0-9_]+$/, 'Username can only contain lowercase letters, numbers, and underscores']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address']
  },
  country: {
    type: String,
    required: [true, 'Country is required'],
    trim: true
  },
  password: {
    type: String,
    // Required only for local accounts. Google-signed-in accounts may not
    // have one set at first; the controller stamps a random placeholder so
    // the field is never empty, but the user is steered to "Forgot Password"
    // if they ever want a local credential.
    required: function () { return this.authProvider === 'local'; },
    minlength: [8, 'Password must be at least 8 characters'],
    select: false
  },
  // ── OAuth (Google) ─────────────────────────────────────────────────────
  // googleId is set when the user signs in with Google. We store it so that
  // a second Google sign-in resolves to the same account even if email
  // changes. Sparse index allows local accounts to omit this field.
  googleId: {
    type:   String,
    index:  { sparse: true, unique: true },
    select: false,
  },
  // Which sign-in flow created or last linked this account.
  // 'local'  — email + password
  // 'google' — Google OAuth (account may also have a local password if linked)
  authProvider: {
    type:    String,
    enum:    ['local', 'google'],
    default: 'local',
  },
  profileImage: {
    type: String,
    default: null,
  },
  profileImagePublicId: {
    type: String,
    default: null,      // Cloudinary public_id — used to delete old image on update
  },
  bio: {
    type: String,
    default: '',
    maxlength: [150, 'Bio cannot exceed 150 characters'],
    trim: true,
  },
  role: {
    type: String,
    enum: ['user', 'creator', 'admin'],
    default: 'user'
  },
  // Verified-account badge (also gates the "verified" checkmark in the UI).
  // NOTE: this field previously appeared twice in the schema (once here, once
  // in the chat/social block) — the duplicate silently overrode this one.
  // Single definition now, with the index the duplicate carried.
  isVerified: {
    type: Boolean,
    default: false,
    index: true
  },
  verificationOTP: {
    type: String,
    select: false
  },
  verificationOTPExpires: {
    type: Date,
    select: false
  },
  resetPasswordOTP: {
    type: String,
    select: false
  },
  resetPasswordOTPExpires: {
    type: Date,
    select: false
  },
  lastLogin: {
    type: Date
  },
  isOnline: {
    type: Boolean,
    default: false,
    index: true,
  },
  lastSeen: {
    type: Date,
    default: null,
  },
  followers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  following: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  // ── Language ───────────────────────────────────────────────────────────
  // Canonical UI language for this account (ISO 639-1). This is the single
  // source of truth that the i18n system restores on login. The legacy
  // `preferences.language` mirror is kept in sync by SettingsController for
  // backward-compat but new code should read/write this field.
  language: {
    type:    String,
    enum:    ['en', 'ur', 'ar', 'hi', 'tr', 'fr'],
    default: 'en',
  },

  // Preferences blob — privacy, notifications, content, language.
  // Mixed type lets the client send partial updates that the controller deep-merges.
  preferences: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },

  // ── Chat / social state ────────────────────────────────────────────────
  // Users this account has blocked. Messaging + presence queries filter
  // both directions, so a blocked pair effectively becomes invisible.
  blockedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref:  'User',
  }],

  // Incoming follow requests (private accounts only). Public accounts gain
  // followers instantly and never touch this array. Each entry is the
  // requesting user + when they asked; accept moves them into `followers`,
  // decline simply removes the entry.
  followRequests: [{
    from:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, default: Date.now },
  }],

  // ── Push notifications ─────────────────────────────────────────────────
  // Expo push tokens (ExponentPushToken[...]) — one per installed device.
  // We store an array so the same account signed-in on multiple phones
  // still gets notified on every device. Legacy `fcmTokens` are kept
  // separately for a future dev-client / bare-workflow path (Firebase
  // Messaging natively). Both are consulted when we fan out a push.
  expoPushTokens: [{ type: String }],
  fcmTokens:      [{ type: String }],

  // ── Security module ──────────────────────────────────────────────────────
  // Two-factor authentication (email OTP). The OTP itself is stored as a
  // sha256 hash — unlike the legacy verification/reset OTPs above, a DB leak
  // must not reveal live codes.
  twoFactorEnabled:    { type: Boolean, default: false },
  twoFactorOTP:        { type: String,  select: false, default: null },  // sha256 hex
  twoFactorOTPExpires: { type: Date,    select: false, default: null },

  // Set on every password change; any JWT whose iat predates
  // tokenInvalidBefore is rejected by middleware/Auth.protect — this is what
  // makes "change password → every device logs out" and "log out from all
  // devices" work without tracking individual tokens.
  passwordChangedAt:  { type: Date, default: null },
  tokenInvalidBefore: { type: Date, default: null },

  // Phone verification. Number stored E.164-ish (+<country><number>).
  // OTP hashed the same way as 2FA.
  phoneNumber:      { type: String,  default: null, trim: true, maxlength: 20 },
  phoneCountryCode: { type: String,  default: null, trim: true, maxlength: 6 },
  phoneVerified:    { type: Boolean, default: false },
  phoneOTP:         { type: String,  select: false, default: null },
  phoneOTPExpires:  { type: Date,    select: false, default: null },
  // Where the phone OTP is pending for — set at send-phone-otp so verify
  // can't be tricked into confirming a different number than the one the
  // code was issued for.
  phonePending:     { type: String,  select: false, default: null },

  // Weekly email report bookkeeping (preferences.notifications.emailWeekly).
  lastWeeklyReportAt: { type: Date, default: null },
}, {
  timestamps: true
});

// UPDATED: Remove 'next' parameter for Mongoose 8.x
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.generateVerificationOTP = function() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  this.verificationOTP = otp;
  this.verificationOTPExpires = Date.now() + 15 * 60 * 1000;
  return otp;
};

userSchema.methods.generateResetPasswordOTP = function() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  this.resetPasswordOTP = otp;
  this.resetPasswordOTPExpires = Date.now() + 15 * 60 * 1000;
  return otp;
};

userSchema.methods.verifyOTP = function(otp, type = 'verification') {
  const otpField = type === 'verification' ? 'verificationOTP' : 'resetPasswordOTP';
  const expiresField = type === 'verification' ? 'verificationOTPExpires' : 'resetPasswordOTPExpires';

  if (this[otpField] !== otp) {
    return { success: false, message: 'Invalid OTP' };
  }

  if (Date.now() > this[expiresField]) {
    return { success: false, message: 'OTP has expired' };
  }

  return { success: true };
};

// ── Hashed OTPs for the Security module (2FA + phone) ───────────────────────
// sha256 rather than bcrypt: OTPs are 6 digits with a 10-minute life, so the
// threat is DB exposure of a live code, not offline brute force — a fast hash
// is fine and keeps the verify path cheap.
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Generate + store a hashed OTP for 'twoFactor' | 'phone'. Returns the plain code for delivery. */
userSchema.methods.generateHashedOTP = function(kind) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  if (kind === 'phone') {
    this.phoneOTP        = sha256(otp);
    this.phoneOTPExpires = new Date(Date.now() + OTP_TTL_MS);
  } else {
    this.twoFactorOTP        = sha256(otp);
    this.twoFactorOTPExpires = new Date(Date.now() + OTP_TTL_MS);
  }
  return otp;
};

/** Constant-shape verifier for hashed OTPs. Clears the stored code on success. */
userSchema.methods.verifyHashedOTP = function(kind, otp) {
  const hashField   = kind === 'phone' ? 'phoneOTP'        : 'twoFactorOTP';
  const expiryField = kind === 'phone' ? 'phoneOTPExpires' : 'twoFactorOTPExpires';

  if (!this[hashField] || !this[expiryField]) {
    return { success: false, message: 'No code was requested. Tap resend to get a new one.' };
  }
  if (Date.now() > new Date(this[expiryField]).getTime()) {
    return { success: false, message: 'Code expired. Tap resend to get a new one.' };
  }
  if (this[hashField] !== sha256(otp)) {
    return { success: false, message: 'Incorrect code. Check the digits and try again.' };
  }
  // One-time use.
  this[hashField]   = null;
  this[expiryField] = null;
  return { success: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// CACHE INVALIDATION HOOK — drops the user:byId:<id> entry so /users/me
// returns fresh data after any profile / image / preferences change.
// Lazy require avoids circular imports with services/cache.
// ─────────────────────────────────────────────────────────────────────────────
function invalidateUser(doc) {
  if (!doc?._id) return;
  try {
    const cache = require('../services/cache');
    cache.del(`user:byId:${doc._id}`).catch(() => {});
  } catch (_) { /* cache is optional */ }
}
userSchema.post('save',             function (doc) { invalidateUser(doc); });
userSchema.post('findOneAndUpdate', function (doc) { invalidateUser(doc); });

module.exports = mongoose.model('User', userSchema);