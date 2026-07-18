"""Faster-Whisper speech-to-text.

Open-source Whisper via CTranslate2 — no OpenAI API, no paid service, fully
local. The model (default: `base`) auto-downloads to the HuggingFace cache on
first use and is reused from disk afterwards.

Mirrors classifier.py's contract on purpose: a lazy, thread-safe `load()` that
the FastAPI lifespan calls once at startup, plus a pure `transcribe()`. The
model instance is created ONCE and reused for every request.
"""

from __future__ import annotations

import logging
import threading
from typing import Dict

from config import settings

logger = logging.getLogger(__name__)

_model = None
_lock = threading.Lock()
_load_error: str | None = None


class WhisperLoadError(RuntimeError):
    """faster-whisper could not be imported or the model failed to load."""


def _resolve_device() -> tuple[str, str]:
    """Pick (device, compute_type). 'auto' → cuda when available, else cpu.

    int8 on CPU is ~4x faster than float32 with negligible WER impact, which is
    what makes the `base` model viable on a CPU-only host.
    """
    device = settings.whisper_device
    if device == "auto":
        try:
            import torch  # already a dependency (DistilBERT)
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:  # noqa: BLE001
            device = "cpu"

    compute = settings.whisper_compute_type
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"
    return device, compute


def load() -> None:
    """Load the Whisper model once. Idempotent and thread-safe.

    Raises WhisperLoadError so the caller can decide whether to degrade (the
    lifespan logs a warning) or return 503 (the /transcribe route).
    """
    global _model, _load_error

    if _model is not None:
        return
    if _load_error is not None:
        # Don't retry a hard failure on every request.
        raise WhisperLoadError(_load_error)

    with _lock:
        if _model is not None:
            return
        if _load_error is not None:
            raise WhisperLoadError(_load_error)

        try:
            from faster_whisper import WhisperModel  # heavy — import lazily
        except ImportError as e:
            _load_error = (
                "faster-whisper is not installed. Run: "
                "pip install faster-whisper"
            )
            raise WhisperLoadError(_load_error) from e

        device, compute_type = _resolve_device()
        logger.info(
            "Loading Faster-Whisper '%s' on %s (compute_type=%s) ...",
            settings.whisper_model, device, compute_type,
        )
        try:
            _model = WhisperModel(
                settings.whisper_model,
                device=device,
                compute_type=compute_type,
                download_root=settings.whisper_download_root or None,
            )
        except Exception as e:  # noqa: BLE001 — model download/CUDA/etc.
            _load_error = f"Failed to load Whisper model '{settings.whisper_model}': {e}"
            logger.error(_load_error)
            raise WhisperLoadError(_load_error) from e

        logger.info("Faster-Whisper ready (%s on %s).", settings.whisper_model, device)


def is_ready() -> bool:
    return _model is not None


def transcribe(audio_path: str) -> Dict:
    """Transcribe a 16 kHz mono WAV.

    Returns {text, language, language_probability, duration, segments}.
    An empty `text` is a valid result (silent/music-only video) — the caller
    decides what to do with it.
    """
    load()

    segments, info = _model.transcribe(
        audio_path,
        beam_size=settings.whisper_beam_size,
        language=settings.whisper_language or None,  # None → auto-detect
        vad_filter=settings.whisper_vad,             # drops silence → faster + cleaner
    )

    # `segments` is a generator — consuming it is what actually runs inference.
    parts: list[str] = []
    seg_out: list[Dict] = []
    for s in segments:
        text = (s.text or "").strip()
        if not text:
            continue
        parts.append(text)
        seg_out.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": text})

    return {
        "text": " ".join(parts).strip(),
        "language": getattr(info, "language", "") or "",
        "language_probability": float(getattr(info, "language_probability", 0.0) or 0.0),
        "duration": float(getattr(info, "duration", 0.0) or 0.0),
        "segments": seg_out,
    }
