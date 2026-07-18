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
    # Primary category. None only for empty input; "Unknown" when the model is
    # not confident about any label.
    category: Optional[str] = None
    confidence: float = 0.0
    second_category: Optional[str] = None
    second_confidence: float = 0.0
    all_scores: Dict[str, float] = {}
    # Moderation verdict from the policy: 'ACCEPT' | 'REVIEW'.
    moderation: str = "REVIEW"
    moderation_reason: str = ""


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


# ── /transcribe ──────────────────────────────────────────────────────────────

class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str


class TranscribeResponse(BaseModel):
    transcript: str
    # None when the transcript is empty OR when the classifier is unavailable
    # (see classifier_error) — the transcript is still returned either way.
    category: Optional[str] = None
    confidence: float = 0.0
    second_category: Optional[str] = None
    second_confidence: float = 0.0
    # Set when Whisper succeeded but the BART classifier could not run (e.g.
    # the model failed to load). Transcription is NOT failed in that case.
    classifier_error: Optional[str] = None
    all_scores: Dict[str, float] = {}
    # Moderation verdict from the policy: 'ACCEPT' | 'REVIEW'. Null when empty.
    moderation: Optional[str] = None
    moderation_reason: str = ""
    language: str = ""
    language_probability: float = 0.0
    duration: float = 0.0               # audio length in seconds
    processing_time: float = 0.0        # end-to-end seconds
    empty: bool = False                 # True when no speech was detected
    video_id: Optional[str] = None
    segments: List[TranscriptSegment] = []


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
