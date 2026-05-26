"""FastAPI entry point for the TrueVision AI microservice.

Run from the repo root:

    uvicorn Backend.services.ai.main:app --host 0.0.0.0 --port 8001 --reload

or from inside this folder:

    uvicorn main:app --host 0.0.0.0 --port 8001 --reload

Endpoints:
  GET  /health     — liveness probe
  POST /predict    — DistilBERT category classifier
  POST /recommend  — educational-first ranking
  POST /moderate   — NudeNet NSFW detection
  POST /chatbot    — sentence-transformers FAQ retrieval
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware

# Absolute imports — uvicorn is launched from inside this folder and adds it
# to sys.path, so the sibling modules resolve as top-level. This avoids the
# "attempted relative import with no known parent package" error that
# relative imports would cause when main.py is loaded as a script.
import chatbot
import classifier
import moderator
import recommender
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
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("truevision.ai")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Warm up the DistilBERT model on startup so the first /predict call
    isn't cold. NudeNet, sentence-transformers and the recommender stay
    lazy — they only pay their load cost when their endpoint is first hit."""
    try:
        await run_in_threadpool(classifier.load)
        logger.info("DistilBERT pre-warmed.")
    except FileNotFoundError as e:
        # Don't crash the service if the model dir is missing — /predict
        # will return 503 until the user drops the files in.
        logger.warning("DistilBERT not loaded: %s", e)
    yield
    logger.info("Shutdown complete.")


app = FastAPI(
    title="TrueVision AI Service",
    version="1.0.0",
    description="DistilBERT classifier + NudeNet moderation + FAQ chatbot + recommender.",
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
    return {
        "status": "ok",
        "model_dir_present": settings.model_dir_exists,
        "model_dir": settings.model_dir,
    }


@app.post("/predict", response_model=PredictResponse, dependencies=[Depends(require_api_key)])
async def predict(req: PredictRequest) -> PredictResponse:
    try:
        # Inference is CPU-bound — push it to a worker thread.
        result = await run_in_threadpool(classifier.predict, req.text)
        return PredictResponse(**result)
    except FileNotFoundError as e:
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
