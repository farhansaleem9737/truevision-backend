const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { sendVerificationEmail, sendPasswordResetEmail, sendTestEmail,
        sendSecurityOtpEmail, sendSecurityAlertEmail,
        humanizeSmtpError } = require('../services/emailService');
const cloudinary = require('../config/cloudinary');
const sessionTracker = require('../services/sessionTracker');
const refreshTokens  = require('../services/refreshTokens');

// One client per process — used to verify ID tokens issued by Google.
// We accept tokens minted for any of the three OAuth client IDs we register
// in Google Cloud Console (iOS, Android, Web — Expo Go uses the Web one).
const GOOGLE_AUDIENCES = [
  process.env.GOOGLE_CLIENT_ID_IOS,
  process.env.GOOGLE_CLIENT_ID_ANDROID,
  process.env.GOOGLE_CLIENT_ID_WEB,
].filter(Boolean);

const googleClient = new OAuth2Client();

// Generate the short-lived ACCESS token. Kept as a small helper so every mint
// site produces identical tokens. The refresh token (services/refreshTokens.js)
// silently mints new access tokens, so this TTL can be short without logging
// active users out. Verification in middleware/Auth.js is UNCHANGED.
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    // TODO (production): reduce ACCESS_TOKEN_TTL to '15m' after deployment, once
    // the client refresh flow is confirmed working on-device. Defaulted to '1h'
    // during development for a comfortable safety buffer.
    expiresIn: process.env.ACCESS_TOKEN_TTL || '1h',
  });
};

// Canonical public user payload — the exact shape the client reads from
// `data.user` at every auth entry point (login/verify/2fa/google/refresh).
const publicUser = (user) => ({
  _id:          user._id,
  fullName:     user.fullName,
  username:     user.username,
  email:        user.email,
  country:      user.country,
  profileImage: user.profileImage,
  role:         user.role,
  isVerified:   user.isVerified,
  createdAt:    user.createdAt,
});

