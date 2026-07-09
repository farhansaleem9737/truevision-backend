//Backend/models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
  isVerified: {
    type: Boolean,
    default: false
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

  // Verified-account badge (Instagram/Twitter-style). Reserved field —
  // no self-serve flow yet; toggled manually or by a future review process.
  isVerified: { type: Boolean, default: false, index: true },

  // ── Push notifications ─────────────────────────────────────────────────
  // Expo push tokens (ExponentPushToken[...]) — one per installed device.
  // We store an array so the same account signed-in on multiple phones
  // still gets notified on every device. Legacy `fcmTokens` are kept
  // separately for a future dev-client / bare-workflow path (Firebase
  // Messaging natively). Both are consulted when we fan out a push.
  expoPushTokens: [{ type: String }],
  fcmTokens:      [{ type: String }],
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