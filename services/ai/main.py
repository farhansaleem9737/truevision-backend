"""FastAPI entry point for the TrueVision AI microservice.

Run from the repo root:

    uvicorn Backend.services.ai.main:app --host 0.0.0.0 --port 8001 --reload

or from inside this folder:

    uvicorn main:app --host 0.0.0.0 --port 8001 --reload

Endpoints:
  GET  /health     — liveness probe
  POST /predict    — zero-shot category classifier (facebook/bart-large-mnli)
  POST /recommend  — educational-first ranking
  POST /moderate   — NudeNet NSFW detection
  POST /chatbot    — sentence-transformers FAQ retrieval
  POST /transcribe — FFmpeg → Whisper → BART speech-to-classification
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
from fastapi import (
    Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

# Absolute imports — uvicorn is launched from inside this folder and adds it
# to sys.path, so the sibling modules resolve as top-level. This avoids the
# "attempted relative import with no known parent package" error that
# relative imports would cause when main.py is loaded as a script.
import chatbot
import classifier
import ffmpeg_utils
import moderator
import recommender
import whisper
from config import settings
from schemas import (
    ChatRequest,
    ChatResponse,
    ModerateRequest,
    ModerateResponse,
    PredictRequest,
    PredictResponse,
    RecommendRequest,
    RecommendResponse,
    TranscribeResponse,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("truevision.ai")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Warm up the BART zero-shot classifier + Faster-Whisper on startup so the
    first request isn't cold, and so each model is loaded exactly ONCE per
    process and reused for every request. NudeNet, sentence-transformers and the
    recommender stay lazy — they pay their load cost on first hit."""
    try:
        await run_in_threadpool(classifier.load)
        logger.info("BART zero-shot classifier pre-warmed (%s).", settings.bart_model)
    except Exception as e:  # noqa: BLE001 — download/incompat/OOM
        # Don't crash the service — /predict returns 503 and /transcribe still
        # returns the transcript with classifier_error until this recovers.
        logger.warning("BART not loaded: %s", e)

    # Whisper downloads its weights on first load; do it at startup so no user
    # request pays for it. A failure here is non-fatal — /transcribe 503s.
    try:
        await run_in_threadpool(whisper.load)
        logger.info("Faster-Whisper pre-warmed (%s).", settings.whisper_model)
    except Exception as e:  # noqa: BLE001
        logger.warning("Faster-Whisper not loaded: %s", e)

    if not ffmpeg_utils.ffmpeg_available():
        logger.warning("FFmpeg not on PATH — /transcribe will return 503.")

    # Pre-warm NudeNet so the moderation stage is hot from the first upload and
    # /health reports nudenet_loaded. This calls moderator's existing lazy
    # loader — NudeNet's own module is unchanged. Non-fatal: /moderate degrades
    # to SAFE on any error regardless.
    try:
        await run_in_threadpool(moderator._get_detector)
        logger.info("NudeNet pre-warmed.")
    except Exception as e:  # noqa: BLE001
        logger.warning("NudeNet not loaded: %s", e)

    yield
    logger.info("Shutdown complete.")


app = FastAPI(
    title="TrueVision AI Service",
    version="1.0.0",
    description="BART zero-shot classifier + NudeNet moderation + Whisper transcription + FAQ chatbot + recommender.",
    lifespan=lifespan,
)


# ── CORS ────────────────────────────────────────────────────────────────────
# Node calls FastAPI server-to-server (no CORS needed there) but we still
# enable it so a dev can hit the API from a browser-based tool if they want.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)


# ── Optional shared-secret auth ─────────────────────────────────────────────
async def require_api_key(request: Request):
    """Require X-API-Key header when AI_API_KEY is set in .env.
    Disabled when the env var is empty (dev default)."""
    if not settings.api_key:
        return
    if request.headers.get("X-API-Key") != settings.api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing X-API-Key",
        )


# ── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health", tags=["meta"])
def health():
    # NudeNet is lazy by design (loads on first /moderate) — we read its
    # detector singleton without importing/loading it, so this reflects real
    # state without changing NudeNet's behaviour.
    nudenet_loaded = getattr(moderator, "_detector", None) is not None
    return {
        "status": "ok",
        # ── Pipeline model readiness ──
        "whisper_loaded": whisper.is_ready(),
        "bart_loaded": classifier.is_ready(),
        "nudenet_loaded": nudenet_loaded,
        # ── Detail ──
        "bart_model": settings.bart_model,
        "candidate_labels": settings.zero_shot_labels,
        "whisper_model": settings.whisper_model,
        "ffmpeg_available": ffmpeg_utils.ffmpeg_available(),
        "ffmpeg_version": ffmpeg_utils.ffmpeg_version(),
    }


@app.post("/predict", response_model=PredictResponse, dependencies=[Depends(require_api_key)])
async def predict(req: PredictRequest) -> PredictResponse:
    try:
        # Inference is CPU-bound — push it to a worker thread.
        result = await run_in_threadpool(classifier.predict, req.text)
        return PredictResponse(**result)
    except classifier.ClassifierLoadError as e:
        # Model couldn't load (download failure / OOM) → not ready.
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("/predict failed")
        raise HTTPException(status_code=500, detail=f"prediction failed: {e}")


@app.post("/recommend", response_model=RecommendResponse, dependencies=[Depends(require_api_key)])
async def recommend(req: RecommendRequest) -> RecommendResponse:
    try:
        # Pure-CPU but very fast; running inline is fine.
        return recommender.recommend(req)
    except Exception as e:  # noqa: BLE001
        logger.exception("/recommend failed")
        raise HTTPException(status_code=500, detail=f"recommendation failed: {e}")


@app.post("/moderate", response_model=ModerateResponse, dependencies=[Depends(require_api_key)])
async def moderate(req: ModerateRequest) -> ModerateResponse:
    # moderator.moderate() handles its own errors and always returns a dict.
    result = await moderator.moderate(req)
    return ModerateResponse(**result)


@app.post("/chatbot", response_model=ChatResponse, dependencies=[Depends(require_api_key)])
async def chat(req: ChatRequest) -> ChatResponse:
    try:
        result = await run_in_threadpool(chatbot.chat, req)
        return ChatResponse(**result)
    except Exception as e:  # noqa: BLE001
        logger.exception("/chatbot failed")
        raise HTTPException(status_code=500, detail=f"chat failed: {e}")


# ── /transcribe ─────────────────────────────────────────────────────────────
#
# Pipeline:  video → FFmpeg (audio.wav) → Faster-Whisper (text) → BART zero-shot
#            (category + confidence + moderation) → JSON
#
# Accepts EITHER:
#   • multipart/form-data with `file` (raw video bytes), or
#   • multipart/form-data / query with `video_url` (Cloudinary URL — the path
#     Node uses, keeping this service stateless like /moderate).
#
# Both models are already resident (loaded at startup) — nothing reloads here.

async def _download_to(path: Path, url: str) -> None:
    """Stream a remote video to disk, enforcing the size cap as we go."""
    limit = settings.max_video_mb * 1024 * 1024
    written = 0
    async with httpx.AsyncClient(follow_redirects=True) as client:
        async with client.stream("GET", url, timeout=settings.fetch_timeout) as r:
            if r.status_code != 200:
                raise HTTPException(
                    status_code=400,
                    detail=f"could not fetch video_url (HTTP {r.status_code})",
                )
            with open(path, "wb") as fh:
                async for chunk in r.aiter_bytes(1024 * 256):
                    written += len(chunk)
                    if written > limit:
                        raise HTTPException(
                            status_code=413,
                            detail=f"video exceeds {settings.max_video_mb} MB limit",
                        )
                    fh.write(chunk)
    if written == 0:
        raise HTTPException(status_code=400, detail="downloaded video is empty")


