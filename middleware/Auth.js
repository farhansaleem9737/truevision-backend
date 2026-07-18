//Backend/middleware/Auth.js
const jwt   = require('jsonwebtoken');
const User  = require('../models/User');
const { client: redis, isReady } = require('../config/redis');

// Redis-backed revocation list. Adding a token here makes it fail auth
// immediately; entries auto-expire at the token's own JWT expiry so the
// list can never grow larger than the number of currently-live sessions.
const REVOKED_PREFIX = 'auth:revoked:';

/** Check whether a token was explicitly revoked (used by protect below). */
const isRevoked = async (token) => {
  if (!isReady()) return false;
  try {
    const hit = await redis.get(REVOKED_PREFIX + token);
    return hit !== null;
  } catch (_) { return false; }
};

// Exported so socket.js can apply the identical revocation check at the
// realtime handshake — the socket surface must never accept a token the
// REST surface would reject.
exports.isTokenRevoked = isRevoked;

// ── lastActiveAt touch throttle ─────────────────────────────────────────────
// LoginSession.lastActiveAt should reflect real usage, but writing on every
// authenticated request would add a Mongo write to the hot path. Instead we
// remember the last touch per (userId:tokenIat) in-process and skip until the
// window elapses. The map is bounded: entries are pruned once they age out,
// and a process restart simply re-touches. Fire-and-forget — a failed touch
// must never affect the request.
const TOUCH_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes
const lastTouched = new Map();

const touchSessionThrottled = (userId, tokenIat) => {
  if (!userId || !tokenIat) return;
  const key = `${userId}:${tokenIat}`;
  const now = Date.now();
  const prev = lastTouched.get(key);
  if (prev && now - prev < TOUCH_THROTTLE_MS) return;
  lastTouched.set(key, now);

  // Opportunistic prune so the map can't grow without bound on a long-lived
  // process with many rotating sessions.
  if (lastTouched.size > 5000) {
    for (const [k, t] of lastTouched) {
      if (now - t > TOUCH_THROTTLE_MS) lastTouched.delete(k);
    }
  }

  try {
    require('../services/sessionTracker').touchSession(userId, tokenIat).catch(() => {});
  } catch (_) { /* optional */ }
};

/** Add a token to the revocation list for the remainder of its natural lifetime.
 *  Called from AuthController.logout — see the new /logout route.  */
exports.revokeToken = async (token) => {
  if (!token || !isReady()) return;
  try {
    // Compute remaining TTL from the token's own `exp` claim.
    const decoded = jwt.decode(token) || {};
    const nowSec  = Math.floor(Date.now() / 1000);
    const ttl     = Math.max(1, Number(decoded.exp) - nowSec);
    if (!ttl || !Number.isFinite(ttl)) return;
    await redis.set(REVOKED_PREFIX + token, '1', 'EX', ttl);
  } catch (_) { /* best-effort */ }
};

