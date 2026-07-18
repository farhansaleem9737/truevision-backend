// Backend/controllers/SecurityController.js
//
// Everything behind Settings → Security:
//   settings snapshot, change password, 2FA enable/disable (email-OTP
//   verified), email verification (from inside the app), phone add/verify/
//   remove, login activity, single-session revoke, logout-all-devices.
//
// All routes are mounted behind `protect` (see routes/SecurityRoutes.js) so
// req.user is always a full mongoose doc and req.tokenIat identifies the
// calling device's session.

const bcrypt        = require('bcryptjs');
const User          = require('../models/User');
const LoginSession  = require('../models/LoginSession');
const emailService  = require('../services/emailService');
const smsService    = require('../services/smsService');
const { revokeToken } = require('../middleware/Auth');

const ok   = (res, data, code = 200) => res.status(code).json({ success: true,  ...data });
const fail = (res, message, code = 400) => res.status(code).json({ success: false, message });

// Send a security-alert email iff the user has them enabled. Fire-and-forget.
const alertIfEnabled = (user, payload) => {
  const enabled = user.preferences?.notifications?.emailSecurity !== false; // default ON
  if (!enabled) return;
  emailService.sendSecurityAlertEmail(user.email, user.fullName, payload).catch(() => {});
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/security/settings — snapshot for the Security screen
// ─────────────────────────────────────────────────────────────────────────────
exports.getSettings = async (req, res) => {
  try {
    const u = req.user;
    return ok(res, {
      settings: {
        twoFactorEnabled:  !!u.twoFactorEnabled,
        emailVerified:     !!u.isVerified,
        email:             u.email,
        phoneNumber:       u.phoneNumber || null,
        phoneCountryCode:  u.phoneCountryCode || null,
        phoneVerified:     !!u.phoneVerified,
        passwordChangedAt: u.passwordChangedAt || null,
        smsChannel:        smsService.smsConfigured() ? 'sms' : 'email',
      },
    });
  } catch (err) {
    console.error('getSettings error:', err);
    return fail(res, 'Failed to load security settings', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/security/password — change password (knows current password)
// Body: { currentPassword, newPassword }
// On success sets tokenInvalidBefore=now → EVERY device (including this one)
// is signed out; the client shows "password changed, sign in again".
// ─────────────────────────────────────────────────────────────────────────────
const PASSWORD_RULES = [
  { test: (p) => p.length >= 8,        message: 'Password must be at least 8 characters' },
  { test: (p) => /[a-zA-Z]/.test(p),   message: 'Password must contain a letter' },
  { test: (p) => /\d/.test(p),         message: 'Password must contain a number' },
];

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return fail(res, 'Current and new password are both required');
    }

    // password is select:false — re-load with it.
    const user = await User.findById(req.user.id).select('+password');
    if (!user) return fail(res, 'User not found', 404);

    if (user.authProvider === 'google' && !user.password) {
      return fail(res, 'This account signs in with Google and has no password.', 400);
    }

    const okPass = await user.comparePassword(currentPassword);
    if (!okPass) return fail(res, 'Current password is incorrect', 401);

    for (const rule of PASSWORD_RULES) {
      if (!rule.test(newPassword)) return fail(res, rule.message);
    }

    const same = await bcrypt.compare(newPassword, user.password);
    if (same) return fail(res, 'New password must be different from your current password');

    user.password           = newPassword;          // hashed by pre('save')
    user.passwordChangedAt  = new Date();
    user.tokenInvalidBefore = new Date();           // global revoke — all devices
    await user.save();

    // Belt-and-braces: also drop the calling token into the Redis revocation
    // list so it dies even if a clock skew makes the iat check marginal.
    revokeToken(req.authToken).catch?.(() => {});

    // Sever live realtime connections — the handshake check stops NEW sockets
    // with a revoked token, but already-open ones must be cut too.
    try { require('../socket').disconnectUser(user._id, 'password-changed'); } catch (_) {}

    // Mark every session revoked in the activity log.
    LoginSession.updateMany(
      { userId: user._id, revokedAt: null, logoutAt: null },
      { $set: { revokedAt: new Date() } },
    ).catch(() => {});

    alertIfEnabled(user, {
      title: 'Your TrueVision password was changed',
      lines: [
        `When: ${new Date().toUTCString()}`,
        `Every device has been signed out.`,
      ],
    });

    return ok(res, {
      message: 'Password changed. Please sign in again on all devices.',
      forceLogout: true,
    });
  } catch (err) {
    console.error('changePassword error:', err);
    return fail(res, 'Failed to change password', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/security/send-email-otp — issue a hashed OTP by email
// Body: { purpose: 'enable-2fa' | 'disable-2fa' }
// (Account-email verification reuses the existing /api/auth/resend-otp flow.)
// ─────────────────────────────────────────────────────────────────────────────
exports.sendEmailOtp = async (req, res) => {
  try {
    const purpose = req.body?.purpose === 'disable-2fa' ? 'disable-2fa' : 'enable-2fa';

    const user = await User.findById(req.user.id).select('+twoFactorOTP +twoFactorOTPExpires');
    if (!user) return fail(res, 'User not found', 404);

    if (purpose === 'enable-2fa'  &&  user.twoFactorEnabled) return fail(res, 'Two-factor authentication is already on');
    if (purpose === 'disable-2fa' && !user.twoFactorEnabled) return fail(res, 'Two-factor authentication is already off');

    const otp = user.generateHashedOTP('twoFactor');
    await user.save();

    // Prefer SMS to the verified phone when a provider is configured — this
    // is the escape hatch that stops a broken mailbox from permanently
    // locking a 2FA account out of BOTH signing in and turning 2FA off.
    let sent    = { success: false };
    let channel = 'email';
    if (user.phoneVerified && user.phoneNumber && smsService.smsConfigured()) {
      const full = `${user.phoneCountryCode || ''}${user.phoneNumber}`;
      sent    = await smsService.sendPhoneOtp(user, full, otp);
      channel = sent.channel || 'sms';
    }
    if (!sent.success) {
      sent    = await emailService.sendSecurityOtpEmail(user.email, user.fullName, otp, purpose);
      channel = 'email';
    }
    if (!sent.success) return fail(res, 'Could not send the code. Try again shortly.', 502);

    const dest = channel === 'sms'
      ? `your phone ending ${String(user.phoneNumber).slice(-4)}`
      : user.email;

    return ok(res, {
      message: `We sent a 6-digit code to ${dest}`,
      channel,
      expiresInMinutes: 10,
    });
  } catch (err) {
    console.error('sendEmailOtp error:', err);
    return fail(res, 'Failed to send code', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/security/2fa — flip 2FA after verifying the emailed OTP
// Body: { enabled: boolean, otp: string }
// ─────────────────────────────────────────────────────────────────────────────
exports.setTwoFactor = async (req, res) => {
  try {
    const { enabled, otp } = req.body || {};
    if (typeof enabled !== 'boolean') return fail(res, '`enabled` boolean is required');
    if (!otp || !/^\d{6}$/.test(String(otp))) return fail(res, 'A 6-digit code is required');

    const user = await User.findById(req.user.id).select('+twoFactorOTP +twoFactorOTPExpires');
    if (!user) return fail(res, 'User not found', 404);
    if (user.twoFactorEnabled === enabled) {
      return fail(res, `Two-factor authentication is already ${enabled ? 'on' : 'off'}`);
    }

    const check = user.verifyHashedOTP('twoFactor', otp);
    if (!check.success) return fail(res, check.message, 401);

    user.twoFactorEnabled = enabled;
    await user.save();

    alertIfEnabled(user, {
      title: `Two-factor authentication turned ${enabled ? 'ON' : 'OFF'}`,
      lines: [`When: ${new Date().toUTCString()}`],
    });

    return ok(res, {
      message: enabled
        ? 'Two-factor authentication is on. You\'ll be asked for a code at every sign-in.'
        : 'Two-factor authentication is off.',
      twoFactorEnabled: enabled,
    });
  } catch (err) {
    console.error('setTwoFactor error:', err);
    return fail(res, 'Failed to update two-factor authentication', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/security/send-phone-otp — attach/replace a phone number
// Body: { countryCode: '+92', phoneNumber: '3001234567' }
// ─────────────────────────────────────────────────────────────────────────────
exports.sendPhoneOtp = async (req, res) => {
  try {
    const countryCode = String(req.body?.countryCode || '').trim();
    const phoneNumber = String(req.body?.phoneNumber || '').replace(/[\s-]/g, '');

    if (!/^\+\d{1,4}$/.test(countryCode))  return fail(res, 'Pick a valid country code (e.g. +92)');
    if (!/^\d{6,14}$/.test(phoneNumber))   return fail(res, 'Enter a valid phone number (digits only)');

    const full = `${countryCode}${phoneNumber.replace(/^0+/, '')}`;

    const user = await User.findById(req.user.id)
      .select('+phoneOTP +phoneOTPExpires +phonePending');
    if (!user) return fail(res, 'User not found', 404);

    const otp = user.generateHashedOTP('phone');
    user.phonePending = full;
    await user.save();

    const sent = await smsService.sendPhoneOtp(user, full, otp);
    if (!sent.success) return fail(res, 'Could not deliver the code. Try again shortly.', 502);

    return ok(res, {
      message: sent.channel === 'sms'
        ? `Code sent by SMS to ${full}`
        : `SMS isn't configured on this server — we sent the code to your email (${user.email}) instead.`,
      channel: sent.channel,
      expiresInMinutes: 10,
    });
  } catch (err) {
    console.error('sendPhoneOtp error:', err);
    return fail(res, 'Failed to send code', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/security/verify-phone — confirm the code, save the number
// Body: { otp }
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyPhone = async (req, res) => {
  try {
    const { otp } = req.body || {};
    if (!otp || !/^\d{6}$/.test(String(otp))) return fail(res, 'A 6-digit code is required');

    const user = await User.findById(req.user.id)
      .select('+phoneOTP +phoneOTPExpires +phonePending');
    if (!user) return fail(res, 'User not found', 404);
    if (!user.phonePending) return fail(res, 'No phone verification in progress. Add a number first.');

    const check = user.verifyHashedOTP('phone', otp);
    if (!check.success) return fail(res, check.message, 401);

    const full = user.phonePending;
    // Split back into code + number for display ("+92" + rest).
    const m = full.match(/^(\+\d{1,4})(\d{6,14})$/);
    user.phoneCountryCode = m ? m[1] : '';
    user.phoneNumber      = m ? m[2] : full;
    user.phoneVerified    = true;
    user.phonePending     = null;
    await user.save();

    alertIfEnabled(user, {
      title: 'Phone number verified on your account',
      lines: [`Number: ${full}`, `When: ${new Date().toUTCString()}`],
    });

    return ok(res, {
      message: 'Phone number verified',
      phoneNumber: user.phoneNumber,
      phoneCountryCode: user.phoneCountryCode,
      phoneVerified: true,
    });
  } catch (err) {
    console.error('verifyPhone error:', err);
    return fail(res, 'Failed to verify phone', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/security/phone — remove the verified number
// ─────────────────────────────────────────────────────────────────────────────
exports.removePhone = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('+phonePending');
    if (!user) return fail(res, 'User not found', 404);
    if (!user.phoneNumber && !user.phonePending) return fail(res, 'No phone number on this account');

    const removed = `${user.phoneCountryCode || ''}${user.phoneNumber || ''}`;
    user.phoneNumber      = null;
    user.phoneCountryCode = null;
    user.phoneVerified    = false;
    user.phonePending     = null;
    user.phoneOTP         = null;
    user.phoneOTPExpires  = null;
    await user.save();

    if (removed) {
      alertIfEnabled(user, {
        title: 'Phone number removed from your account',
        lines: [`Number: ${removed}`, `When: ${new Date().toUTCString()}`],
      });
    }

    return ok(res, { message: 'Phone number removed' });
  } catch (err) {
    console.error('removePhone error:', err);
    return fail(res, 'Failed to remove phone', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/security/login-activity — newest-first session list
// ─────────────────────────────────────────────────────────────────────────────
exports.getLoginActivity = async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const [sessions, total] = await Promise.all([
      LoginSession.find({ userId: req.user.id })
        .sort({ loginAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      LoginSession.countDocuments({ userId: req.user.id }),
    ]);

    const shaped = sessions.map((s) => ({
      id:           s._id,
      deviceName:   s.deviceName || (s.userAgent ? 'Web browser' : 'Unknown device'),
      deviceOS:     s.deviceOS,
      appVersion:   s.appVersion,
      ip:           s.ip,
      city:         s.city,
      region:       s.region,
      country:      s.country,
      method:       s.method,
      loginAt:      s.loginAt,
      logoutAt:     s.logoutAt,
      revokedAt:    s.revokedAt,
      lastActiveAt: s.lastActiveAt,
      isCurrent:    s.tokenIat === req.tokenIat && !s.logoutAt && !s.revokedAt,
      isActive:     !s.logoutAt && !s.revokedAt,
    }));

    return ok(res, {
      sessions: shaped,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('getLoginActivity error:', err);
    return fail(res, 'Failed to load login activity', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/security/sessions/:id — remove one row from history.
// If the row is still active, it cannot be remote-killed individually (JWTs
// are stateless per-device; global revocation is what logout-all is for), so
// active rows other than an already-ended one are only removable when ended.
// The CURRENT session row can't be deleted (log out normally instead).
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteSession = async (req, res) => {
  try {
    const session = await LoginSession.findOne({ _id: req.params.id, userId: req.user.id });
    if (!session) return fail(res, 'Session not found', 404);
    if (session.tokenIat === req.tokenIat && !session.logoutAt && !session.revokedAt) {
      return fail(res, 'This is your current session — log out normally instead.', 400);
    }
    // A STILL-ACTIVE session on another device must not be silently erased:
    // deleting the row does not invalidate that device's JWT, so the device
    // would stay signed in but become invisible in the audit trail — exactly
    // the misleading state this list exists to prevent. Revoking is the only
    // honest way to end a foreign session.
    if (!session.logoutAt && !session.revokedAt) {
      return fail(
        res,
        'That device is still signed in. Use “Log out from all devices” to revoke it, then remove the entry.',
        400,
      );
    }
    await LoginSession.deleteOne({ _id: session._id });
    return ok(res, { message: 'Session removed from history' });
  } catch (err) {
    console.error('deleteSession error:', err);
    return fail(res, 'Failed to remove session', 500);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/security/logout-all — revoke EVERY token
// Body (optional): { keepCurrent: true } to stay signed in on this device.
// keepCurrent works by setting the cutoff, then minting a FRESH token (whose
// iat is after the cutoff) and returning it to the caller.
// ─────────────────────────────────────────────────────────────────────────────
exports.logoutAll = async (req, res) => {
  try {
    const keepCurrent = req.body?.keepCurrent === true;
    const user = await User.findById(req.user.id);
    if (!user) return fail(res, 'User not found', 404);

    user.tokenInvalidBefore = new Date();
    await user.save();

    // Redis fallback for the calling token (dies via cutoff anyway).
    if (!keepCurrent) revokeToken(req.authToken).catch?.(() => {});

    // Sever every live socket. When keepCurrent is set the caller reconnects
    // with the fresh token minted below, so a momentary drop is correct.
    try { require('../socket').disconnectUser(user._id, 'logged-out-everywhere'); } catch (_) {}

    await LoginSession.updateMany(
      { userId: user._id, revokedAt: null, logoutAt: null },
      { $set: { revokedAt: new Date() } },
    );

    let freshToken = null;
    if (keepCurrent) {
      // Sign after the cutoff (iat resolution is seconds — wait out the edge).
      await new Promise((r) => setTimeout(r, 1100));
      const jwt = require('jsonwebtoken');
      freshToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '30d',
      });
      const sessionTracker = require('../services/sessionTracker');
      await sessionTracker.recordLogin(req, user, freshToken, 'password');
    }

    alertIfEnabled(user, {
      title: 'Signed out from all devices',
      lines: [
        `When: ${new Date().toUTCString()}`,
        keepCurrent ? 'Your current device stayed signed in.' : 'Every device, including the one that made the request, was signed out.',
      ],
    });

    return ok(res, {
      message: keepCurrent
        ? 'All other devices were signed out.'
        : 'Signed out everywhere. Please sign in again.',
      ...(freshToken ? { token: freshToken } : {}),
    });
  } catch (err) {
    console.error('logoutAll error:', err);
    return fail(res, 'Failed to log out from all devices', 500);
  }
};
