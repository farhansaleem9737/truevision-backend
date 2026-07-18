// Backend/services/sessionTracker.js
//
// Records a LoginSession row for every successful sign-in and resolves
// best-effort geo data for the client IP.
//
// Device info arrives from the app via headers set in AuthServices:
//   x-device-name  — "Samsung SM-A515F" (expo-device modelName)
//   x-device-os    — "Android 14"
//   x-app-version  — "1.0.0"
// Web / unknown clients fall back to the User-Agent string.
//
// Geo: ip-api.com free endpoint (no key, 45 req/min) with a hard 2.5s
// timeout. LAN/localhost IPs skip the lookup entirely. Every failure path
// degrades to blank strings — a login must NEVER fail because geo did.

const LoginSession = require('../models/LoginSession');

// ── IP extraction ───────────────────────────────────────────────────────────
const clientIp = (req) => {
  const fwd = req.headers['x-forwarded-for'];
  const raw = (typeof fwd === 'string' && fwd.split(',')[0].trim()) ||
              req.socket?.remoteAddress || '';
  // Normalise IPv6-mapped IPv4 (::ffff:192.168.1.5 → 192.168.1.5)
  return raw.replace(/^::ffff:/i, '');
};

const isPrivateIp = (ip) =>
  !ip ||
  ip === '::1' ||
  ip === '127.0.0.1' ||
  /^10\./.test(ip) ||
  /^192\.168\./.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
  /^169\.254\./.test(ip) ||
  /^f[cd]/i.test(ip); // IPv6 ULA

// ── Geo lookup (best-effort) ────────────────────────────────────────────────
const geoForIp = async (ip) => {
  if (isPrivateIp(ip)) return { city: '', region: '', country: '' };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`,
      { signal: controller.signal },
    );
    clearTimeout(t);
    if (!res.ok) return { city: '', region: '', country: '' };
    const body = await res.json();
    if (body.status !== 'success') return { city: '', region: '', country: '' };
    return {
      city:    body.city       || '',
      region:  body.regionName || '',
      country: body.country    || '',
    };
  } catch (_) {
    return { city: '', region: '', country: '' };
  }
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a LoginSession row for a just-issued JWT.
 * @param {object} req      Express request (headers + ip)
 * @param {object} user     Mongoose user doc (or {_id})
 * @param {string} token    The JWT just issued — its iat identifies the session
 * @param {string} method   'password' | 'google' | 'email-verify' | '2fa'
 * Never throws; a session-log failure must not break sign-in.
 */
exports.recordLogin = async (req, user, token, method = 'password') => {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(token) || {};
    const ip = clientIp(req);
    const geo = await geoForIp(ip);

    const session = await LoginSession.create({
      userId:     user._id,
      tokenIat:   decoded.iat || Math.floor(Date.now() / 1000),
      deviceName: String(req.headers['x-device-name'] || '').slice(0, 120),
      deviceOS:   String(req.headers['x-device-os']   || '').slice(0, 60),
      appVersion: String(req.headers['x-app-version'] || '').slice(0, 30),
      userAgent:  String(req.headers['user-agent']    || '').slice(0, 300),
      ip,
      ...geo,
      method,
    });

    // Fire-and-forget history cap.
    LoginSession.trimOld(user._id).catch(() => {});
    return session;
  } catch (err) {
    console.warn('[sessionTracker] recordLogin failed:', err.message);
    return null;
  }
};

/** Mark the session belonging to this request's token as logged out. */
exports.recordLogout = async (userId, tokenIat) => {
  if (!userId || !tokenIat) return;
  try {
    await LoginSession.updateOne(
      { userId, tokenIat, logoutAt: null, revokedAt: null },
      { $set: { logoutAt: new Date() } },
    );
  } catch (_) { /* best-effort */ }
};

/** Touch lastActiveAt — called opportunistically, throttled by the caller. */
exports.touchSession = async (userId, tokenIat) => {
  if (!userId || !tokenIat) return;
  try {
    await LoginSession.updateOne(
      { userId, tokenIat },
      { $set: { lastActiveAt: new Date() } },
    );
  } catch (_) { /* best-effort */ }
};

exports.clientIp = clientIp;