// Mint an access token AND a rotating refresh token for a freshly-authenticated
// session, then build the standard { token, refreshToken, user } data envelope.
// Backward-compatible: old clients simply ignore the extra `refreshToken`.
const buildSession = async (user, { req, method } = {}) => {
  const token = generateToken(user._id);
  let refreshToken = null;
  try {
    const sessionIat = jwt.decode(token)?.iat ?? null;
    refreshToken = await refreshTokens.issue(user, { sessionIat, req });
  } catch (e) {
    // Never block sign-in if the refresh row can't be written — the access
    // token still works; the client just won't have silent refresh this session.
    console.error('[auth] refresh issue failed:', e.message);
  }
  return { token, refreshToken, user: publicUser(user) };
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared 2FA challenge — used by BOTH the password and the Google sign-in
// paths so a second factor can never be skipped by choosing a different
// provider. Issues the OTP and returns the response body the client expects
// ({ requires2FA, pendingToken }), or null when 2FA is off for this account.
//
// Delivery prefers the account's VERIFIED PHONE when one exists and an SMS
// provider is configured, falling back to email. That gives a working second
// channel so a broken mailbox can't lock the user out permanently.
// ─────────────────────────────────────────────────────────────────────────────
const issueTwoFactorChallenge = async (user) => {
  if (!user.twoFactorEnabled) return null;

  const otp = user.generateHashedOTP('twoFactor');
  await user.save();

  let channel = 'email';
  let sent    = { success: false };

  const smsService = require('../services/smsService');
  if (user.phoneVerified && user.phoneNumber && smsService.smsConfigured()) {
    const full = `${user.phoneCountryCode || ''}${user.phoneNumber}`;
    sent = await smsService.sendPhoneOtp(user, full, otp);
    channel = sent.channel || 'sms';
  }
  if (!sent.success) {
    sent    = await sendSecurityOtpEmail(user.email, user.fullName, otp, 'signin-2fa');
    channel = 'email';
  }
  if (!sent.success) {
    return { error: 'Could not send your sign-in code. Try again shortly.' };
  }

  const pendingToken = jwt.sign(
    { userId: user._id, purpose: '2fa-pending' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' },
  );

  const masked = channel === 'sms'
    ? `your phone ending ${String(user.phoneNumber).slice(-4)}`
    : user.email;

  return {
    body: {
      success: true,
      requires2FA: true,
      message: `Enter the 6-digit code we sent to ${masked}`,
      data: { pendingToken, email: user.email, channel },
    },
  };
};

// @desc    Register new user
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res) => {
  try {
    const { fullName, username, email, country, password } = req.body;

    // Validation
    if (!fullName || !username || !email || !country || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }] 
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: existingUser.email === email.toLowerCase()
          ? 'Email is already registered' 
          : 'Username is already taken'
      });
    }

    // Create user
    const user = await User.create({
      fullName,
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      country,
      password
    });

    // Generate OTP
    const otp = user.generateVerificationOTP();
    await user.save();

    // Send verification email. "OTP sent" is claimed ONLY after the provider
    // confirms acceptance (messageId). Failure behaviour:
    //   • production        → roll back the user, return HTTP 500
    //   • DEBUG_OTP=true    → explicit debug mode: keep the user, print the
    //                         OTP to the console + expose devOtp (QA only)
    //   • otherwise (dev)   → keep the user, but tell the client the EXACT
    //                         reason the email failed. No OTP is printed.
    const emailResult = await sendVerificationEmail(email, fullName, otp);

    if (!emailResult.success) {
      const isProd  = process.env.NODE_ENV === 'production';
      const debugOtp = process.env.DEBUG_OTP === 'true';
      const reason  = humanizeSmtpError(emailResult.error);

      if (isProd) {
        try { await User.deleteOne({ _id: user._id }); } catch (_) { /* ignore */ }
        return res.status(500).json({
          success: false,
          message: 'We could not send your verification email. Please contact support or try again later.',
        });
      }

      if (debugOtp) {
        // Explicit debug mode only — never the default.
        console.log('\n' + '═'.repeat(60));
        console.log('  DEBUG_OTP — SMTP failed but user is created.');
        console.log('  Account: ' + email);
        console.log('  OTP:     ' + otp + '   (15 min)');
        console.log('  Reason:  ' + reason);
        console.log('═'.repeat(60) + '\n');
        return res.status(201).json({
          success: true,
          message: 'Registration successful. DEBUG_OTP mode — the verification code is in the server console.',
          data: {
            userId: user._id, email: user.email, username: user.username,
            emailSent: false, devOtp: otp,
          },
        });
      }

      // Honest failure: the account exists (so Resend works once SMTP is
      // fixed) but the client is told exactly why no email arrived.
      console.error('[register] Verification email FAILED for', email, '—', reason);
      return res.status(502).json({
        success: false,
        code:    'EMAIL_SEND_FAILED',
        message: `Account created, but the verification email could not be sent. ${reason}`,
        data: { userId: user._id, email: user.email, emailSent: false },
      });
    }

    res.status(201).json({
      success: true,
      message: 'Registration successful! Please check your email for the verification code.',
      data: {
        userId: user._id,
        email: user.email,
        username: user.username,
        emailSent: true
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Registration failed. Please try again.'
    });
  }
};

// @desc    Verify email with OTP
// @route   POST /api/auth/verify-email
// @access  Public
exports.verifyEmail = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP are required'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() })
      .select('+verificationOTP +verificationOTPExpires');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email is already verified'
      });
    }

    const verification = user.verifyOTP(otp, 'verification');
    
    if (!verification.success) {
      return res.status(400).json({
        success: false,
        message: verification.message
      });
    }

    // Update user
    user.isVerified = true;
    user.verificationOTP = undefined;
    user.verificationOTPExpires = undefined;
    user.lastLogin = new Date();
    await user.save();

    // Mint access + rotating refresh token.
    const session = await buildSession(user, { req, method: 'email-verify' });
    sessionTracker.recordLogin(req, user, session.token, 'email-verify').catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Email verified successfully!',
      data: session,
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Verification failed. Please try again.'
    });
  }
};

// @desc    Resend verification OTP
// @route   POST /api/auth/resend-otp
// @access  Public
const RESEND_COOLDOWN_MS  = 60 * 1000;        // one resend per 60s per account
const RESEND_MAX_PER_HOUR = 5;                // hard cap per rolling hour
const RESEND_WINDOW_MS    = 60 * 60 * 1000;

