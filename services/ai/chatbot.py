"""FAQ-retrieval chatbot.

Loads a small sentence-transformer model (default: all-MiniLM-L6-v2, ~80MB)
and a JSON FAQ knowledge base, embeds every question once at startup, then
answers queries by cosine-similarity nearest-neighbour lookup.

Why retrieval-instead-of-generation:
  • zero hallucination — answers come straight from the curated FAQ
  • no paid LLM API needed
  • fits the "professional/technical FAQ" use case the spec describes

If you want generative answers later, swap `chat()` for an LLM call
without touching the public schema.
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Dict, List

import numpy as np

from config import settings
from schemas import ChatRequest

logger = logging.getLogger(__name__)

# Match below this similarity → return a polite fallback instead of a
# possibly-irrelevant FAQ answer.
MIN_SIMILARITY = 0.40

_model = None
_faqs: List[Dict] | None = None
_q_embeddings: np.ndarray | None = None
_lock = threading.Lock()


def _load_faqs() -> List[Dict]:
    """Read the FAQ knowledge base from disk. Cached."""
    global _faqs
    if _faqs is not None:
        return _faqs
    path = Path(settings.faq_path)
    if not path.is_file():
        logger.warning("FAQ file not found at %s — chatbot will fall back.", path)
        _faqs = []
        return _faqs
    _faqs = json.loads(path.read_text(encoding="utf-8"))
    logger.info("Loaded %d FAQs from %s", len(_faqs), path)
    return _faqs


def _load_model():
    """Lazy-init the sentence-transformer encoder."""
    global _model
    if _model is not None:
        return _model
    from sentence_transformers import SentenceTransformer  # heavy import
    logger.info("Loading sentence-transformer %s ...", settings.embed_model)
    _model = SentenceTransformer(settings.embed_model)
    logger.info("Embedder ready.")
    return _model


def _ensure_index() -> None:
    """Compute embeddings for every FAQ question once and cache them."""
    global _q_embeddings
    if _q_embeddings is not None:
        return
    with _lock:
        if _q_embeddings is not None:
            return
        faqs = _load_faqs()
        if not faqs:
            _q_embeddings = np.zeros((0, 1), dtype=np.float32)
            return
        model = _load_model()
        questions = [f["question"] for f in faqs]
        _q_embeddings = model.encode(
            questions,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )


def chat(req: ChatRequest) -> Dict:
    """Run a single chat turn. History is accepted but currently unused —
    retrieval is stateless. Hook it in here if you switch to generation."""
    _ensure_index()

    if _q_embeddings is None or _q_embeddings.shape[0] == 0:
        return {
            "answer": "The FAQ knowledge base is empty right now. Please try again later.",
            "matched_question": None,
            "confidence": 0.0,
        }

    model = _load_model()
    q_vec = model.encode(
        [req.message],
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )[0]

    sims = _q_embeddings @ q_vec
    best_idx = int(np.argmax(sims))
    best_score = float(sims[best_idx])

    if best_score < MIN_SIMILARITY:
        return {
            "answer": (
                "I'm not sure about that one yet. Try rephrasing, or ask about "
                "uploads, recommendations, moderation, or account settings."
            ),
            "matched_question": None,
            "confidence": best_score,
        }

    faq = _faqs[best_idx]
    return {
        "answer": faq["answer"],
        "matched_question": faq["question"],
        "confidence": best_score,
    }
