// Backend/data/faqs.js
//
// Help Center FAQ content served at GET /api/support/faqs. Organized by
// category; each article has a stable id (used for "recently viewed") and an
// optional `popular` flag surfaced in the "Popular articles" rail.
//
// To add an article: drop it in the right category with a unique id. To add a
// category: add an entry with a matching key from the SupportTicket categories.

const CATEGORIES = [
  { key: 'account',       label: 'Account',              icon: 'person-outline' },
  { key: 'videos',        label: 'Videos',               icon: 'videocam-outline' },
  { key: 'comments',      label: 'Comments',             icon: 'chatbubble-ellipses-outline' },
  { key: 'messaging',     label: 'Messaging',            icon: 'mail-outline' },
  { key: 'privacy',       label: 'Privacy',              icon: 'lock-closed-outline' },
  { key: 'security',      label: 'Security',             icon: 'shield-checkmark-outline' },
  { key: 'uploads',       label: 'Uploads',              icon: 'cloud-upload-outline' },
  { key: 'notifications', label: 'Notifications',        icon: 'notifications-outline' },
  { key: 'payments',      label: 'Payments (coming soon)', icon: 'card-outline' },
];

const ARTICLES = [
  // ── Account ──────────────────────────────────────────────────────────────
  { id: 'acc-change-username', category: 'account', popular: true,
    question: 'How do I change my username or profile details?',
    answer: 'Go to Settings → Edit Profile. You can update your name, username, bio, and country. Usernames must be unique and use only lowercase letters, numbers and underscores.' },
  { id: 'acc-delete', category: 'account',
    question: 'How do I delete my account?',
    answer: 'Open Settings → Privacy and choose Delete Account. This permanently removes your videos, comments and messages. The action cannot be undone.' },
  { id: 'acc-reset-password', category: 'account', popular: true,
    question: 'I forgot my password. How do I reset it?',
    answer: 'On the login screen tap “Forgot Password”, enter your email, and follow the 6-digit code we send you to set a new password.' },

  // ── Videos ───────────────────────────────────────────────────────────────
  { id: 'vid-quality', category: 'videos',
    question: 'Why does video quality change while watching?',
    answer: 'TrueVision adapts quality to your connection. Enable “HD on Wi-Fi only” or “Data Saver” in Settings → Content Preferences to control this.' },
  { id: 'vid-not-playing', category: 'videos', popular: true,
    question: 'A video won’t play or keeps buffering. What can I do?',
    answer: 'Check your connection, then pull to refresh the feed. If one video fails, the player automatically retries at a lower quality. Persistent issues? Send us a bug report.' },
  { id: 'vid-save', category: 'videos',
    question: 'How do I save a video to watch later?',
    answer: 'Tap the bookmark icon on any video. Saved videos appear under My Activity → Saved Videos.' },

  // ── Comments ─────────────────────────────────────────────────────────────
  { id: 'com-who', category: 'comments',
    question: 'Who can comment on my videos?',
    answer: 'Control this in Settings → Privacy → Who can comment: Everyone, Followers, Mutual Followers, or Nobody.' },
  { id: 'com-delete', category: 'comments',
    question: 'Can I edit or delete my comments?',
    answer: 'Yes. Long-press your comment to edit or delete it. You can review everything you’ve posted under My Activity → Comments.' },

  // ── Messaging ────────────────────────────────────────────────────────────
  { id: 'msg-who', category: 'messaging',
    question: 'Who can send me messages?',
    answer: 'Set this in Settings → Privacy → Who can message me. Blocked users can never message you.' },
  { id: 'msg-read', category: 'messaging',
    question: 'What do the checkmarks mean?',
    answer: 'One check means sent, two grey checks mean delivered, and two blue checks mean the message was read.' },

  // ── Privacy ──────────────────────────────────────────────────────────────
  { id: 'priv-private', category: 'privacy', popular: true,
    question: 'How do I make my account private?',
    answer: 'Enable Settings → Privacy → Private Account. Then only approved followers can see your videos, and new followers must send a request.' },
  { id: 'priv-block', category: 'privacy',
    question: 'How do I block or unblock someone?',
    answer: 'Open a profile and choose Block, or manage everyone under Settings → Privacy → Blocked Users. Blocked users can’t message, comment, follow, or see your private content.' },
  { id: 'priv-online', category: 'privacy',
    question: 'Can I hide my online status?',
    answer: 'Yes. Turn on Settings → Privacy → Hide Online Status. Others won’t see when you’re active or your last-seen time.' },

  // ── Security ─────────────────────────────────────────────────────────────
  { id: 'sec-2fa', category: 'security', popular: true,
    question: 'How do I enable two-factor authentication?',
    answer: 'Go to Settings → Security → Two-Factor Authentication. Once enabled, you’ll enter an emailed code each time you sign in.' },
  { id: 'sec-sessions', category: 'security',
    question: 'How do I see where I’m logged in?',
    answer: 'Settings → Security → Login Activity lists your active sessions. You can sign out any device you don’t recognize.' },

  // ── Uploads ──────────────────────────────────────────────────────────────
  { id: 'upl-how', category: 'uploads', popular: true,
    question: 'How do I upload a video?',
    answer: 'Tap the + button in the tab bar, pick a video, add a title, tags and category, then publish. Videos are checked by our moderation system before going live.' },
  { id: 'upl-limits', category: 'uploads',
    question: 'What are the file size and length limits?',
    answer: 'Videos up to 500 MB are supported and are automatically optimized to 720p for smooth playback.' },
  { id: 'upl-failed', category: 'uploads',
    question: 'My upload failed. What should I do?',
    answer: 'Make sure you’re on a stable connection and the file is a supported format (mp4, mov, webm). Retry from the upload screen; if it keeps failing, send a bug report.' },

  // ── Notifications ────────────────────────────────────────────────────────
  { id: 'notif-manage', category: 'notifications',
    question: 'How do I manage notifications?',
    answer: 'Open Settings → Notifications to toggle pushes for likes, comments, new followers, messages and mentions, plus email preferences.' },
  { id: 'notif-none', category: 'notifications',
    question: 'I’m not receiving notifications. Why?',
    answer: 'Check that notifications are enabled both in TrueVision and in your device’s system settings, and that the app has permission to send them.' },

  // ── Payments (future) ────────────────────────────────────────────────────
  { id: 'pay-soon', category: 'payments',
    question: 'Does TrueVision support payments or monetization?',
    answer: 'Payments and creator monetization are coming in a future update. There’s nothing to set up yet — watch the changelog under About → Check for Updates.' },
];

module.exports = {
  version: '1.0.0',
  updatedAt: '2026-07-01',
  categories: CATEGORIES,
  articles: ARTICLES,
};
