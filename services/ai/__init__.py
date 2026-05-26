"""TrueVision AI microservice package.

Bundles four endpoints behind a single FastAPI app:
  POST /predict     — DistilBERT category classification
  POST /recommend   — educational-first ranking
  POST /moderate    — NudeNet NSFW detection
  POST /chatbot     — sentence-transformers FAQ retrieval

The Node.js Express backend proxies all traffic here; the React Native app
never talks to FastAPI directly.
"""