exports.resendOTP = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() })
      .select('+verificationOTPSentAt +verificationOTPResendCount +verificationOTPResendWindow');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'Email is already verified'
      });
    }

    const now = Date.now();

    // ── Per-account cooldown (60s between sends) ─────────────────────────
    const lastSent = user.verificationOTPSentAt ? new Date(user.verificationOTPSentAt).getTime() : 0;
    const sinceLast = now - lastSent;
    if (lastSent && sinceLast < RESEND_COOLDOWN_MS) {
      const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000);
      return res.status(429).json({
        success: false,
        code: 'RESEND_COOLDOWN',
        message: `Please wait ${retryAfter}s before requesting another code.`,
        retryAfter,
      });
    }

    // ── Rolling-hour cap (max 5 resends) ─────────────────────────────────
    const windowStart = user.verificationOTPResendWindow ? new Date(user.verificationOTPResendWindow).getTime() : 0;
    if (!windowStart || now - windowStart > RESEND_WINDOW_MS) {
      user.verificationOTPResendWindow = new Date(now);
      user.verificationOTPResendCount  = 0;
    }
    if (user.verificationOTPResendCount >= RESEND_MAX_PER_HOUR) {
      const retryAfter = Math.ceil((windowStart + RESEND_WINDOW_MS - now) / 1000);
      return res.status(429).json({
        success: false,
        code: 'RESEND_LIMIT',
        message: 'Too many codes requested. Try again later.',
        retryAfter,
      });
    }

    // New OTP — overwrites (invalidates) the previous code + restarts expiry.
    const otp = user.generateVerificationOTP();
    user.verificationOTPResendCount += 1;
    await user.save();

    const emailResult = await sendVerificationEmail(email, user.fullName, otp);

    if (!emailResult.success) {
      const isProd   = process.env.NODE_ENV === 'production';
      const debugOtp = process.env.DEBUG_OTP === 'true';
      const reason   = humanizeSmtpError(emailResult.error);

      if (isProd) {
        return res.status(500).json({
          success: false,
          message: 'Failed to send verification code. Please try again later.',
        });
      }
      if (debugOtp) {
        console.log('\n' + '═'.repeat(60));
        console.log('  DEBUG_OTP — Resend SMTP failed. OTP:', otp, '(account:', email + ')');
        console.log('  Reason:', reason);
        console.log('═'.repeat(60) + '\n');
        return res.status(200).json({
          success: true,
          message: 'DEBUG_OTP mode — the verification code is in the server console.',
          devOtp:  otp,
        });
      }
      console.error('[resendOTP] send FAILED for', email, '—', reason);
      return res.status(502).json({
        success: false,
        code:    'EMAIL_SEND_FAILED',
        message: `Could not send the verification email. ${reason}`,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Verification code sent successfully!',
      retryAfter: Math.ceil(RESEND_COOLDOWN_MS / 1000),   // client countdown sync
    });
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resend verification code. Please try again.'
    });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;

    // Validation
    if (!emailOrUsername || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email/username and password'
      });
    }

    // Find user
    const user = await User.findOne({
      $or: [
        { email: emailOrUsername.toLowerCase() },
        { username: emailOrUsername.toLowerCase() }
      ]
    }).select('+password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if verified
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email before logging in',
        requiresVerification: true,
        email: user.email
      });
    }

    // ── Two-factor gate ─────────────────────────────────────────────────────
    // Password was correct, but 2FA is on: do NOT issue a session token.
    // Send a code and hand back a short-lived pending token that is only
    // accepted by POST /api/auth/2fa-verify (protect(), maybeAuth() and the
    // socket handshake all reject purpose='2fa-pending').
    const challenge = await issueTwoFactorChallenge(user);
    if (challenge?.error)  return res.status(502).json({ success: false, message: challenge.error });
    if (challenge?.body)   return res.status(200).json(challenge.body);

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Mint access + rotating refresh token for the new session.
    const session = await buildSession(user, { req, method: 'password' });

    // Login-activity row + optional new-login security alert (fire-and-forget).
    sessionTracker.recordLogin(req, user, session.token, 'password').then((s) => {
      const alertsOn = user.preferences?.notifications?.emailSecurity !== false;
      if (alertsOn && s) {
        const where = [s.city, s.country].filter(Boolean).join(', ') || 'Unknown location';
        sendSecurityAlertEmail(user.email, user.fullName, {
          title: 'New sign-in to your TrueVision account',
          lines: [
            `Device: ${s.deviceName || 'Unknown device'} (${s.deviceOS || 'unknown OS'})`,
            `Location: ${where}${s.ip ? ` — IP ${s.ip}` : ''}`,
            `When: ${new Date().toUTCString()}`,
          ],
        }).catch(() => {});
      }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Login successful!',
      data: session,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
};

// @desc    Complete a 2FA sign-in — exchange pendingToken + OTP for a session
// @route   POST /api/auth/2fa-verify
// @access  Public (authenticated by the pendingToken itself)
exports.twoFactorVerify = async (req, res) => {
  try {
    const { pendingToken, otp } = req.body || {};
    if (!pendingToken || !otp) {
      return res.status(400).json({ success: false, message: 'Code and pending token are required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, process.env.JWT_SECRET);
    } catch (_) {
      return res.status(401).json({
        success: false,
        message: 'Your sign-in window expired. Enter your password again.',
        code: 'PENDING_EXPIRED',
      });
    }
    if (decoded.purpose !== '2fa-pending') {
      return res.status(401).json({ success: false, message: 'Invalid sign-in token' });
    }

    const user = await User.findById(decoded.userId)
      .select('+twoFactorOTP +twoFactorOTPExpires');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const check = user.verifyHashedOTP('twoFactor', otp);
    if (!check.success) return res.status(401).json({ success: false, message: check.message });

    user.lastLogin = new Date();
    await user.save();

    const session = await buildSession(user, { req, method: '2fa' });
    sessionTracker.recordLogin(req, user, session.token, '2fa').catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Login successful!',
      data: session,
    });
  } catch (error) {
    console.error('twoFactorVerify error:', error);
    return res.status(500).json({ success: false, message: 'Sign-in failed. Please try again.' });
  }
};

// @desc    Resend the 2FA sign-in code (pending-token holders only)
// @route   POST /api/auth/2fa-resend
// @access  Public (pendingToken)
exports.twoFactorResend = async (req, res) => {
  try {
    const { pendingToken } = req.body || {};
    if (!pendingToken) return res.status(400).json({ success: false, message: 'Pending token required' });

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, process.env.JWT_SECRET);
    } catch (_) {
      return res.status(401).json({
        success: false,
        message: 'Your sign-in window expired. Enter your password again.',
        code: 'PENDING_EXPIRED',
      });
    }
    if (decoded.purpose !== '2fa-pending') {
      return res.status(401).json({ success: false, message: 'Invalid sign-in token' });
    }

    const user = await User.findById(decoded.userId)
      .select('+twoFactorOTP +twoFactorOTPExpires');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const otp = user.generateHashedOTP('twoFactor');
    await user.save();

    const sent = await sendSecurityOtpEmail(user.email, user.fullName, otp, 'signin-2fa');
    if (!sent.success) {
      return res.status(502).json({ success: false, message: 'Could not resend the code. Try again shortly.' });
    }
    return res.status(200).json({ success: true, message: `New code sent to ${user.email}` });
  } catch (error) {
    console.error('twoFactorResend error:', error);
    return res.status(500).json({ success: false, message: 'Could not resend the code' });
  }
};

