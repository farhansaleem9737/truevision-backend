// Backend/services/pushService.js
//
// Fan-out push notifications to a user's registered devices.
//
// Two delivery paths — both wired, either optional:
//   1. Expo Push Service (expo-server-sdk). Expo forwards to FCM on Android
//      and APNs on iOS with a single call. This is the primary path for the
//      current Expo-managed app.
//   2. Firebase Cloud Messaging directly (firebase-admin). Kept as a stub
//      for a future dev-client / bare-workflow migration where we want to
//      bypass Expo. Uses FCM tokens stored separately on the User doc.
//
// GRACEFUL DEGRADATION — if `expo-server-sdk` is not installed or the
// Firebase admin credentials are missing, sendChatNotification is a no-op
// that logs a single warning and returns. The chat still works; only the
// push channel is inert.

let Expo = null;
try {
  // eslint-disable-next-line import/no-unresolved
  Expo = require('expo-server-sdk').Expo;
} catch (_) {
  // Optional dep — install with `npm i expo-server-sdk` when ready.
}

let admin = null;
try {
  // eslint-disable-next-line import/no-unresolved
  const firebaseAdmin = require('firebase-admin');
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!firebaseAdmin.apps.length) {
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(svc) });
    }
    admin = firebaseAdmin;
  }
} catch (_) {
  // Optional dep.
}

const expo = Expo ? new Expo() : null;

let warnedMissing = false;
const warnOnce = () => {
  if (warnedMissing) return;
  warnedMissing = true;
  console.warn('[push] No push provider configured — chat notifications are a no-op.');
};

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Core delivery — fan a {title, body, data, channelId} out to every device
 * the recipient has registered, over whichever providers are configured.
 * All public senders below are thin wrappers around this.
 */
const deliver = async (user, { title, body, data = {}, channelId = 'default', badge }) => {
  if (!user) return { sent: 0, failed: 0 };
  const expoTokens = (user.expoPushTokens || []).filter(t => Expo?.isExpoPushToken?.(t));
  const fcmTokens  = user.fcmTokens || [];

  if (!expoTokens.length && !fcmTokens.length) return { sent: 0, failed: 0 };
  if (!expo && !admin) { warnOnce(); return { sent: 0, failed: 0 }; }

  let sent = 0, failed = 0;

  // Expo path — batches of up to 100 messages per Expo API rule.
  if (expo && expoTokens.length) {
    const messages = expoTokens.map((to) => ({
      to,
      sound: 'default',
      title: title || 'TrueVision',
      body:  body  || '',
      // Attached data lets the app deep-link when the notification is tapped.
      data,
      // High-priority so Android delivers immediately even when doze-mode.
      priority: 'high',
      channelId,
      // iOS app-icon badge — notificationCenter passes the unread count.
      ...(Number.isFinite(badge) ? { badge } : {}),
    }));

    for (const chunk of expo.chunkPushNotifications(messages)) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        tickets.forEach((t) => (t.status === 'ok' ? sent++ : failed++));
      } catch (err) {
        console.error('[push:expo] send error:', err.message);
        failed += chunk.length;
      }
    }
  }

  // FCM path — direct send. Kept simple; a future dev-client can lean on this.
  if (admin && fcmTokens.length) {
    try {
      const stringData = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v ?? '')]),
      );
      const resp = await admin.messaging().sendEachForMulticast({
        tokens: fcmTokens,
        notification: { title: title || 'TrueVision', body: body || '' },
        data: stringData,
        android: { priority: 'high', notification: { channelId } },
      });
      sent   += resp.successCount || 0;
      failed += resp.failureCount || 0;
    } catch (err) {
      console.error('[push:fcm] send error:', err.message);
      failed += fcmTokens.length;
    }
  }

  return { sent, failed };
};

/**
 * Send a chat push to every device the recipient has registered.
 *
 * @param {Object}   user         Recipient user doc (must include expoPushTokens & fcmTokens)
 * @param {Object}   payload      { title, body, chatId, senderId, messageId, type }
 * @returns {Promise<{sent: number, failed: number}>}
 */
exports.sendChatNotification = (user, payload) =>
  deliver(user, {
    title: payload.title || 'New message',
    body:  payload.body  || '',
    data: {
      chatId:    payload.chatId    || null,
      senderId:  payload.senderId  || null,
      messageId: payload.messageId || null,
      type:      payload.type      || 'text',
    },
    channelId: 'chat-messages',
    badge: payload.badge,
  });

/**
 * Social-graph pushes: new follower, follow request, request accepted.
 *
 * @param {Object} user     Recipient user doc (expoPushTokens & fcmTokens)
 * @param {Object} payload  { title, body, kind: 'follow'|'follow_request'|'request_accepted', fromUserId }
 */
exports.sendSocialNotification = (user, payload) =>
  deliver(user, {
    title: payload.title || 'TrueVision',
    body:  payload.body  || '',
    data: {
      // Spread the caller's data FIRST so deep-link ids (videoId, commentId,
      // chatId…) survive; the explicit keys below stay authoritative.
      ...(payload.data || {}),
      kind:       payload.kind       || 'social',
      // `type` is the ACTION ('like'/'comment'/'mention'/'follow'), which the
      // caller supplies in data. Only fall back to kind when it's absent, so
      // a push tap can navigate exactly like the stored history row says.
      type:       payload.data?.type || payload.kind || 'social',
      fromUserId: payload.fromUserId || null,
    },
    channelId: 'social',
    badge: payload.badge,
  });

/**
 * Small helper to build a preview line for a message.
 */
exports.previewFor = (message) => {
  if (!message) return '';
  if (message.deleted) return 'Message was deleted';
  switch (message.type) {
    case 'image':    return '📷 Photo';
    case 'video':    return '🎬 Video';
    case 'voice':    return '🎤 Voice note';
    case 'audio':    return '🎵 Audio';
    case 'gif':      return '🎞  GIF';
    case 'document': return `📎 ${message.documentName || 'Document'}`;
    default:         return (message.text || '').slice(0, 140);
  }
};

exports.available = () => !!(expo || admin);