exports.protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route'
      });
    }

    // Redis-backed revocation check — instant logout across sessions.
    if (await isRevoked(token)) {
      return res.status(401).json({
        success: false,
        message: 'Session ended. Please sign in again.',
      });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // 2FA pending tokens are NOT session tokens — they only authorize the
      // /auth/2fa-verify exchange. Reject them everywhere else.
      if (decoded.purpose === '2fa-pending') {
        return res.status(401).json({
          success: false,
          code:    'TOKEN_INVALID',
          message: 'Invalid token. Please sign in again.',
        });
      }

      req.user = await User.findById(decoded.userId);

      if (!req.user) {
        // Log with the userId that the token claimed so an orphaned token
        // (user deleted, DB restored) is diagnosable from server logs alone.
        console.warn(
          `[auth] ${req.method} ${req.originalUrl} — USER_NOT_FOUND: token.userId=${decoded.userId}`,
        );
        return res.status(401).json({
          success: false,
          code:    'USER_NOT_FOUND',
          message: 'User not found',
        });
      }

      // ── Global token cutoff ─────────────────────────────────────────────
      // Password change and "log out from all devices" set tokenInvalidBefore
      // to now; any JWT minted earlier (iat is in seconds) dies here. This is
      // what turns those actions into real all-device revocation without
      // tracking every token individually.
      if (req.user.tokenInvalidBefore &&
          decoded.iat * 1000 < new Date(req.user.tokenInvalidBefore).getTime()) {
        return res.status(401).json({
          success: false,
          code:    'TOKEN_EXPIRED',
          message: 'Session expired. Please sign in again.',
        });
      }

      // Expose the raw token to controllers that want to revoke on logout.
      req.authToken = token;
      // iat identifies the LoginSession row for this device.
      req.tokenIat  = decoded.iat;

      // Keep LoginSession.lastActiveAt honest without a write per request:
      // touch at most once every TOUCH_THROTTLE_MS per (user, session).
      touchSessionThrottled(req.user._id, decoded.iat);

      // Debug breadcrumb — only in dev. Confirms who we authenticated as
      // for each authenticated request, so cross-referencing with the
      // controller's "owner mismatch" log is trivial.
      if (process.env.NODE_ENV !== 'production') {
        console.log(
          `[auth] ${req.method} ${req.originalUrl} — OK userId=${req.user._id} role=${req.user.role || 'user'}`,
        );
      }

      next();
    } catch (error) {
      // Distinguish the three jwt.verify failure modes so the client can
      // react intelligently (force re-login on expiry, hard error on tamper)
      // and so the server logs pinpoint what actually happened. Without this,
      // an expired JWT and a signature mismatch look identical in the UI.
      let code = 'TOKEN_INVALID';
      let message = 'Invalid token. Please sign in again.';
      if (error && error.name === 'TokenExpiredError') {
        code = 'TOKEN_EXPIRED';
        message = 'Session expired. Please sign in again.';
      } else if (error && error.name === 'NotBeforeError') {
        code = 'TOKEN_NOT_ACTIVE';
        message = 'Token not yet active. Please sign in again.';
      }

      // Server-side breadcrumb — masks the token but reveals the failure
      // reason, so a stale-secret rollout or clock-skew issue is diagnosable.
      const masked = token.length > 12
        ? `${token.slice(0, 6)}…${token.slice(-4)}`
        : '***';
      console.warn(
        `[auth] ${req.method} ${req.originalUrl} — ${code}: ${error?.message || 'unknown'} (token=${masked})`,
      );

      return res.status(401).json({ success: false, code, message });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// maybeAuth — OPTIONAL authentication.
//
// Public content routes (feed, search, video-by-id, user-videos, view/share
// counters) work for anonymous callers, but several behaviours are per-viewer:
// isLiked/isSaved flags, notInterested filtering, private-account exclusions,
// owner visibility, and activity mirrors (share history). Those routes mount
// this middleware: if a valid Bearer token is present, req.user is populated
// exactly like `protect`; if the token is missing, expired, revoked, or
// invalid, the request simply proceeds anonymously (req.user stays undefined).
// It NEVER responds with 401 — enforcement stays in the controllers.
// ─────────────────────────────────────────────────────────────────────────────
exports.maybeAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return next();
    if (await isRevoked(token)) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose === '2fa-pending') return next(); // not a session token
    const user = await User.findById(decoded.userId);
    // Same global cutoff as protect — a revoked token must not resurrect a
    // viewer identity on public routes either.
    const cutOff = user?.tokenInvalidBefore &&
      decoded.iat * 1000 < new Date(user.tokenInvalidBefore).getTime();
    if (user && !cutOff) {
      req.user = user;
      req.authToken = token;
      req.tokenIat  = decoded.iat;
    }
  } catch (_) {
    // Anonymous fallthrough by design — bad/expired tokens are not an error here.
  }
  return next();
};

exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role ${req.user.role} is not authorized to access this route`
      });
    }
    next();
  };
};

module.exports = exports;