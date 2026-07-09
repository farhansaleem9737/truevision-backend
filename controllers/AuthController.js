const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { sendVerificationEmail, sendPasswordResetEmail, sendTestEmail } = require('../services/emailService');
const cloudinary = require('../config/cloudinary');

// One client per process — used to verify ID tokens issued by Google.
// We accept tokens minted for any of the three OAuth client IDs we register
// in Google Cloud Console (iOS, Android, Web — Expo Go uses the Web one).
const GOOGLE_AUDIENCES = [
  process.env.GOOGLE_CLIENT_ID_IOS,
  process.env.GOOGLE_CLIENT_ID_ANDROID,
  process.env.GOOGLE_CLIENT_ID_WEB,
].filter(Boolean);

const googleClient = new OAuth2Client();

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d'
  });
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

    // Send verification email. Failure behaviour depends on environment:
    //   • production → roll back the user, return HTTP 500 (per spec)
    //   • non-prod   → keep the user, log the OTP to the console + expose
    //                  it in the response under `devOtp` so QA can keep
    //                  testing while SMTP is being fixed.
    const emailResult = await sendVerificationEmail(email, fullName, otp);

    if (!emailResult.success) {
      const isProd = process.env.NODE_ENV === 'production';

      if (isProd) {
        try { await User.deleteOne({ _id: user._id }); } catch (_) { /* ignore */ }
        return res.status(500).json({
          success: false,
          message: 'We could not send your verification email. Please contact support or try again later.',
        });
      }

      // Dev fallback — registration succeeds, OTP shown in console + body.
      console.log('\n' + '═'.repeat(60));
      console.log('  DEV FALLBACK — SMTP failed but user is created.');
      console.log('  Account: ' + email);
      console.log('  OTP:     ' + otp + '   (15 min)');
      console.log('  Fix SMTP → see /api/auth/test-email response.');
      console.log('═'.repeat(60) + '\n');

      return res.status(201).json({
        success: true,
        message: 'Registration successful. Email transport is offline — the verification code is shown in the server console.',
        data: {
          userId:    user._id,
          email:     user.email,
          username:  user.username,
          emailSent: false,
          devOtp:    otp,
          smtpError: emailResult.error,
        },
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

    // Generate token
    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      message: 'Email verified successfully!',
      data: {
        token,
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
exports.resendOTP = async (req, res) => {
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

    // Generate new OTP
    const otp = user.generateVerificationOTP();
    await user.save();

    // Send email. Same environment-aware policy as register: prod fails
    // hard, non-prod returns success with the OTP for local testing.
    const emailResult = await sendVerificationEmail(email, user.fullName, otp);

    if (!emailResult.success) {
      const isProd = process.env.NODE_ENV === 'production';
      if (isProd) {
        return res.status(500).json({
          success: false,
          message: 'Failed to send verification code. Please try again later.',
        });
      }
      console.log('\n' + '═'.repeat(60));
      console.log('  DEV FALLBACK — Resend SMTP failed. OTP:', otp, '(account:', email + ')');
      console.log('═'.repeat(60) + '\n');
      return res.status(200).json({
        success:   true,
        message:   'Email transport is offline — the verification code is shown in the server console.',
        devOtp:    otp,
        smtpError: emailResult.error,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Verification code sent successfully!'
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

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate token
    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      message: 'Login successful!',
      data: {
        token,
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
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
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

    // 3) Bookkeeping + JWT, identical to the /login response envelope.
    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);

    return res.status(200).json({
      success: true,
      message: isNew ? 'Account created with Google' : 'Signed in with Google',
      data: {
        token,
        user: {
          _id:          user._id,
          fullName:     user.fullName,
          username:     user.username,
          email:        user.email,
          country:      user.country,
          profileImage: user.profileImage,
          role:         user.role,
          isVerified:   user.isVerified,
          createdAt:    user.createdAt,
        },
      },
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
    await user.save();

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
    return res.status(200).json({ success: true, message: 'Signed out.' });
  } catch (err) {
    console.error('logout error:', err);
    return res.status(200).json({ success: true, message: 'Signed out.' });
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