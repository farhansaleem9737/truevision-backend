//Backend/routes/AuthRoutes.js

const express = require('express');
const router = express.Router();
const authController = require('../controllers/AuthController');
const { protect } = require('../middleware/Auth');

// Public routes (NO protect middleware)
router.post('/register', authController.register);
router.post('/verify-email', authController.verifyEmail);
router.post('/resend-otp', authController.resendOTP);
router.post('/login', authController.login);
router.post('/google', authController.googleSignIn);

// 2FA sign-in completion — authenticated by the short-lived pendingToken
// issued by /login when the account has twoFactorEnabled.
router.post('/2fa-verify', authController.twoFactorVerify);
router.post('/2fa-resend', authController.twoFactorResend);

// SMTP diagnostic — leave mounted while you're stabilising email transport;
// remove or guard with an admin role before going to production.
router.get('/test-email', authController.testEmail);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Protected routes (WITH protect middleware)
router.post('/logout',                   protect, authController.logout);
router.get('/me',                        protect, authController.getMe);
router.get('/profile-image-signature',   protect, authController.getProfileImageSignature);
router.put('/profile',                   protect, authController.updateProfile);

module.exports = router;