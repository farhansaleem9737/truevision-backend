"""Runtime configuration for the AI microservice.

All values are read from env vars with sensible defaults; see .env.example.
Importing this module is side-effect-free — no models load here.
"""

import os
from pathlib import Path

try:
    # Loads .env from the ai/ folder if python-dotenv is installed.
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except Exception:
    pass


class Settings:
    """Lightweight settings container — no pydantic dep needed."""

    def __init__(self) -> None:
        here = Path(__file__).resolve().parent

        # FAQ knowledge base (used by /chatbot)
        self.faq_path: str = os.environ.get(
            "TRUEVISION_FAQ_PATH", str(here / "data" / "faqs.json")
        )

        # Sentence-transformer model name for the chatbot. Auto-downloads
        # on first use to your HF cache (~80 MB).
        self.embed_model: str = os.environ.get(
            "CHATBOT_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
        )

        # ── Zero-shot classifier (facebook/bart-large-mnli) ────────────────
        # HF model id for /predict. Auto-downloads (~1.6 GB) to the HF cache on
        # first load, then runs locally/offline and is reused if already cached.
        self.bart_model: str = os.environ.get("BART_MODEL", "facebook/bart-large-mnli")

        # "auto" → CUDA when available else CPU. Force with "cpu" / "cuda".
        self.bart_device: str = os.environ.get("BART_DEVICE", "auto")

        # Optional HF cache dir override for the weights. Blank = default cache.
        self.bart_download_root: str = os.environ.get("BART_DOWNLOAD_ROOT", "").strip()

        # Candidate labels the zero-shot head scores every transcript against.
        raw_labels = os.environ.get(
            "CLASSIFIER_LABELS",
            "Educational,Technical,Professional,News,Entertainment,Islamic,Poetry",
        )
        self.zero_shot_labels: list[str] = [s.strip() for s in raw_labels.split(",") if s.strip()]

        # NLI hypothesis template; "{}" is filled with each candidate label.
        self.hypothesis_template: str = os.environ.get(
            "CLASSIFIER_HYPOTHESIS", "This text is about {}."
        )

        # Cap transcript length (chars) fed to the classifier. BART also
        # truncates at the token level — this just bounds latency.
        self.classifier_max_chars: int = int(os.environ.get("CLASSIFIER_MAX_CHARS", "4000"))

        # ── Moderation thresholds ──────────────────────────────────────────
        # Top score below this → "Unknown" + manual review.
        self.unknown_threshold: float = float(
            os.environ.get("CLASSIFIER_UNKNOWN_THRESHOLD", "0.45")
        )
        # Poetry is accepted only at/above this confidence, else sent for review.
        self.poetry_threshold: float = float(
            os.environ.get("CLASSIFIER_POETRY_THRESHOLD", "0.70")
        )

        # ── HTTP server ────────────────────────────────────────────────────
        self.host: str = os.environ.get("AI_HOST", "0.0.0.0")
        self.port: int = int(os.environ.get("AI_PORT", "8001"))

        # Comma-separated. "*" allows all (dev only).
        self.cors_origins: list[str] = [
            o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()
        ]

        # Optional shared secret. When set, every request must carry
        # X-API-Key: <value>. Node's aiClient injects this automatically.
        self.api_key: str | None = os.environ.get("AI_API_KEY") or None

        # ── Recommendation tunables ────────────────────────────────────────
        self.educational_weight: float = float(os.environ.get("EDU_WEIGHT", "1.5"))

        # ── Moderation tunables ────────────────────────────────────────────
        self.frames_per_video: int = int(os.environ.get("MODERATION_FRAMES", "5"))
        self.fetch_timeout: float = float(os.environ.get("FETCH_TIMEOUT", "20"))

        # ── Faster-Whisper (speech → text) ─────────────────────────────────
        # Model size: tiny | base | small | medium | large-v3. `base` is the
        # spec default — good accuracy/speed on CPU. Auto-downloads on first
        # use to the HF cache, then runs fully offline.
        self.whisper_model: str = os.environ.get("WHISPER_MODEL", "base")

        # "auto" → cuda when available else cpu. Force with "cpu" / "cuda".
        self.whisper_device: str = os.environ.get("WHISPER_DEVICE", "auto")

        # "auto" → int8 on CPU, float16 on CUDA. int8 keeps `base` fast on CPU.
        self.whisper_compute_type: str = os.environ.get("WHISPER_COMPUTE_TYPE", "auto")

        # Empty → auto-detect the spoken language.
        self.whisper_language: str = os.environ.get("WHISPER_LANGUAGE", "").strip()

        self.whisper_beam_size: int = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))

        # Voice-activity filter: skips silence, cutting runtime on sparse audio.
        self.whisper_vad: bool = os.environ.get("WHISPER_VAD", "true").lower() == "true"

        # Optional custom cache dir for the model weights (defaults to HF cache).
        self.whisper_download_root: str = os.environ.get("WHISPER_DOWNLOAD_ROOT", "").strip()

        # Hard cap on transcribed audio length (seconds). 0 = no cap.
        # Protects a worker from a pathological multi-hour upload.
        self.whisper_max_audio_seconds: int = int(os.environ.get("WHISPER_MAX_AUDIO_SECONDS", "900"))

        # ── FFmpeg ─────────────────────────────────────────────────────────
        # Leave empty to auto-discover on PATH (the normal case).
        self.ffmpeg_path: str = os.environ.get("FFMPEG_PATH", "").strip()
        self.ffprobe_path: str = os.environ.get("FFPROBE_PATH", "").strip()
        self.ffmpeg_timeout: float = float(os.environ.get("FFMPEG_TIMEOUT", "120"))

        # Max size for an uploaded/downloaded video accepted by /transcribe (MB).
        self.max_video_mb: int = int(os.environ.get("MAX_VIDEO_MB", "500"))


settings = Settings()
