"""Zero-shot content classifier — facebook/bart-large-mnli.

Replaces the previous DistilBERT sequence classifier. Uses the Hugging Face
`zero-shot-classification` pipeline, which lets us score a transcript against
an arbitrary, config-driven label set with NO fine-tuning and NO local weights
to manage.

The model (~1.6 GB) auto-downloads to the HuggingFace cache on first load and
is reused from disk on every subsequent run (offline-capable thereafter). It is
loaded exactly ONCE — a thread-safe singleton shared across all requests (see
load() and the FastAPI lifespan) — never per request.

Public interface is intentionally unchanged so the API layer keeps working:
    load()          — build the pipeline once (idempotent, thread-safe)
    is_ready()      — bool, read-only probe for /health
    predict(text)   — classify + apply the TrueVision moderation policy
"""

from __future__ import annotations

import logging
import threading
from typing import Dict, List, Optional, Tuple

from config import settings

logger = logging.getLogger(__name__)

# Lazy singleton — importing this module must not pay the model-load cost.
_pipe = None
_lock = threading.Lock()
_load_error: Optional[str] = None


class ClassifierLoadError(RuntimeError):
    """The zero-shot model could not be loaded (bad download / incompatible
    transformers / OOM). Mapped to HTTP 503 by the API layer."""


# ── Moderation policy ────────────────────────────────────────────────────────
# ACCEPT outright. Everything else is reviewed (Entertainment always; Poetry
# only when low-confidence; Unknown when the model isn't confident about
# anything). Kept here — the classifier owns the decision so callers get one
# consistent verdict.
ACCEPT_CATEGORIES = {"Educational", "Technical", "Professional", "News", "Islamic"}

DECISION_ACCEPT = "ACCEPT"
DECISION_REVIEW = "REVIEW"


def _cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:  # noqa: BLE001
        return False


def _resolve_device() -> int:
    """HF pipeline device: 0 = first CUDA GPU, -1 = CPU."""
    dev = settings.bart_device
    if dev == "cpu":
        return -1
    if dev == "cuda":
        return 0
    return 0 if _cuda_available() else -1


def load() -> None:
    """Build the zero-shot pipeline once. Idempotent and thread-safe.

    Raises ClassifierLoadError so the caller can decide whether to degrade
    (the lifespan logs a warning) or return 503 (/predict)."""
    global _pipe, _load_error

    if _pipe is not None:
        return
    if _load_error is not None:
        # Don't retry a hard failure on every request.
        raise ClassifierLoadError(_load_error)

    with _lock:
        if _pipe is not None:
            return
        if _load_error is not None:
            raise ClassifierLoadError(_load_error)

        # Optional cache-dir override — set before importing transformers so the
        # hub honours it. Default HF cache is used when unset (reused if the
        # weights are already present → no re-download).
        if settings.bart_download_root:
            import os
            os.environ.setdefault("HF_HOME", settings.bart_download_root)

        try:
            from transformers import pipeline  # heavy — import lazily
        except ImportError as e:
            _load_error = (
                "transformers is not installed. Run: pip install transformers torch"
            )
            raise ClassifierLoadError(_load_error) from e

        device = _resolve_device()
        logger.info(
            "Loading zero-shot classifier '%s' (device=%s) ...",
            settings.bart_model, "cuda" if device == 0 else "cpu",
        )
        try:
            _pipe = pipeline(
                "zero-shot-classification",
                model=settings.bart_model,
                device=device,
            )
        except Exception as e:  # noqa: BLE001 — download/incompat/OOM
            _load_error = f"Failed to load '{settings.bart_model}': {e}"
            logger.error(_load_error)
            raise ClassifierLoadError(_load_error) from e

        logger.info(
            "BART zero-shot ready on %s | labels=%s",
            "cuda" if device == 0 else "cpu", settings.zero_shot_labels,
        )


def is_ready() -> bool:
    """True once the model is resident. Read-only — does not trigger a load."""
    return _pipe is not None


def _decide(primary: str, confidence: float, all_scores: Dict[str, float]) -> Tuple[str, str, str]:
    """Apply the moderation policy. Returns (category, decision, reason).

    Order matters: the "not confident about anything" check comes first so an
    ambiguous transcript is flagged Unknown even if some label technically
    ranked first.
    """
    top = max(all_scores.values()) if all_scores else 0.0

    if top < settings.unknown_threshold:
        return "Unknown", DECISION_REVIEW, f"all-scores-below-{settings.unknown_threshold:.2f}"

    if primary in ACCEPT_CATEGORIES:
        return primary, DECISION_ACCEPT, "accepted-category"

    if primary == "Entertainment":
        return primary, DECISION_REVIEW, "entertainment-needs-review"

    if primary == "Poetry":
        if confidence < settings.poetry_threshold:
            return primary, DECISION_REVIEW, f"poetry-below-{settings.poetry_threshold:.2f}"
        return primary, DECISION_ACCEPT, "poetry-high-confidence"

    # Any label outside the known policy set → be safe, review it.
    return primary, DECISION_REVIEW, "uncategorized"


def _empty_result(labels: List[str]) -> Dict:
    return {
        "category": None,
        "confidence": 0.0,
        "second_category": None,
        "second_confidence": 0.0,
        "all_scores": {label: 0.0 for label in labels},
        "moderation": DECISION_REVIEW,
        "moderation_reason": "empty-text",
    }


def predict(text: str) -> Dict:
    """Zero-shot classify `text` and apply the moderation policy.

    Returns:
      category, confidence, second_category, second_confidence, all_scores,
      moderation ('ACCEPT' | 'REVIEW'), moderation_reason.
    """
    load()  # cheap no-op once warm

    labels = settings.zero_shot_labels
    cleaned = (text or "").strip()
    if not cleaned:
        return _empty_result(labels)

    # Bound latency on very long transcripts — BART also truncates at the token
    # level (1024), this just caps the char count we hand it.
    if len(cleaned) > settings.classifier_max_chars:
        cleaned = cleaned[: settings.classifier_max_chars]

    out = _pipe(
        cleaned,
        candidate_labels=labels,
        multi_label=False,  # scores are softmaxed across labels → sum to 1
        hypothesis_template=settings.hypothesis_template,
    )

    # Pipeline returns labels + scores already sorted high → low.
    ranked_labels: List[str] = out["labels"]
    ranked_scores: List[float] = [float(s) for s in out["scores"]]
    all_scores = {label: score for label, score in zip(ranked_labels, ranked_scores)}

    primary = ranked_labels[0]
    confidence = ranked_scores[0]
    second = ranked_labels[1] if len(ranked_labels) > 1 else None
    second_conf = ranked_scores[1] if len(ranked_scores) > 1 else 0.0

    category, decision, reason = _decide(primary, confidence, all_scores)

    return {
        "category": category,
        "confidence": confidence,
        "second_category": second,
        "second_confidence": second_conf,
        "all_scores": all_scores,
        "moderation": decision,
        "moderation_reason": reason,
    }
