// Backend/services/weeklyReports.js
//
// Weekly creator-stats email for users with preferences.notifications
// .emailWeekly = true. A lightweight in-process scheduler: every 6 hours it
// finds opted-in users whose lastWeeklyReportAt is 7+ days old (or never),
// aggregates their last-7-day stats, and emails a report.
//
// Deliberately conservative: batches of 20 users per sweep so a big backlog
// (first deploy) doesn't hammer SMTP; the rest catch up on later sweeps.

const User          = require('../models/User');
const Video         = require('../models/Video');
const SharedVideo   = require('../models/SharedVideo');
const Comment       = require('../models/Comment');
const emailService  = require('./emailService');

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;  // 6 hours
const WEEK_MS        = 7 * 24 * 60 * 60 * 1000;
const BATCH          = 20;

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n || 0));

/** Aggregate one user's last-7-day stats.
 *
 *  Watch data lives in the embedded Video.views[] array (viewSchema: userId,
 *  watchTime, viewedAt). A popular creator can have tens of thousands of
 *  entries across their catalogue, so the week's slice is computed INSIDE
 *  MongoDB with $filter/$reduce — the arrays are never pulled into Node.
 *  The document projection likewise excludes `views` entirely. */
const statsFor = async (userId, since) => {
  const [agg] = await Video.aggregate([
    { $match: { userId: new (require('mongoose').Types.ObjectId)(String(userId)), status: 'active' } },
    {
      $project: {
        likesCount: 1,
        createdAt:  1,
        // Only the last-7-day view entries, reduced to counters server-side.
        weekViews: {
          $size: {
            $filter: {
              input: { $ifNull: ['$views', []] },
              as:    'v',
              cond:  { $gte: ['$$v.viewedAt', since] },
            },
          },
        },
        weekWatch: {
          $reduce: {
            input: {
              $filter: {
                input: { $ifNull: ['$views', []] },
                as:    'v',
                cond:  { $gte: ['$$v.viewedAt', since] },
              },
            },
            initialValue: 0,
            in: { $add: ['$$value', { $ifNull: ['$$this.watchTime', 0] }] },
          },
        },
      },
    },
    {
      $group: {
        _id:            null,
        ids:            { $push: '$_id' },
        totalLikes:     { $sum: '$likesCount' },
        weekViews:      { $sum: '$weekViews' },
        weekWatchSecs:  { $sum: '$weekWatch' },
        uploadsThisWeek:{ $sum: { $cond: [{ $gte: ['$createdAt', since] }, 1, 0] } },
      },
    },
  ]);

  const ids = agg?.ids || [];

  const [user, shares, comments] = await Promise.all([
    User.findById(userId).select('followers').lean(),
    ids.length ? SharedVideo.countDocuments({ videoId: { $in: ids }, createdAt: { $gte: since } }) : 0,
    ids.length ? Comment.countDocuments({ videoId: { $in: ids }, createdAt: { $gte: since } }) : 0,
  ]);

  return {
    'Videos uploaded (7d)':  fmt(agg?.uploadsThisWeek || 0),
    'Views (7d)':            fmt(agg?.weekViews || 0),
    'Watch time (7d)':       `${Math.round((agg?.weekWatchSecs || 0) / 60)} min`,
    'Comments (7d)':         fmt(comments),
    'Shares (7d)':           fmt(shares),
    'Total likes (all time)': fmt(agg?.totalLikes || 0),
    'Followers':             fmt(user?.followers?.length || 0),
  };
};

const sweep = async () => {
  try {
    const cutoff = new Date(Date.now() - WEEK_MS);
    const due = await User.find({
      'preferences.notifications.emailWeekly': true,
      $or: [
        { lastWeeklyReportAt: null },
        { lastWeeklyReportAt: { $lt: cutoff } },
      ],
    })
      .select('email fullName lastWeeklyReportAt')
      .limit(BATCH)
      .lean();

    if (!due.length) return;
    console.log(`[weeklyReports] sending ${due.length} report(s)`);

    for (const u of due) {
      try {
        const stats = await statsFor(u._id, cutoff);
        const sent  = await emailService.sendWeeklyReportEmail(u.email, u.fullName, stats);
        // Stamp even on failure so a broken mailbox doesn't retry every sweep.
        await User.updateOne({ _id: u._id }, { $set: { lastWeeklyReportAt: new Date() } });
        if (!sent.success) console.warn(`[weeklyReports] send failed for ${u.email}`);
      } catch (err) {
        console.warn(`[weeklyReports] user ${u._id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[weeklyReports] sweep failed:', err.message);
  }
};

let timer = null;
exports.start = () => {
  if (timer) return;
  // First sweep 2 minutes after boot (let Mongo settle), then every 6h.
  setTimeout(() => { sweep(); timer = setInterval(sweep, SWEEP_EVERY_MS); }, 2 * 60 * 1000);
  console.log('[weeklyReports] scheduler armed (6h sweeps)');
};

exports.sweepOnce = sweep; // exported for manual/testing runs
