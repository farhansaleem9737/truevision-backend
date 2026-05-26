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

        # ── Model paths ────────────────────────────────────────────────────
        # Default: Backend/models/truevision_model/  (relative to this file)
        default_model_dir = here.parent.parent / "models" / "truevision_model"
        self.model_dir: str = os.environ.get(
            "TRUEVISION_MODEL_DIR", str(default_model_dir)
        )

        # FAQ knowledge base (used by /chatbot)
        self.faq_path: str = os.environ.get(
            "TRUEVISION_FAQ_PATH", str(here / "data" / "faqs.json")
        )

        # Sentence-transformer model name for the chatbot. Auto-downloads
        # on first use to your HF cache (~80 MB).
        self.embed_model: str = os.environ.get(
            "CHATBOT_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2"
        )

        # Override the DistilBERT class labels. The user-supplied
        # truevision_model/config.json has generic LABEL_0..LABEL_3 entries,
        # so we map indices → human names here. Order MUST match the order
        # the model was trained against. Comma-separated, no spaces required.
        raw_labels = os.environ.get(
            "TRUEVISION_LABELS",
            "Educational,Professional,News,Entertainment",
        )
        self.labels: list[str] = [s.strip() for s in raw_labels.split(",") if s.strip()]

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

    @property
    def model_dir_exists(self) -> bool:
        return Path(self.model_dir).is_dir()


settings = Settings()