// @desc    Sign in / sign up with Google
// @route   POST /api/auth/google
// @access  Public
//
// Body: { idToken: string }
//
// The client (Expo app) goes through the OAuth flow with Google, receives an
// id_token, and POSTs it here. We verify the token's signature + audience
// against Google's public keys, then:
//   • If a user with this googleId exists       → log them in.
//   • Else if a user with this email exists     → link the Google account.
//   • Else                                       → create a fresh account.
// Either way we return the same { token, user } envelope as /login so the
// client can store it identically through AuthContext.
exports.googleSignIn = async (req, res) => {
  try {
    if (GOOGLE_AUDIENCES.length === 0) {
      return res.status(503).json({
        success: false,
        message: 'Google sign-in is not configured on the server.',
      });
    }

    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: 'idToken is required',
      });
    }

    // 1) Verify the token's signature + audience with Google.
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: GOOGLE_AUDIENCES, // accept tokens for any of our configured clients
      });
      payload = ticket.getPayload();
    } catch (err) {
      console.error('Google token verify failed:', err.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid Google sign-in token',
      });
    }

    if (!payload?.email) {
      return res.status(401).json({
        success: false,
        message: 'Google profile did not include an email',
      });
    }
    // Google verifies emails before they're attached to a Google account, but
    // double-check just in case (covers the rare "email_verified: false" case).
    if (payload.email_verified === false) {
      return res.status(401).json({
        success: false,
        message: 'Your Google email is not verified',
      });
    }

    const googleId = payload.sub;          // stable Google user ID
    const email    = payload.email.toLowerCase();
    const fullName = payload.name || payload.given_name || 'Google User';
    const picture  = payload.picture || null;

    // 2) Try to find an existing account, in order of preference:
    //    (a) same googleId  → returning Google user
    //    (b) same email     → local account being linked
    let user = await User.findOne({ googleId }).select('+googleId');
    let isNew = false;

    if (!user) {
      user = await User.findOne({ email }).select('+googleId');

      if (user) {
        // Link: a local account exists with this email. Attach googleId so
        // future Google sign-ins resolve here.
        user.googleId = googleId;
        if (user.authProvider === 'local') user.authProvider = 'google';
        if (!user.profileImage && picture)  user.profileImage = picture;
        user.isVerified = true; // Google has verified the email already.
        await user.save();
      } else {
        // Create a new account. Username must be unique → derive from email
        // and append a short random suffix if it collides.
        const baseUsername = email.split('@')[0]
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '')
          .slice(0, 24) || 'user';

        let username = baseUsername;
        for (let i = 0; i < 5; i++) {
          if (!(await User.exists({ username }))) break;
          username = `${baseUsername}_${crypto.randomBytes(2).toString('hex')}`;
        }

        user = await User.create({
          fullName,
          username,
          email,
          // We don't get a country from Google. Use a neutral default; the
          // user can edit it from their profile screen.
          country:      'Not specified',
          // Random placeholder so the field is never empty. Google users can
          // set a real password later via "Forgot Password".
          password:     crypto.randomBytes(24).toString('hex'),
          profileImage: picture,
          googleId,
          authProvider: 'google',
          isVerified:   true,
        });
        isNew = true;
      }
    }

    // 3) Two-factor gate — the SAME gate the password path enforces. Without
    //    this, an account with 2FA on could skip the second factor simply by
    //    choosing "Sign in with Google", which defeats the whole feature.
    const challenge = await issueTwoFactorChallenge(user);
    if (challenge?.error) return res.status(502).json({ success: false, message: challenge.error });
    if (challenge?.body)  return res.status(200).json(challenge.body);

    // 4) Bookkeeping + JWT, identical to the /login response envelope.
    user.lastLogin = new Date();
    await user.save();

    const session = await buildSession(user, { req, method: 'google' });
    sessionTracker.recordLogin(req, user, session.token, 'google').catch(() => {});

    return res.status(200).json({
      success: true,
      message: isNew ? 'Account created with Google' : 'Signed in with Google',
      data: session,
    });
  } catch (err) {
    console.error('googleSignIn error:', err);
    return res.status(500).json({
      success: false,
      message: 'Google sign-in failed. Please try again.',
    });
  }
};

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          _id: user._id,
          fullName: user.fullName,
          username: user.username,
          email: user.email,
          country: user.country,
          profileImage: user.profileImage,
          role: user.role,
          isVerified: user.isVerified,
          createdAt: user.createdAt
        }
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user data'
    });
  }
};

