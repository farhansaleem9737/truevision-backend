// Backend/services/smsService.js
//
// Phone-OTP delivery with a pluggable provider:
//
//   • If TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER are set
//     AND the `twilio` package is installed, codes go out as real SMS.
//   • Otherwise the code is delivered to the account's VERIFIED EMAIL with
//     an explanatory subject. That keeps the phone-verification flow fully
//     functional end-to-end on a dev machine with zero external accounts;
//     dropping Twilio credentials into .env upgrades it to real SMS with no
//     code change.
//
// Every function resolves { success, channel } — channel tells the caller
// (and the UI) where the code actually went so the message shown to the
// user is honest ("Code sent by SMS" vs "Code sent to your email").

const emailService = require('./emailService');

let twilioClient = null;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER || '';

const initTwilio = () => {
  if (twilioClient) return twilioClient;
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !TWILIO_FROM) return null;
  try {
    // Optional dependency — only required when creds exist.
    // eslint-disable-next-line global-require
    const twilio = require('twilio');
    twilioClient = twilio(sid, token);
    return twilioClient;
  } catch (_) {
    console.warn('[smsService] Twilio creds present but `twilio` package not installed — run: npm i twilio');
    return null;
  }
};

/**
 * Deliver a phone-verification OTP.
 * @param {object} user        Mongoose user (email + fullName used for fallback)
 * @param {string} fullNumber  E.164-ish destination (+92xxxxxxxxxx)
 * @param {string} otp         The 6-digit code
 */
exports.sendPhoneOtp = async (user, fullNumber, otp) => {
  const client = initTwilio();

  if (client) {
    try {
      await client.messages.create({
        from: TWILIO_FROM,
        to:   fullNumber,
        body: `TrueVision: ${otp} is your phone verification code. Valid for 10 minutes.`,
      });
      return { success: true, channel: 'sms' };
    } catch (err) {
      console.error('[smsService] Twilio send failed:', err.message);
      // fall through to email so the user is never stranded
    }
  }

  const emailRes = await emailService.sendSecurityOtpEmail(
    user.email, user.fullName, otp, 'phone-verify',
  );
  return { success: emailRes.success, channel: 'email' };
};

exports.smsConfigured = () => !!initTwilio();
