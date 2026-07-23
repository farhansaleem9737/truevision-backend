# TrueVision — AI Moderation & Review System

Informative-first publishing: entertainment uploads are **not** auto-published;
educational / professional / Islamic / technical / research content is. This
document covers how it works and how to run the admin panel.

## How auto-moderation works

Every **new** upload enters a moderation queue instead of going straight live:

```
Upload → reviewStatus: 'processing'   (NOT public)
        ↓  async AI classifier (Whisper + category + informativeScore)
        ↓  services/moderationPolicy.js decides:
  informative category + score ≥ MODERATION_MIN_SCORE → APPROVED        → public + creator & followers notified
  entertainment/music/comedy/dance/gaming/…           → BLOCKED         → hidden + block screen + creator notified
  classifier down / low score / 'other'               → PENDING_REVIEW  → hidden + goes to admin queue (fail-closed)
```

- **Existing videos are untouched** — they have no `reviewStatus` and public
  queries use `$nin` on the hidden states, so legacy content stays visible with
  no migration. (Verified live: all pre-existing videos remain public.)
- Nothing is deleted or reclassified in the existing pipeline; this is a gate
  added *on top* of the current upload / ranking / NSFW flow.

**Tune it:** `MODERATION_MIN_SCORE` (1–10, default 5) in `.env` — the minimum
informativeScore an approve-category video needs to auto-publish.

## Creator experience

- A blocked upload shows a **Block Screen** (Help & Support → *Uploads under
  review*, or the "Upload blocked" notification): explanation + AI classification
  + a **Request Review** button.
- Request Review opens a form (reason / description / notes / links) that creates
  a **Pending review ticket** for admins. The creator is notified on submit,
  approve, reject, and changes-requested.

## Admin panel (hidden, in-app)

### 1. Configure credentials (`.env`)
Already scaffolded in `Backend/.env` — **change the password before real use**:
```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeMe_TrueVision123   # ← CHANGE THIS
ADMIN_SECRET=<random 96-hex, generated>  # signs admin JWTs (never share)
```
On server start, `services/adminSeed.js` bcrypt-hashes the password into the
`AdminUser` collection (env is the source of truth — rotating it re-syncs).
Leave any of these blank and the admin panel stays disabled.

### 2. Open the panel
It is **not linked in normal UI**. To reach the login:
**Profile → Help & Support → tap the "TrueVision v…" version text 7 times.**
Then sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

### 3. What admins can do
- **Dashboard:** pending reviews, blocked / in-review / approved counts.
- **Queues (tabbed, searchable, paginated):** Blocked · Pending · Requests · All.
- **Detail:** creator info, thumbnail, AI classification + confidence, NSFW +
  transcript details, the review request, and the full audit log.
- **Actions:** Approve · Reject · Request Changes · Delete · Warn · Suspend
  (reject/changes/warn/suspend collect a note shown to the creator).
  - **Approve** → video public + recommendation-indexed + followers + creator notified.
  - **Reject / Request Changes** → creator notified with the reason.
  - **Suspend** → creator can no longer upload (enforced at upload).

Every decision (AI or admin) writes an immutable `ModerationLog` row.

## Security
- Admin auth is a **separate trust domain**: JWT signed with `ADMIN_SECRET`
  (not the app's `JWT_SECRET`), `scope:'admin'`, verified against `AdminUser`.
- All `/api/admin/*` routes require a valid admin token; **login is rate-limited**
  (10/15 min) and the general admin API is limited (120/min).
- Passwords are bcrypt-hashed; credentials live only in env.

## Extending moderation (future-ready)
`services/moderationPolicy.js` runs an ordered list of pluggable **levels**. Add
a new level (copyright, violence, spam, ai-generated, medical-misinformation,
political, explicit …) to the `LEVELS` array — each is `(signals) => verdict`.
The first `blocked`/`pending` wins. No change to the upload pipeline or
controllers is needed.

## New pieces (reference)
- Models: `Video` (+`reviewStatus`/`review`), `ReviewRequest`, `ModerationLog`, `AdminUser`, `User` (+`isSuspended`).
- Services: `moderationPolicy.js`, `moderationService.js`, `adminSeed.js`.
- Auth: `middleware/adminAuth.js`.
- API: `controllers/AdminController.js` + `routes/AdminRoutes.js` (`/api/admin/*`);
  `controllers/ReviewController.js` (creator: `/api/videos/mine/moderation`,
  `POST /api/videos/:id/review-request`).
- App: `screens/moderation/*`, `screens/admin/*`.
