// Backend/services/refreshTokens.js
//
// Refresh-token lifecycle: issue, rotate (with reuse detection), and revoke.
// Tokens are opaque random secrets; only their SHA-256 hash is stored.
//
// ROTATION: every /auth/refresh exchanges the presented token for a brand-new
// one in the same family and marks the old one rotated.
//
// REUSE DETECTION: if an already-rotated or revoked token is presented, that
// normally means a leaked token is being replayed → the entire family is
// revoked so both the attacker and the victim are forced to re-authenticate.
//
// GRACE WINDOW: a legitimate client can present a just-rotated token if the
// previous refresh RESPONSE was lost (flaky network) before it stored the new
// one. To avoid logging honest users out on a dropped packet, a replay within
// REFRESH_GRACE_MS of rotation is treated as a retry and re-rotated instead of
// killing the family. Reliability first; the family still dies on a genuine
// (old) replay and on explicit logout / password change.

const crypto = require('crypto');
const RefreshToken = require('../models/RefreshToken');

const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10);
const REFRESH_GRACE_MS = parseInt(process.env.REFRESH_GRACE_MS || '20000', 10); // 20s

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = () => crypto.randomBytes(48).toString('base64url'); // ~64 chars, url-safe

const codedError = (code) => { const e = new Error(code); e.code = code; return e; };

const deviceCols = (req) => ({
  deviceName: String(req?.body?.deviceName || req?.get?.('x-device-name') || '').slice(0, 120),
  userAgent:  String(req?.headers?.['user-agent'] || '').slice(0, 300),
  ip:         String(req?.ip || '').slice(0, 60),
});

/**
 * Issue a fresh refresh token for a user session.
 * @returns {Promise<string>} the RAW token (only time it exists in plaintext).
 */
async function issue(user, { familyId, sessionIat, req } = {}) {
  const raw = randomToken();
  await RefreshToken.create({
    userId:    user._id || user,
    tokenHash: sha256(raw),
    familyId:  familyId || crypto.randomUUID(),
    sessionIat: sessionIat ?? null,
    expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400000),
    ...deviceCols(req),
  });
  return raw;
}

/**
 * Rotate a presented refresh token. Returns { userId, familyId, sessionIat,
 * refreshToken (new raw) } or throws a coded error:
 *   REFRESH_INVALID | REFRESH_EXPIRED | REFRESH_REUSED
 */
async function rotate(rawToken, { req } = {}) {
  if (!rawToken || typeof rawToken !== 'string') throw codedError('REFRESH_INVALID');

  const row = await RefreshToken.findOne({ tokenHash: sha256(rawToken) });
  if (!row) throw codedError('REFRESH_INVALID');

  // Already revoked → the family is (or should be) dead. Kill it defensively.
  if (row.revokedAt) {
    await revokeFamily(row.familyId);
    throw codedError('REFRESH_REUSED');
  }

  // Already rotated → reuse, UNLESS within the grace window (lost-response retry).
  if (row.rotatedAt) {
    const age = Date.now() - new Date(row.rotatedAt).getTime();
    if (age > REFRESH_GRACE_MS) {
      await revokeFamily(row.familyId);
      throw codedError('REFRESH_REUSED');
    }
    // within grace → fall through and re-issue (honest retry).
  }

  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
    throw codedError('REFRESH_EXPIRED');
  }

  // Mint the successor in the same family.
  const raw = randomToken();
  const successor = await RefreshToken.create({
    userId:     row.userId,
    tokenHash:  sha256(raw),
    familyId:   row.familyId,
    sessionIat: row.sessionIat,
    expiresAt:  row.expiresAt,          // keep the family's absolute expiry
    ...deviceCols(req),
  });

  if (!row.rotatedAt) {
    row.rotatedAt  = new Date();
    row.replacedBy = successor._id;
    await row.save();
  }

  return {
    userId:       row.userId,
    familyId:     row.familyId,
    sessionIat:   row.sessionIat,
    refreshToken: raw,
  };
}

/** Revoke every live token in a family. */
async function revokeFamily(familyId) {
  if (!familyId) return;
  await RefreshToken.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/** Revoke the family a raw token belongs to (used on single-device logout). */
async function revokeByRaw(rawToken) {
  if (!rawToken) return;
  const row = await RefreshToken.findOne({ tokenHash: sha256(rawToken) }).select('familyId');
  if (row) await revokeFamily(row.familyId);
}

/** Revoke ALL refresh tokens for a user (password change / logout-all / reset). */
async function revokeAllForUser(userId) {
  if (!userId) return;
  await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

module.exports = { issue, rotate, revokeFamily, revokeByRaw, revokeAllForUser, sha256 };