@app.post("/transcribe", response_model=TranscribeResponse, dependencies=[Depends(require_api_key)])
async def transcribe(
    file: Optional[UploadFile] = File(default=None),
    video_url: Optional[str] = Form(default=None),
    video_id: Optional[str] = Form(default=None),
) -> TranscribeResponse:
    if not file and not video_url:
        raise HTTPException(status_code=400, detail="provide either `file` or `video_url`")

    started = time.perf_counter()
    # One temp dir per request — audio.wav lives here and is removed in `finally`.
    workdir = tempfile.mkdtemp(prefix="tv_transcribe_")
    video_path = Path(workdir) / "input"
    audio_path = Path(workdir) / "audio.wav"

    try:
        # 1. Materialise the video locally.
        if file:
            limit = settings.max_video_mb * 1024 * 1024
            written = 0
            with open(video_path, "wb") as fh:
                while chunk := await file.read(1024 * 256):
                    written += len(chunk)
                    if written > limit:
                        raise HTTPException(
                            status_code=413,
                            detail=f"video exceeds {settings.max_video_mb} MB limit",
                        )
                    fh.write(chunk)
            if written == 0:
                raise HTTPException(status_code=400, detail="uploaded file is empty")
        else:
            await _download_to(video_path, video_url)

        # 2. FFmpeg: extract 16 kHz mono WAV. Blocking → threadpool.
        await run_in_threadpool(ffmpeg_utils.extract_audio, str(video_path), str(audio_path))

        # 3. Faster-Whisper: speech → text (CPU/GPU bound → threadpool).
        result = await run_in_threadpool(whisper.transcribe, str(audio_path))
        transcript = (result.get("text") or "").strip()

        # 4. Empty transcript is a valid outcome (silent / music-only video):
        #    return 200 with empty=True rather than pretending to classify it.
        if not transcript:
            return TranscribeResponse(
                transcript="",
                category=None,
                confidence=0.0,
                language=result.get("language", ""),
                language_probability=result.get("language_probability", 0.0),
                duration=result.get("duration", 0.0),
                processing_time=round(time.perf_counter() - started, 3),
                empty=True,
                video_id=video_id,
            )

        # 5. BART zero-shot classifier — fed the transcript.
        #    If the classifier is unavailable (model failed to load) we still
        #    return the transcript: Whisper's work is independently valuable and
        #    must not be discarded because of a downstream gap. /predict remains
        #    the endpoint that hard-503s in that situation.
        prediction: dict = {}
        classifier_error: Optional[str] = None
        try:
            prediction = await run_in_threadpool(classifier.predict, transcript)
        except Exception as e:  # noqa: BLE001 — model load failure, OOM, etc.
            classifier_error = str(e)
            logger.warning("Classification skipped: %s", e)

        return TranscribeResponse(
            transcript=transcript,
            category=prediction.get("category"),
            confidence=float(prediction.get("confidence", 0.0)),
            second_category=prediction.get("second_category"),
            second_confidence=float(prediction.get("second_confidence", 0.0)),
            all_scores=prediction.get("all_scores", {}),
            moderation=prediction.get("moderation"),
            moderation_reason=prediction.get("moderation_reason", ""),
            classifier_error=classifier_error,
            language=result.get("language", ""),
            language_probability=result.get("language_probability", 0.0),
            duration=result.get("duration", 0.0),
            processing_time=round(time.perf_counter() - started, 3),
            empty=False,
            video_id=video_id,
            segments=result.get("segments", []),
        )

    # ── Typed error → correct HTTP status ───────────────────────────────────
    except ffmpeg_utils.FFmpegMissingError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except ffmpeg_utils.NoAudioStreamError as e:
        # Nothing to transcribe, but the video itself is fine → not an error.
        return TranscribeResponse(
            transcript="", category=None, confidence=0.0, empty=True,
            processing_time=round(time.perf_counter() - started, 3),
            video_id=video_id,
        )
    except ffmpeg_utils.UnsupportedVideoError as e:
        raise HTTPException(status_code=415, detail=str(e))
    except ffmpeg_utils.CorruptVideoError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except whisper.WhisperLoadError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("/transcribe failed")
        raise HTTPException(status_code=500, detail=f"transcription failed: {e}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
