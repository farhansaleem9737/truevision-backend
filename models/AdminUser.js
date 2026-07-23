// Backend/models/AdminUser.js
//
// Administrators of the moderation panel — a SEPARATE identity space from app
// Users (different collection, different JWT signed with ADMIN_SECRET). Normal
// users can never authenticate here.
//
// The first admin is seeded from ADMIN_USERNAME / ADMIN_PASSWORD on server
// start (see services/adminSeed.js). Passwords are always bcrypt-hashed —
// never stored or logged in plaintext.

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const adminUserSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
  passwordHash: { type: String, required: true },
  role: {
    type:    String,
    enum:    ['moderator', 'admin', 'superadmin'],
    default: 'admin',
  },
  active:      { type: Boolean, default: true },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

// Set/replace the password (hashes with bcrypt).
adminUserSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(String(plain), 12);
};

// Constant-time password check.
adminUserSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(String(plain), this.passwordHash);
};

// Never leak the hash in JSON responses.
adminUserSchema.methods.toSafeJSON = function toSafeJSON() {
  return { _id: this._id, username: this.username, role: this.role, active: this.active, lastLoginAt: this.lastLoginAt };
};

module.exports = mongoose.model('AdminUser', adminUserSchema);
