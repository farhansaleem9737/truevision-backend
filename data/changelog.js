// Backend/data/changelog.js
//
// Release history served at GET /api/app/changelog and consumed by the
// "Check for Updates" → "What's New" section. Newest first.
//
// Each release: { version, buildNumber, date (ISO), highlights[], type }.
// `type` is 'major' | 'minor' | 'patch' — the client can badge accordingly.

module.exports = [
  {
    version:     '1.0.0',
    buildNumber: 1,
    date:        '2026-07-01',
    type:        'major',
    highlights: [
      'First public release of TrueVision.',
      'AI-moderated short-video feed with fact / news / opinion labels.',
      'Private accounts, follow requests, blocking and audience controls.',
      'Real-time chat with read receipts, media and message forwarding.',
      'Multi-language support with right-to-left layouts for Arabic and Urdu.',
    ],
  },
];
