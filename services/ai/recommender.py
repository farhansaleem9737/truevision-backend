"""Educational-first recommendation scorer (Douyin-style bias).

This is a deterministic heuristic, not a learned model. Inputs are a batch
of candidate videos + an optional user profile; the function returns the
same batch re-ranked by score with a short reason string per item.

Score factors (in rough order of influence):
  • Category boost          — Educational > Professional > News > Entertainment
  • Educational score       — passed in from the upstream classifier
  • Engagement              — log-scaled likes + views
  • Watch-time signal       — average seconds watched per viewer
  • Recency decay           — exponential, ~24h half-life
  • User-interest alignment — keyword overlap with the viewer's interests
  • Watch-history alignment — small lift for categories they already watch

Tweak the constants at the top to retune without touching the formula.
"""

from __future__ import annotations

import math
from typing import Dict, List

from config import settings
from schemas import RecommendRequest, RecommendResponse, VideoCandidate, UserProfile

# Category multipliers — pulls educational/professional content up.
CATEGORY_BOOST: Dict[str, float] = {
    "Educational":   1.50,
    "Professional":  1.30,
    "News":          1.10,
    "Entertainment": 1.00,
}

# How quickly old videos decay. Half-life in hours.
RECENCY_HALF_LIFE_HOURS = 24.0


def _reason(c: VideoCandidate, parts: Dict[str, float]) -> str:
    """Build a short human-readable explanation of the top contributing factors."""
    top = sorted(parts.items(), key=lambda kv: kv[1], reverse=True)[:2]
    return ", ".join(f"{name}+{val:.2f}" for name, val in top if val > 0)


def _score_one(
    c: VideoCandidate,
    user: UserProfile | None,
    edu_weight: float,
) -> tuple[float, Dict[str, float]]:
    parts: Dict[str, float] = {}

    # 1) Category × educational score (this is the Douyin-style bias)
    cat_mult = CATEGORY_BOOST.get(c.category or "Entertainment", 1.0)
    parts["edu"] = c.educational_score * edu_weight * cat_mult

    # 2) Engagement — log-scaled so a video with 100k likes doesn't bury
    #    every freshly uploaded one.
    parts["likes"] = math.log1p(max(c.likes, 0)) * 0.40
    parts["views"] = math.log1p(max(c.views, 0)) * 0.15

    # 3) Watch-time signal (cap at 5 minutes equivalent)
    parts["watch"] = min(max(c.watch_time_avg, 0) / 60.0, 5.0) * 0.50

    base = sum(parts.values())

    # 4) Recency decay multiplies the whole score so brand-new content
    #    surfaces even with low engagement.
    decay = math.exp(-max(c.age_hours, 0) / RECENCY_HALF_LIFE_HOURS)
    base *= decay
    parts["recency"] = base * (decay - 1.0)  # informational, not additive

    # 5) User-interest alignment
    if user:
        if c.category and user.watch_history_categories.get(c.category, 0) > 0:
            hist_lift = 0.10 * min(user.watch_history_categories[c.category], 5)
            base *= 1.0 + hist_lift
            parts["history"] = base * hist_lift / (1.0 + hist_lift)

        if user.interests:
            haystack = f"{c.title} {c.description} {' '.join(c.tags)}".lower()
            if any(interest.lower() in haystack for interest in user.interests):
                base *= 1.20
                parts["interest_match"] = base * 0.20 / 1.20

    return base, parts


def recommend(req: RecommendRequest) -> RecommendResponse:
    """Score every candidate, sort descending, return the ranked list."""
    edu_weight = req.educational_weight or settings.educational_weight

    scored: List[Dict] = []
    for c in req.candidates:
        score, parts = _score_one(c, req.user, edu_weight)
        scored.append({
            "video_id": c.video_id,
            "score":    round(score, 4),
            "reason":   _reason(c, parts) or "baseline",
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return RecommendResponse(items=scored)
