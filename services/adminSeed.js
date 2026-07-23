// Backend/services/adminSeed.js
//
// Seeds/updates the moderation-panel admin from environment variables on server
// start. Credentials live ONLY in env (ADMIN_USERNAME / ADMIN_PASSWORD); the
// password is bcrypt-hashed into the AdminUser collection and never stored in
// plaintext. env is the source of truth — rotating it re-syncs the hash.

const AdminUser = require('../models/AdminUser');

async function seedAdmin() {
  const username = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');

  if (!username || !password) {
    console.warn('[adminSeed] ADMIN_USERNAME / ADMIN_PASSWORD not set — admin panel login is disabled until you set them.');
    return;
  }
  if (!process.env.ADMIN_SECRET) {
    console.warn('[adminSeed] ADMIN_SECRET not set — admin JWTs cannot be signed. Set ADMIN_SECRET to enable the admin panel.');
  }

  try {
    let admin = await AdminUser.findOne({ username });
    if (!admin) {
      admin = new AdminUser({ username, role: 'superadmin', active: true });
      await admin.setPassword(password);
      await admin.save();
      console.log(`[adminSeed] created admin '${username}'`);
    } else {
      // Keep the hash in sync with env (env is the source of truth).
      await admin.setPassword(password);
      admin.active = true;
      await admin.save();
      console.log(`[adminSeed] admin '${username}' synced from env`);
    }
  } catch (err) {
    console.error('[adminSeed] failed:', err.message);
  }
}

module.exports = { seedAdmin };
