// Backend/middleware/adminAuth.js
//
// Admin authentication — a SEPARATE trust domain from the app's user auth.
// Admin JWTs are signed with ADMIN_SECRET (not JWT_SECRET) and carry
// scope:'admin', so a normal user token can never satisfy an admin route and
// vice-versa.

const jwt       = require('jsonwebtoken');
const AdminUser = require('../models/AdminUser');

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

/** Sign an admin session token. */
function signAdminToken(admin, { remember = false } = {}) {
  return jwt.sign(
    { sub: String(admin._id), scope: 'admin', role: admin.role, username: admin.username },
    ADMIN_SECRET,
    { expiresIn: remember ? '30d' : '12h' },
  );
}

/** Gate — require a valid admin token; attaches req.admin. */
async function requireAdmin(req, res, next) {
  try {
    if (!ADMIN_SECRET) {
      return res.status(503).json({ success: false, message: 'Admin panel is not configured on the server.' });
    }
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, code: 'ADMIN_NO_TOKEN', message: 'Admin authentication required.' });

    const decoded = jwt.verify(token, ADMIN_SECRET);
    if (decoded.scope !== 'admin') {
      return res.status(401).json({ success: false, code: 'ADMIN_BAD_SCOPE', message: 'Invalid admin token.' });
    }

    const admin = await AdminUser.findById(decoded.sub);
    if (!admin || !admin.active) {
      return res.status(401).json({ success: false, code: 'ADMIN_INACTIVE', message: 'Admin account not found or disabled.' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, code: 'ADMIN_TOKEN_INVALID', message: 'Invalid or expired admin token.' });
  }
}

/** Optional role gate (composes after requireAdmin). */
function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.admin?.role)
      ? next()
      : res.status(403).json({ success: false, message: 'Insufficient admin privileges.' });
}

module.exports = { signAdminToken, requireAdmin, requireRole, ADMIN_SECRET };
