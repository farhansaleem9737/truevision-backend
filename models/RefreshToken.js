// Backend/models/RefreshToken.js
//
// Server-side refresh-token store for the access/refresh auth architecture.
//
//   • Only the SHA-256 HASH of the opaque refresh secret is stored — the raw
//     token is returned to the client exactly once at issue/rotate time and
//     never persisted, so a database leak cannot mint access tokens.
//   • `familyId` groups a rotation lineage. Presenting an already-rotated or
//     revoked token from a family triggers reuse-detection: the whole family
//     is revoked (see services/refreshTokens.js).
//   • A Mongo TTL index on `expiresAt` auto-purges expired rows.
//
// This layer is ADDITIVE — the short-lived access JWT is still verified exactly
// as before (middleware/Auth.js is untouched). Refresh only mints new access
// tokens; it never changes how they're validated.

const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },   // sha256(raw)
  familyId:  { type: String, required: true, index: true },    // rotation lineage

  // Links the family back to a LoginSession row (JWT iat seconds) so refreshed
  // access tokens keep an honest Login-Activity lineage.
  sessionIat: { type: Number, default: null },

  expiresAt:  { type: Date, required: true },                  // absolute family expiry
  rotatedAt:  { type: Date, default: null },                  // set when this token was exchanged
  revokedAt:  { type: Date, default: null },                  // set on logout / password change / reuse
  replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'RefreshToken', default: null },

  // Best-effort device attribution (mirrors LoginSession columns).
  deviceName: { type: String, default: '' },
  userAgent:  { type: String, default: '' },
  ip:         { type: String, default: '' },
}, { timestamps: true });

// Auto-purge expired rows (Mongo TTL). `expireAfterSeconds: 0` = delete once
// `expiresAt` is in the past.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);
