"""Pydantic request/response schemas.

These are the contracts the Node aiClient depends on — keep field names
stable across versions or update both ends together.
"""

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ── /predict ─────────────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


class PredictResponse(BaseModel):
    category: str
    confidence: float
    all_scores: Dict[str, float]


# ── /recommend ───────────────────────────────────────────────────────────────

class VideoCandidate(BaseModel):
    """One video the recommender will score."""

    video_id: str
    title: str = ""
    description: str = ""
    tags: List[str] = []
    category: Optional[str] = None
    educational_score: float = 0.0   # 0..1; informativeScore-equivalent
    watch_time_avg: float = 0.0      # seconds — average per viewer
    likes: int = 0
    views: int = 0
    age_hours: float = 0.0           # video age in hours (for recency decay)


class UserProfile(BaseModel):
    """Optional viewer signals. Pass to bias ranking toward their interests."""

    interests: List[str] = []
    watch_history_categories: Dict[str, int] = {}   # category -> watch count


class RecommendRequest(BaseModel):
    candidates: List[VideoCandidate]
    user: Optional[UserProfile] = None
    # Override default educational boost. Higher = more Douyin-style edu bias.
    educational_weight: Optional[float] = None


class RecommendedItem(BaseModel):
    video_id: str
    score: float
    reason: str


class RecommendResponse(BaseModel):
    items: List[RecommendedItem]


# ── /moderate ────────────────────────────────────────────────────────────────

class ModerateRequest(BaseModel):
    """Pass either a single image URL or a list (for video frame batches)."""

    image_url: Optional[str] = None
    image_urls: Optional[List[str]] = None


class ModerationDetection(BaseModel):
    label: str
    score: float


class ModerateResponse(BaseModel):
    status: Literal["SAFE", "NSFW", "PORN"]
    confidence: float
    detections: List[ModerationDetection] = []
    fallback: bool = False


# ── /chatbot ─────────────────────────────────────────────────────────────────

class ChatTurn(BaseModel):
    role: Literal["user", "bot"]
    text: str


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=1000)
    history: List[ChatTurn] = []


class ChatResponse(BaseModel):
    answer: str
    matched_question: Optional[str] = None
    confidence: float