// @desc    Forgot password
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // Don't reveal if user exists or not
      return res.status(200).json({
        success: true,
        message: 'If an account with that email exists, a password reset code has been sent.'
      });
    }

    // Generate OTP
    const otp = user.generateResetPasswordOTP();
    await user.save();

    // Send email. Same environment-aware policy as register.
    const emailResult = await sendPasswordResetEmail(email, user.fullName, otp);

    if (!emailResult.success) {
      const isProd = process.env.NODE_ENV === 'production';
      if (isProd) {
        return res.status(500).json({
          success: false,
          message: 'Failed to send password reset code. Please try again later.',
        });
      }
      console.log('\n' + '═'.repeat(60));
      console.log('  DEV FALLBACK — Reset SMTP failed. OTP:', otp, '(account:', email + ')');
      console.log('═'.repeat(60) + '\n');
      return res.status(200).json({
        success:   true,
        message:   'Email transport is offline — the reset code is shown in the server console.',
        devOtp:    otp,
        smtpError: emailResult.error,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Password reset code sent to your email'
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process request. Please try again.'
    });
  }
};

// @desc    Reset password
// @route   POST /api/auth/reset-password
// @access  Public
exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, OTP, and new password are required'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long'
      });
    }

    const user = await User.findOne({ email: email.toLowerCase() })
      .select('+resetPasswordOTP +resetPasswordOTPExpires');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const verification = user.verifyOTP(otp, 'reset');
    
    if (!verification.success) {
      return res.status(400).json({
        success: false,
        message: verification.message
      });
    }

    // Update password
    user.password = newPassword;
    user.resetPasswordOTP = undefined;
    user.resetPasswordOTPExpires = undefined;

    // A forgot-password reset is the classic "my account was compromised"
    // action, so it MUST revoke everything — same as an in-app password
    // change. Without this, an attacker's 30-day JWT survives the reset.
    user.passwordChangedAt  = new Date();
    user.tokenInvalidBefore = new Date();
    await user.save();

    // Kill live sockets + mark every session revoked in the audit trail.
    try { require('../socket').disconnectUser(user._id, 'password-reset'); } catch (_) {}
    try {
      const LoginSession = require('../models/LoginSession');
      LoginSession.updateMany(
        { userId: user._id, revokedAt: null, logoutAt: null },
        { $set: { revokedAt: new Date() } },
      ).catch(() => {});
    } catch (_) { /* best-effort */ }
    // Refresh tokens die with the access tokens — otherwise a leaked refresh
    // token would silently re-mint access after the reset.
    refreshTokens.revokeAllForUser(user._id).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Password reset successfully! You can now login with your new password.'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password. Please try again.'
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET PROFILE IMAGE UPLOAD SIGNATURE
// GET /api/auth/profile-image-signature
// Returns signed Cloudinary params so the client can upload a profile image directly
// ─────────────────────────────────────────────────────────────────────────────
exports.getProfileImageSignature = async (req, res) => {
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder    = `truevision/profiles/${req.user.id}`;
    const paramsToSign = { folder, timestamp };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_SECRET_KEY);

    return res.status(200).json({
      success: true,
      signature,
      timestamp,
      folder,
      api_key:    process.env.CLOUDINARY_API_KEY,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    });
  } catch (err) {
    console.error('getProfileImageSignature error:', err);
    return res.status(500).json({ success: false, message: 'Could not generate upload signature' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PROFILE
// PUT /api/auth/profile
// Body: { fullName, username, bio, country, profileImageUrl }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const { fullName, username, bio, country, profileImageUrl } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Check username uniqueness only if it changed
    if (username && username.toLowerCase() !== user.username) {
      const taken = await User.findOne({ username: username.toLowerCase() });
      if (taken) return res.status(400).json({ success: false, message: 'Username is already taken' });
    }

    if (fullName !== undefined)        user.fullName     = fullName.trim();
    if (username !== undefined)        user.username     = username.toLowerCase().trim();
    if (bio !== undefined)             user.bio          = bio.trim();
    if (country !== undefined)         user.country      = country.trim();
    if (profileImageUrl !== undefined) user.profileImage = profileImageUrl;

    await user.save();

    const safeUser = {
      _id:          user._id,
      fullName:     user.fullName,
      username:     user.username,
      email:        user.email,
      bio:          user.bio,
      country:      user.country,
      profileImage: user.profileImage,
      role:         user.role,
      isVerified:   user.isVerified,
    };

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data:    { user: safeUser },
    });
  } catch (err) {
    console.error('updateProfile error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to update profile' });
  }
};

