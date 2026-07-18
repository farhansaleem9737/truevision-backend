// Backend/data/appMeta.js
//
// Server-owned app metadata. This is the source of truth the mobile client
// checks against for "Check for Updates": the client sends nothing, it just
// reads `latestClient` and compares with its own installed version.
//
// When you ship a new mobile build, bump `latestClient` here (and add a
// changelog entry in data/changelog.js). `minSupportedClient` lets you force
// an upgrade for builds older than a hard floor (e.g. a breaking API change).

module.exports = {
  // The newest mobile app build available to users.
  latestClient: {
    version:     '1.0.0',
    buildNumber: 1,
    releaseDate: '2026-07-01',
    // A hard-required update (breaking change). Below this, the client should
    // block usage until updated. Keep ≤ latestClient.version.
    mandatory:   false,
    // Where to send users to update when OTA isn't available.
    storeUrl: {
      android: 'https://play.google.com/store/apps/details?id=com.truevision.shorts',
      ios:     'https://apps.apple.com/app/truevision/id0000000000',
    },
  },

  // Builds older than this should be force-upgraded.
  minSupportedClient: {
    version:     '1.0.0',
    buildNumber: 1,
  },

  // Static product facts surfaced on the About screen.
  product: {
    name:    'TrueVision',
    tagline: 'Authentic Knowledge. Trusted Content.',
    website: 'https://truevision.app',
    supportEmail: 'support@truevision.app',
  },
};
