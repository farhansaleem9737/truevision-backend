// Backend/controllers/AppController.js
//
// App metadata + health surface for the "About TrueVision" module.
//   GET /api/app/version    — lightweight version + latest-client info
//   GET /api/app/info       — full diagnostics (env, backend ver, db, api)
//   GET /api/app/changelog  — release history ("What's New")
//
// All three are PUBLIC (no auth) — the About screen must work before login and
// the update check must not depend on a valid session.

const mongoose  = require('mongoose');
const appMeta   = require('../data/appMeta');
const changelog = require('../data/changelog');
const backendPkg = require('../package.json');

const ok   = (res, data, code = 200) => res.status(code).json({ success: true,  ...data });
const fail = (res, msg,  code = 500) => res.status(code).json({ success: false, message: msg });

// Mongoose readyState → human label. 1 = connected.
const DB_STATES = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
const dbStatus = () => {
  const state = mongoose.connection?.readyState ?? 0;
  return {
    status:    DB_STATES[state] || 'unknown',
    healthy:   state === 1,
    name:      mongoose.connection?.name || null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/app/version
// The compact payload the update checker needs.
// ─────────────────────────────────────────────────────────────────────────────
exports.getVersion = (req, res) => {
  try {
    return ok(res, {
      backendVersion:     backendPkg.version,
      latestClient:       appMeta.latestClient,
      minSupportedClient: appMeta.minSupportedClient,
    });
  } catch (err) {
    console.error('getVersion error:', err);
    return fail(res, 'Failed to fetch version');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/app/info
// Full diagnostics for the About screen's "App Information" card.
// ─────────────────────────────────────────────────────────────────────────────
exports.getInfo = (req, res) => {
  try {
    const db = dbStatus();
    return ok(res, {
      app: {
        name:    appMeta.product.name,
        tagline: appMeta.product.tagline,
        website: appMeta.product.website,
      },
      environment:    process.env.NODE_ENV || 'development',
      backendVersion: backendPkg.version,
      latestClient:   appMeta.latestClient,
      api: {
        status:    'operational',
        uptimeSec: Math.round(process.uptime()),
        serverTime: new Date().toISOString(),
      },
      database: db,
    });
  } catch (err) {
    console.error('getInfo error:', err);
    return fail(res, 'Failed to fetch app info');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/app/changelog
// ─────────────────────────────────────────────────────────────────────────────
exports.getChangelog = (req, res) => {
  try {
    return ok(res, { releases: changelog });
  } catch (err) {
    console.error('getChangelog error:', err);
    return fail(res, 'Failed to fetch changelog');
  }
};
