"""TrueVision AI microservice package.

Bundles the endpoints behind a single FastAPI app:
  POST /predict     — zero-shot category classification (facebook/bart-large-mnli)
  POST /transcribe  — FFmpeg → Whisper → BART speech-to-classification
  POST /recommend   — educational-first ranking
  POST /moderate    — NudeNet NSFW detection
  POST /chatbot     — sentence-transformers FAQ retrieval

The Node.js Express backend proxies all traffic here; the React Native app
never talks to FastAPI directly.
"""
