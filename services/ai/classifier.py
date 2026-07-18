"""DistilBERT category classifier.

Loads the user-trained model from `Backend/models/truevision_model/` and
exposes a single thread-safe `predict(text)` function. The model is loaded
once on first use and cached for the life of the process.

Expected model files in the directory:
  config.json, model.safetensors, tokenizer.json, tokenizer_config.json, vocab.txt

Label mapping is read from `model.config.id2label` when present; otherwise
falls back to the four classes the user trained against, in this order:
  0: Educational, 1: Professional, 2: News, 3: Entertainment
"""

from __future__ import annotations

import logging
import threading
from typing import Dict

from config import settings

logger = logging.getLogger(__name__)

# Lazy globals so the module can be imported without paying the model load
# cost at startup. `load()` may be called explicitly during FastAPI lifespan
# to warm them up before traffic arrives.
_tokenizer = None
_model = None
_id2label: Dict[int, str] | None = None
_device: str | None = None
_lock = threading.Lock()

DEFAULT_LABELS: Dict[int, str] = {
    0: "Educational",
    1: "Professional",
    2: "News",
    3: "Entertainment",
}


def _resolve_labels(cfg_map: Dict) -> Dict[int, str]:
    """Pick the best available label mapping.

    Priority:
      1. settings.labels       — env var TRUEVISION_LABELS (explicit override)
      2. config.json id2label  — but only if names are meaningful (not LABEL_*)
      3. DEFAULT_LABELS        — last-resort hard-coded fallback
    """
    if settings.labels:
        return {i: name for i, name in enumerate(settings.labels)}

    if cfg_map and not all(str(v).startswith("LABEL_") for v in cfg_map.values()):
        return {int(k): v for k, v in cfg_map.items()}

    return DEFAULT_LABELS


def load() -> None:
    """Load tokenizer + model into memory. Idempotent and thread-safe."""
    global _tokenizer, _model, _id2label, _device

    if _model is not None:
        return

    with _lock:
        if _model is not None:  # second check inside the lock
            return

        if not settings.model_dir_exists:
            raise FileNotFoundError(
                f"DistilBERT model directory not found at {settings.model_dir}. "
                "Place config.json, model.safetensors, tokenizer.json, "
                "tokenizer_config.json, vocab.txt in this folder, or set "
                "TRUEVISION_MODEL_DIR in your .env."
            )

        # The directory can exist while holding only config/tokenizer files —
        # that's a trained model whose *weights* were never exported. Detect it
        # here so callers get a descriptive 503 (FileNotFoundError is mapped to
        # 503 upstream) instead of an opaque OSError 500 from from_pretrained().
        if not settings.model_weights_exist:
            raise FileNotFoundError(
                f"DistilBERT weights missing in {settings.model_dir}. Found no "
                "model.safetensors / pytorch_model.bin — only config/tokenizer "
                "files are present, so the trained weights were never exported. "
                "Re-export them from your training notebook with "
                "`model.save_pretrained('truevision_model')` and copy "
                "model.safetensors (plus special_tokens_map.json and vocab.txt) "
                "into this folder. Classification stays disabled until then; "
                "transcription is unaffected."
            )

        # Imported lazily so that simply importing this module (e.g. for
        # tests) doesn't drag in PyTorch.
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        logger.info("Loading DistilBERT from %s ...", settings.model_dir)
        _tokenizer = AutoTokenizer.from_pretrained(settings.model_dir)
        _model = AutoModelForSequenceClassification.from_pretrained(settings.model_dir)

        _device = "cuda" if torch.cuda.is_available() else "cpu"
        _model.to(_device).eval()

        # Resolve labels (env override > config.json > hard-coded default).
        cfg_map = getattr(_model.config, "id2label", None) or {}
        _id2label = _resolve_labels(cfg_map)

        # Sanity check: label count should match the model's output head.
        num_classes = getattr(_model.config, "num_labels", None) or len(_id2label)
        if len(_id2label) != num_classes:
            logger.warning(
                "Label count mismatch: %d labels vs %d output classes. "
                "Update TRUEVISION_LABELS in .env to match the model.",
                len(_id2label), num_classes,
            )

        logger.info("DistilBERT ready on %s | labels=%s", _device, _id2label)


def is_ready() -> bool:
    """True once the model is resident in memory. Read-only probe used by
    /health — does not trigger a load."""
    return _model is not None


def predict(text: str) -> Dict:
    """Run a single inference call. Returns the schema /predict expects."""
    load()  # cheap no-op once warm

    # PyTorch is imported here too so the function works without a global
    # import (helps when running with --reload).
    import torch

    cleaned = (text or "").strip()
    if not cleaned:
        return {
            "category": "Entertainment",
            "confidence": 0.0,
            "all_scores": {label: 0.0 for label in _id2label.values()},
        }

    enc = _tokenizer(
        cleaned,
        return_tensors="pt",
        truncation=True,
        max_length=256,
        padding=True,
    ).to(_device)

    with torch.no_grad():
        logits = _model(**enc).logits[0]
        probs = torch.softmax(logits, dim=-1).cpu().tolist()

    top = max(range(len(probs)), key=lambda i: probs[i])
    return {
        "category": _id2label.get(top, str(top)),
        "confidence": float(probs[top]),
        "all_scores": {_id2label.get(i, str(i)): float(probs[i]) for i in range(len(probs))},
    }