// @desc    Log out — revokes the caller's JWT via Redis so it can't be reused.
// @route   POST /api/auth/logout
// @access  Private (must have a valid Bearer token)
//
// The frontend can start calling this at any time; existing "just delete
// the local token" logout still works, this simply adds server-side kill
// on top so a compromised token becomes useless immediately.
exports.logout = async (req, res) => {
  try {
    const { revokeToken } = require('../middleware/Auth');
    if (req.authToken) await revokeToken(req.authToken);
    // Close the LoginSession row for this device (Security → Login Activity).
    sessionTracker.recordLogout(req.user?._id, req.tokenIat).catch(() => {});
    // Revoke this device's refresh-token family so it can't re-mint access.
    // The client sends its refreshToken in the body; if absent (old client),
    // the access-token revocation above still applies.
    if (req.body?.refreshToken) {
      refreshTokens.revokeByRaw(req.body.refreshToken).catch(() => {});
    }
    return res.status(200).json({ success: true, message: 'Signed out.' });
  } catch (err) {
    console.error('logout error:', err);
    return res.status(200).json({ success: true, message: 'Signed out.' });
  }
};

// @desc    Exchange a refresh token for a new access + refresh token (rotation)
// @route   POST /api/auth/refresh
// @access  Public — the refresh token authenticates itself (no Bearer needed).
//
// Backward-compatible: returns the SAME { token, refreshToken, user } envelope
// the login routes use, so the client's normal session handling applies. On any
// failure it returns 401 with a coded reason so the client logs out gracefully
// (never a refresh loop — the client marks retried requests).
exports.refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      return res.status(400).json({ success: false, code: 'REFRESH_MISSING', message: 'Refresh token required.' });
    }

    let rotated;
    try {
      rotated = await refreshTokens.rotate(refreshToken, { req });
    } catch (e) {
      // REFRESH_INVALID | REFRESH_EXPIRED | REFRESH_REUSED → force re-login.
      return res.status(401).json({
        success: false,
        code:    e.code || 'REFRESH_INVALID',
        message: 'Your session has expired. Please sign in again.',
      });
    }

    const user = await User.findById(rotated.userId);
    if (!user) {
      // Orphaned refresh family — clean it up and force re-login.
      refreshTokens.revokeFamily(rotated.familyId).catch(() => {});
      return res.status(401).json({ success: false, code: 'USER_NOT_FOUND', message: 'Account not found.' });
    }

    // Global cutoff guard: a logout-all / password change sets tokenInvalidBefore
    // AND revokes refresh families, so rotate() would normally already have
    // failed — this is a defensive double-check.
    if (user.tokenInvalidBefore && rotated.sessionIat &&
        rotated.sessionIat * 1000 < new Date(user.tokenInvalidBefore).getTime()) {
      refreshTokens.revokeFamily(rotated.familyId).catch(() => {});
      return res.status(401).json({ success: false, code: 'TOKEN_NOT_ACTIVE', message: 'Session ended. Please sign in again.' });
    }

    const accessToken = generateToken(user._id);
    // Keep Login-Activity honest — bump last-active for this session lineage.
    if (rotated.sessionIat) sessionTracker.touchSession(user._id, rotated.sessionIat).catch(() => {});

    return res.status(200).json({
      success: true,
      data: {
        token:        accessToken,
        refreshToken: rotated.refreshToken,
        user:         publicUser(user),
      },
    });
  } catch (err) {
    console.error('refresh error:', err);
    return res.status(500).json({ success: false, message: 'Could not refresh session.' });
  }
};

// @desc    SMTP diagnostic — sends a single test email
// @route   GET /api/auth/test-email[?to=somebody@example.com]
// @access  Public (dev-only; lock down or remove before production)
//
// Useful when fighting Gmail App-Password issues. Returns the full error
// detail on failure so you can see EAUTH / responseCode / response body
// right in the API response, no log-spelunking needed.
exports.testEmail = async (req, res) => {
  const to = (req.query.to || '').toString().trim() || undefined;
  const result = await sendTestEmail(to);
  if (result.success) {
    return res.status(200).json({
      success:   true,
      message:   'TrueVision email configuration is working successfully.',
      messageId: result.messageId,
      accepted:  result.accepted,
      rejected:  result.rejected,
    });
  }
  return res.status(500).json({
    success: false,
    message: 'SMTP test failed — see error details.',
    error:   result.error,
  });
};

module.exports = exports;