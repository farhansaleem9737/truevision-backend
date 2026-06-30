const nodemailer = require('nodemailer');

// ── Config readers ──────────────────────────────────────────────────────────
// `dotenv.config()` MUST already have run by the time these are called. That
// happens at the top of server.js (require('dotenv').config() is line 1) and
// the transporter below is lazy-initialised, so we never read env vars before
// they're populated.
const readUser = () => (process.env.EMAIL_USER || '').trim();

// Accept either EMAIL_PASS (per the canonical spec) or the legacy
// EMAIL_PASSWORD that this project shipped with. Whitespace from copy-paste
// is stripped defensively — Gmail's App-Password display uses spaces.
const readPass = () => {
  const raw = process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD || '';
  return raw.replace(/\s+/g, '');
};

// ── Lazy-initialised, cached, verified transporter ─────────────────────────
// We hold one transporter for the whole process. It's created on first use
// (so env vars are guaranteed loaded), verified against Gmail's SMTP, and
// then reused. A failed verify throws — callers translate into a 5xx.
let _transporter = null;
let _verifyPromise = null;

const buildTransporter = () => nodemailer.createTransport({
  // Explicit smtp.gmail.com:465 + secure is more reliable than `service: gmail`
  // — same endpoint, but Nodemailer doesn't have to look up service preset.
  host:   'smtp.gmail.com',
  port:   465,
  secure: true,
  auth: {
    user: readUser(),
    pass: readPass(),
  },
  // Pool reuses TCP connections; keeps register/resend bursts fast.
  pool:           true,
  maxConnections: 3,
  maxMessages:    50,
  // Tight timeouts so a hung connection fails the request quickly instead
  // of stalling the user on the verify screen.
  connectionTimeout: 10000,
  greetingTimeout:   10000,
  socketTimeout:     15000,
});

/**
 * Get the live transporter, verifying credentials against Gmail on the very
 * first call. Subsequent calls return the cached, verified instance.
 * Throws a structured Error on any verify failure — see `formatSmtpError`.
 */
const getTransporter = async () => {
  if (_transporter) return _transporter;
  if (_verifyPromise) return _verifyPromise;

  _verifyPromise = (async () => {
    const t = buildTransporter();
    try {
      await t.verify();
      _transporter = t;
      console.log('[emailService] SMTP transporter verified — ready to send.');
      return t;
    } catch (err) {
      _verifyPromise = null; // allow retry next call
      throw err;
    }
  })();

  return _verifyPromise;
};

/**
 * Force a fresh verify next time. Useful after rotating EMAIL_PASS at runtime
 * (you still need to restart Node for dotenv to pick up the new value, but
 * this clears any stale cached transporter).
 */
const resetTransporter = () => {
  if (_transporter) {
    try { _transporter.close(); } catch (_) { /* swallow */ }
  }
  _transporter   = null;
  _verifyPromise = null;
};

// ── Boot-time visibility ───────────────────────────────────────────────────
// Tiny, secret-safe banner so devs can confirm the env reached the service.
exports.logConfigStatus = () => {
  const user = readUser();
  const pass = readPass();
  console.log('[emailService] Config check:');
  console.log('  EMAIL_USER:    ', user || '(empty)');
  console.log('  EMAIL_PASS:    ', pass ? `set (${pass.length} chars)` : 'MISSING');
  if (pass && pass.length !== 16) {
    console.warn('  ⚠️  Gmail App Passwords are exactly 16 chars — current length is ' + pass.length + '. Regenerate at https://myaccount.google.com/apppasswords');
  }
};

// ── Detailed SMTP error formatter ──────────────────────────────────────────
// Surfaces every diagnostic Nodemailer hangs off the error object so backend
// logs make the failure root-cause unambiguous.
const formatSmtpError = (err) => ({
  code:         err?.code,           // e.g. 'EAUTH', 'ESOCKET'
  responseCode: err?.responseCode,   // e.g. 535
  response:     err?.response,       // the full SMTP server reply
  command:      err?.command,        // e.g. 'AUTH PLAIN'
  message:      err?.message,
  stack:        err?.stack,
});

exports._formatSmtpError = formatSmtpError; // exported for use in controllers / test route
exports._resetTransporter = resetTransporter;
exports._getTransporter   = getTransporter;

