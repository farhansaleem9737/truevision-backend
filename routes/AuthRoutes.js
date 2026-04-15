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
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Protected routes (WITH protect middleware)
router.get('/me',                        protect, authController.getMe);
router.get('/profile-image-signature',   protect, authController.getProfileImageSignature);
router.put('/profile',                   protect, authController.updateProfile);

module.exports = router;