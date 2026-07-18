// Backend/routes/SecurityRoutes.js
//
// Mounted at /api/security (see server.js). Everything requires a valid
// session token. OTP-issuing endpoints get their own tighter rate limits on
// top of the mount-level limiter — 6-digit codes must not be brute-forceable
// and inboxes must not be floodable.

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/Auth');
const rateLimit   = require('../middleware/rateLimit');

const {
  getSettings,
  changePassword,
  sendEmailOtp,
  setTwoFactor,
  sendPhoneOtp,
  verifyPhone,
  removePhone,
  getLoginActivity,
  deleteSession,
  logoutAll,
} = require('../controllers/SecurityController');

// Per-route limiters (Redis-backed, keyed on IP):
const otpSendLimit   = rateLimit(5,  10 * 60 * 1000, 'sec-otp-send');   // 5 sends / 10 min
const otpVerifyLimit = rateLimit(10, 10 * 60 * 1000, 'sec-otp-verify'); // 10 tries / 10 min
const pwdLimit       = rateLimit(8,  15 * 60 * 1000, 'sec-pwd');        // 8 tries / 15 min

// GET    /api/security/settings — snapshot for the Security screen
router.get('/settings', protect, getSettings);

// PATCH  /api/security/password — change password (revokes all tokens)
router.patch('/password', protect, pwdLimit, changePassword);

// POST   /api/security/send-email-otp — { purpose: 'enable-2fa'|'disable-2fa' }
router.post('/send-email-otp', protect, otpSendLimit, sendEmailOtp);

// PATCH  /api/security/2fa — { enabled, otp }
router.patch('/2fa', protect, otpVerifyLimit, setTwoFactor);

// POST   /api/security/send-phone-otp — { countryCode, phoneNumber }
router.post('/send-phone-otp', protect, otpSendLimit, sendPhoneOtp);

// POST   /api/security/verify-phone — { otp }
router.post('/verify-phone', protect, otpVerifyLimit, verifyPhone);

// DELETE /api/security/phone — remove verified number
router.delete('/phone', protect, removePhone);

// GET    /api/security/login-activity?page=&limit=
router.get('/login-activity', protect, getLoginActivity);

// DELETE /api/security/sessions/:id — remove one ended session from history
router.delete('/sessions/:id', protect, deleteSession);

// DELETE /api/security/logout-all — body { keepCurrent?: boolean }
router.delete('/logout-all', protect, logoutAll);

module.exports = router;