// Modern, professional verification email template
const getVerificationEmailHTML = (fullName, otp) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Your TrueVision Account</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
      line-height: 1.6;
      color: #333;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 40px 20px;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    .header {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      padding: 50px 30px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .header::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: repeating-linear-gradient(
        45deg,
        transparent,
        transparent 10px,
        rgba(255, 255, 255, 0.05) 10px,
        rgba(255, 255, 255, 0.05) 20px
      );
      animation: slide 20s linear infinite;
    }
    @keyframes slide {
      0% { transform: translate(0, 0); }
      100% { transform: translate(50px, 50px); }
    }
    .logo-circle {
      width: 90px;
      height: 90px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
      backdrop-filter: blur(10px);
      border: 3px solid rgba(255, 255, 255, 0.3);
      position: relative;
    }
    .logo-emoji {
      font-size: 40px;
      filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.2));
    }
    .header h1 {
      color: #ffffff;
      font-size: 36px;
      font-weight: 800;
      margin: 0 0 10px 0;
      position: relative;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }
    .header p {
      color: #e0e7ff;
      font-size: 16px;
      font-weight: 500;
      margin: 0;
      position: relative;
    }
    .content {
      padding: 50px 40px;
    }
    .greeting {
      font-size: 26px;
      color: #1f2937;
      margin-bottom: 20px;
      font-weight: 700;
    }
    .message {
      color: #4b5563;
      font-size: 16px;
      line-height: 1.8;
      margin-bottom: 30px;
    }
    .otp-box {
      background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
      border-radius: 20px;
      padding: 40px;
      text-align: center;
      margin: 35px 0;
      border: 3px solid #3b82f6;
      box-shadow: 0 10px 30px rgba(59, 130, 246, 0.15);
      position: relative;
    }
    .otp-box::before {
      content: '🔒';
      position: absolute;
      top: -20px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 32px;
      background: white;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    .otp-label {
      color: #1e40af;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 2px;
      font-weight: 700;
      margin-bottom: 15px;
    }
    .otp-code {
      font-size: 56px;
      font-weight: 900;
      color: #1e3a8a;
      letter-spacing: 16px;
      margin: 20px 0;
      font-family: 'Courier New', monospace;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.1);
      user-select: all;
    }
    .expiry-badge {
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
      color: #92400e;
      font-size: 14px;
      padding: 12px 24px;
      border-radius: 12px;
      display: inline-block;
      margin-top: 20px;
      font-weight: 600;
      border: 2px solid #fbbf24;
    }
    .divider {
      height: 2px;
      background: linear-gradient(to right, transparent, #e5e7eb, transparent);
      margin: 35px 0;
    }
    .security-alert {
      background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
      border-left: 5px solid #ef4444;
      padding: 20px;
      border-radius: 12px;
      margin: 30px 0;
    }
    .security-alert p {
      margin: 0;
      color: #991b1b;
      font-size: 15px;
      line-height: 1.6;
    }
    .security-alert strong {
      color: #7f1d1d;
      font-weight: 700;
    }
    .help-box {
      background: #f9fafb;
      border-radius: 12px;
      padding: 20px;
      margin: 30px 0;
      border: 1px solid #e5e7eb;
    }
    .help-box h3 {
      color: #374151;
      font-size: 16px;
      margin-bottom: 10px;
      font-weight: 600;
    }
    .help-box ul {
      margin: 0;
      padding-left: 20px;
      color: #6b7280;
      font-size: 14px;
    }
    .help-box li {
      margin: 8px 0;
    }
    .footer {
      background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
      padding: 40px;
      text-align: center;
      border-top: 3px solid #e5e7eb;
    }
    .brand {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      font-weight: 800;
      font-size: 18px;
      margin-bottom: 10px;
      display: inline-block;
    }
    .footer-text {
      color: #6b7280;
      font-size: 14px;
      margin: 8px 0;
    }
    .footer-small {
      color: #9ca3af;
      font-size: 12px;
      margin-top: 15px;
    }
    @media only screen and (max-width: 600px) {
      .email-container {
        border-radius: 0;
      }
      .content {
        padding: 30px 20px;
      }
      .otp-code {
        font-size: 32px;
        letter-spacing: 10px;
      }
      .greeting {
        font-size: 22px;
      }
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <div class="logo-circle">
        <span class="logo-emoji">🎬</span>
      </div>
      <h1>TrueVision</h1>
      <p>Authentic • Verified • Intelligent</p>
    </div>
    
    <div class="content">
      <p class="greeting">Welcome, ${fullName}! 👋</p>
      
      <p class="message">
        Thank you for joining <strong>TrueVision</strong>, the AI-powered short video information platform. 
        We're excited to have you on board! To complete your registration and unlock all features, 
        please verify your email address using the code below.
      </p>
      
      <div class="otp-box">
        <div class="otp-label">Your Verification Code</div>
        <div class="otp-code">${otp}</div>
        <div class="expiry-badge">⏱️ Valid for 15 minutes</div>
      </div>
      
      <div class="divider"></div>
      
      <div class="security-alert">
        <p>
          <strong>🔒 Security Notice:</strong> Never share this verification code with anyone. 
          TrueVision staff will never ask for your verification code via phone, email, or social media. 
          If you didn't create an account, please ignore this email or contact our support team.
        </p>
      </div>
      
      <div class="help-box">
        <h3>Having trouble?</h3>
        <ul>
          <li>Make sure you're entering the code exactly as shown above</li>
          <li>The code is case-sensitive and expires after 15 minutes</li>
          <li>Check your spam folder if you don't see this email</li>
          <li>Request a new code if this one has expired</li>
        </ul>
      </div>
    </div>
    
    <div class="footer">
      <div class="brand">TrueVision</div>
      <p class="footer-text">BS-IT Final Year Project | Powered by AI</p>
      <p class="footer-small">© ${new Date().getFullYear()} TrueVision. All rights reserved.</p>
      <p class="footer-small">
        This is an automated message, please do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>
`;

// Modern, professional password reset email template
const getPasswordResetEmailHTML = (fullName, otp) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your TrueVision Password</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
      line-height: 1.6;
      color: #333;
      background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
      padding: 40px 20px;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    .header {
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
      padding: 50px 30px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .header::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: repeating-linear-gradient(
        45deg,
        transparent,
        transparent 10px,
        rgba(255, 255, 255, 0.05) 10px,
        rgba(255, 255, 255, 0.05) 20px
      );
      animation: slide 20s linear infinite;
    }
    @keyframes slide {
      0% { transform: translate(0, 0); }
      100% { transform: translate(50px, 50px); }
    }
    .logo-circle {
      width: 90px;
      height: 90px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
      backdrop-filter: blur(10px);
      border: 3px solid rgba(255, 255, 255, 0.3);
      position: relative;
    }
    .logo-emoji {
      font-size: 40px;
      filter: drop-shadow(0 4px 8px rgba(0, 0, 0, 0.2));
    }
    .header h1 {
      color: #ffffff;
      font-size: 36px;
      font-weight: 800;
      margin: 0 0 10px 0;
      position: relative;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }
    .header p {
      color: #fecaca;
      font-size: 16px;
      font-weight: 500;
      margin: 0;
      position: relative;
    }
    .content {
      padding: 50px 40px;
    }
    .greeting {
      font-size: 26px;
      color: #1f2937;
      margin-bottom: 20px;
      font-weight: 700;
    }
    .message {
      color: #4b5563;
      font-size: 16px;
      line-height: 1.8;
      margin-bottom: 30px;
    }
    .otp-box {
      background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
      border-radius: 20px;
      padding: 40px;
      text-align: center;
      margin: 35px 0;
      border: 3px solid #dc2626;
      box-shadow: 0 10px 30px rgba(220, 38, 38, 0.15);
      position: relative;
    }
    .otp-box::before {
      content: '🔑';
      position: absolute;
      top: -20px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 32px;
      background: white;
      width: 50px;
      height: 50px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    .otp-label {
      color: #991b1b;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 2px;
      font-weight: 700;
      margin-bottom: 15px;
    }
    .otp-code {
      font-size: 56px;
      font-weight: 900;
      color: #7f1d1d;
      letter-spacing: 16px;
      margin: 20px 0;
      font-family: 'Courier New', monospace;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.1);
      user-select: all;
    }
    .expiry-badge {
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
      color: #92400e;
      font-size: 14px;
      padding: 12px 24px;
      border-radius: 12px;
      display: inline-block;
      margin-top: 20px;
      font-weight: 600;
      border: 2px solid #fbbf24;
    }
    .divider {
      height: 2px;
      background: linear-gradient(to right, transparent, #e5e7eb, transparent);
      margin: 35px 0;
    }
    .security-alert {
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
      border-left: 5px solid #f59e0b;
      padding: 20px;
      border-radius: 12px;
      margin: 30px 0;
    }
    .security-alert p {
      margin: 0;
      color: #92400e;
      font-size: 15px;
      line-height: 1.6;
    }
    .security-alert strong {
      color: #78350f;
      font-weight: 700;
    }
    .help-box {
      background: #f9fafb;
      border-radius: 12px;
      padding: 20px;
      margin: 30px 0;
      border: 1px solid #e5e7eb;
    }
    .help-box h3 {
      color: #374151;
      font-size: 16px;
      margin-bottom: 10px;
      font-weight: 600;
    }
    .help-box ul {
      margin: 0;
      padding-left: 20px;
      color: #6b7280;
      font-size: 14px;
    }
    .help-box li {
      margin: 8px 0;
    }
    .footer {
      background: linear-gradient(135deg, #f9fafb 0%, #f3f4f6 100%);
      padding: 40px;
      text-align: center;
      border-top: 3px solid #e5e7eb;
    }
    .brand {
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      font-weight: 800;
      font-size: 18px;
      margin-bottom: 10px;
      display: inline-block;
    }
    .footer-text {
      color: #6b7280;
      font-size: 14px;
      margin: 8px 0;
    }
    .footer-small {
      color: #9ca3af;
      font-size: 12px;
      margin-top: 15px;
    }
    @media only screen and (max-width: 600px) {
      .email-container {
        border-radius: 0;
      }
      .content {
        padding: 30px 20px;
      }
      .otp-code {
        font-size: 42px;
        letter-spacing: 10px;
      }
      .greeting {
        font-size: 22px;
      }
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <div class="logo-circle">
        <span class="logo-emoji">🔒</span>
      </div>
      <h1>Password Reset</h1>
      <p>TrueVision Security</p>
    </div>
    
    <div class="content">
      <p class="greeting">Hi ${fullName},</p>
      
      <p class="message">
        We received a request to reset your TrueVision account password. 
        Use the verification code below to create a new password. 
        If you didn't request this, you can safely ignore this email.
      </p>
      
      <div class="otp-box">
        <div class="otp-label">Your Reset Code</div>
        <div class="otp-code">${otp}</div>
        <div class="expiry-badge">⏱️ Valid for 15 minutes</div>
      </div>
      
      <div class="divider"></div>
      
      <div class="security-alert">
        <p>
          <strong>⚠️ Security Alert:</strong> If you didn't request a password reset, 
          please ignore this email and ensure your account is secure. Consider changing 
          your password if you suspect unauthorized access.
        </p>
      </div>
      
      <div class="help-box">
        <h3>Password Reset Tips</h3>
        <ul>
          <li>Use a strong, unique password (at least 8 characters)</li>
          <li>Include a mix of uppercase, lowercase, numbers, and symbols</li>
          <li>Don't reuse passwords from other accounts</li>
          <li>Enable two-factor authentication when available</li>
        </ul>
      </div>
    </div>
    
    <div class="footer">
      <div class="brand">TrueVision</div>
      <p class="footer-text">BS-IT Final Year Project | Powered by AI</p>
      <p class="footer-small">© ${new Date().getFullYear()} TrueVision. All rights reserved.</p>
      <p class="footer-small">
        This is an automated message, please do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>
`;

// Send verification email — uses the verified, cached transporter.
exports.sendVerificationEmail = async (email, fullName, otp) => {
  try {
    const transporter = await getTransporter();

    const info = await transporter.sendMail({
      from:    { name: 'TrueVision', address: readUser() },
      to:      email,
      subject: '🎬 Verify Your TrueVision Account',
      html:    getVerificationEmailHTML(fullName, otp),
      text:    `Welcome ${fullName}! Your TrueVision verification code is: ${otp}. This code expires in 15 minutes.`,
    });

    console.log('[emailService] Verification email sent', {
      messageId: info.messageId,
      to:        email,
      accepted:  info.accepted,
      rejected:  info.rejected,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const detail = formatSmtpError(error);
    console.error('[emailService] sendVerificationEmail FAILED', { to: email, ...detail });
    return { success: false, error: detail };
  }
};

// Send password reset email — uses the verified, cached transporter.
exports.sendPasswordResetEmail = async (email, fullName, otp) => {
  try {
    const transporter = await getTransporter();

    const info = await transporter.sendMail({
      from:    { name: 'TrueVision Security', address: readUser() },
      to:      email,
      subject: '🔒 Reset Your TrueVision Password',
      html:    getPasswordResetEmailHTML(fullName, otp),
      text:    `Hi ${fullName}, your TrueVision password reset code is: ${otp}. This code expires in 15 minutes. If you didn't request this, please ignore this email.`,
    });

    console.log('[emailService] Password-reset email sent', {
      messageId: info.messageId,
      to:        email,
      accepted:  info.accepted,
      rejected:  info.rejected,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const detail = formatSmtpError(error);
    console.error('[emailService] sendPasswordResetEmail FAILED', { to: email, ...detail });
    return { success: false, error: detail };
  }
};

// ── Diagnostic / test helper ───────────────────────────────────────────────
// Used by the GET /api/auth/test-email route. Lets you confirm SMTP works
// without going through the register flow.
exports.sendTestEmail = async (toAddress) => {
  try {
    const transporter = await getTransporter();

    const info = await transporter.sendMail({
      from:    { name: 'TrueVision', address: readUser() },
      to:      toAddress || readUser(),
      subject: 'SMTP Test',
      text:    'TrueVision email configuration is working successfully.',
      html:    '<p style="font-family:system-ui;font-size:15px;color:#0f172a">'
             + '<strong>TrueVision</strong> email configuration is working successfully.'
             + '</p>',
    });
    console.log('[emailService] Test email sent', { messageId: info.messageId, to: info.envelope?.to });
    return { success: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } catch (error) {
    const detail = formatSmtpError(error);
    console.error('[emailService] sendTestEmail FAILED', { to: toAddress, ...detail });
    return { success: false, error: detail };
  }
};

module.exports = exports;