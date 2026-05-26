"""NSFW moderation using the `nudenet` Python package.

For images: pass `image_url`.
For videos: pass `image_urls` containing pre-extracted frame URLs. Cloudinary
(the upload host the rest of the app uses) exposes frame thumbnails as JPEGs
via URL transforms — the Node side builds those URLs and POSTs the list
here, so this service stays stateless and doesn't need ffmpeg.

Failure policy (matches the spec): on any error → return SAFE with
`fallback=True`. Uploads must never be blocked by a moderation outage.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import threading
from typing import Dict, List

import httpx

from config import settings
from schemas import ModerateRequest

logger = logging.getLogger(__name__)

# NudeNet detector — heavy first-load, then cached for the process lifetime.
_detector = None
_lock = threading.Lock()


# Severity buckets (kept in sync with the Node-side service).
PORN_LABELS = {
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_EXPOSED",
}
NSFW_LABELS = {
    "FEMALE_BREAST_EXPOSED",
    "BUTTOCKS_EXPOSED",
}

# Below this score the detection is discarded as noise.
DETECTION_THRESHOLD = float(os.environ.get("NUDENET_THRESHOLD", "0.30"))


def _get_detector():
    """Lazy-init the NudeDetector singleton."""
    global _detector
    if _detector is not None:
        return _detector
    with _lock:
        if _detector is not None:
            return _detector
        from nudenet import NudeDetector  # local import — heavy
        logger.info("Initializing NudeNet detector ...")
        _detector = NudeDetector()
        logger.info("NudeNet ready.")
        return _detector


def _safe_fallback(reason: str) -> Dict:
    return {
        "status": "SAFE",
        "confidence": 0.0,
        "detections": [],
        "fallback": True,
    }


def _classify_detections(detections: List[Dict]) -> Dict:
    """Map a list of NudeNet detections into our SAFE/NSFW/PORN bucket."""
    worst_status, worst_score = "SAFE", 0.0
    detail: List[Dict] = []

    for d in detections:
        label = d.get("class", "")
        score = float(d.get("score", 0))
        if score < DETECTION_THRESHOLD:
            continue
        detail.append({"label": label, "score": score})
        if label in PORN_LABELS and (worst_status != "PORN" or score > worst_score):
            worst_status, worst_score = "PORN", score
        elif label in NSFW_LABELS and worst_status != "PORN" and score > worst_score:
            worst_status, worst_score = "NSFW", score

    if worst_status == "SAFE":
        # Confidence = "how confidently safe" — peak detection inverted.
        max_any = max((d["score"] for d in detail), default=0.0)
        return {
            "status": "SAFE",
            "confidence": max(0.0, 1.0 - max_any),
            "detections": detail,
            "fallback": False,
        }
    return {
        "status": worst_status,
        "confidence": worst_score,
        "detections": detail,
        "fallback": False,
    }


async def _classify_url(client: httpx.AsyncClient, url: str) -> Dict:
    """Download one image and run NudeNet on it. Always returns a dict
    (never raises) so the caller can aggregate without try/except."""
    try:
        r = await client.get(url, timeout=settings.fetch_timeout)
        r.raise_for_status()
        # NudeDetector.detect() wants a file path. Write the bytes to a temp
        # file, run inference, then delete it.
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as fh:
            fh.write(r.content)
            tmp_path = fh.name
        try:
            # Inference is CPU-bound — run it in a worker thread so we
            # don't block the event loop.
            detections = await asyncio.to_thread(_get_detector().detect, tmp_path)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return _classify_detections(detections or [])
    except Exception as exc:  # noqa: BLE001 — log and degrade gracefully
        logger.warning("moderate fetch/classify failed for %s: %s", url, exc)
        return _safe_fallback(str(exc))


async def moderate(req: ModerateRequest) -> Dict:
    """Public entrypoint. Handles single image or multi-frame video."""
    urls: List[str] = []
    if req.image_urls:
        urls.extend(req.image_urls)
    if req.image_url:
        urls.append(req.image_url)

    if not urls:
        return _safe_fallback("missing_url")

    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(
            *[_classify_url(client, u) for u in urls],
            return_exceptions=False,
        )

    # Worst-frame-wins aggregation. PORN > NSFW > SAFE.
    rank = {"SAFE": 0, "NSFW": 1, "PORN": 2}
    worst = results[0]
    for r in results[1:]:
        if rank[r["status"]] > rank[worst["status"]]:
            worst = r
        elif r["status"] == worst["status"] and r["confidence"] > worst["confidence"]:
            worst = r

    # If every frame fell back, surface that on the aggregate.
    if all(r.get("fallback") for r in results):
        worst["fallback"] = True
    return worst
