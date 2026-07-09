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
      req.user = await User.findById(decoded.userId);

      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: 'User not found'
        });
      }

      // Expose the raw token to controllers that want to revoke on logout.
      req.authToken = token;

      next();
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token'
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
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