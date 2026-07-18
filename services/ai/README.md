# TrueVision AI Service

A lightweight FastAPI microservice that hosts the four AI endpoints the
React Native app needs. It runs alongside the existing Node.js/Express
backend — Node proxies requests through to FastAPI; the React Native client
only ever talks to Node.

```
React Native  →  Node /api/ai/*  →  FastAPI :8001  →  models (local)
```

## Endpoints

| Verb | Path        | What it does                                                    |
|------|-------------|-----------------------------------------------------------------|
| GET  | `/health`   | Liveness probe + reports whisper_loaded / bart_loaded / nudenet_loaded |
| POST | `/predict`  | Zero-shot classifies text into Educational / Technical / Professional / News / Entertainment / Islamic / Poetry (facebook/bart-large-mnli) |
| POST | `/transcribe`| FFmpeg → Whisper → BART: video/audio → transcript + category + moderation |
| POST | `/recommend`| Re-ranks a batch of candidate videos with an educational-first bias |
| POST | `/moderate` | Runs NudeNet over one image URL or a list of frame URLs         |
| POST | `/chatbot`  | FAQ retrieval over a curated knowledge base                      |

## Folder layout

```
Backend/
└── services/
    ├── ai/                      ← this microservice
    │   ├── __init__.py
    │   ├── main.py              ← FastAPI app + routes
    │   ├── config.py            ← env-driven settings
    │   ├── schemas.py           ← Pydantic request/response models
    │   ├── classifier.py        ← /predict — BART zero-shot (facebook/bart-large-mnli)
    │   ├── whisper.py           ← /transcribe — Faster-Whisper speech-to-text
    │   ├── ffmpeg_utils.py      ← /transcribe — audio extraction
    │   ├── moderator.py         ← /moderate — NudeNet
    │   ├── recommender.py       ← /recommend — heuristic scorer
    │   ├── chatbot.py           ← /chatbot — FAQ retrieval
    │   ├── data/
    │   │   └── faqs.json        ← edit this to add/remove FAQ entries
    │   ├── requirements.txt
    │   ├── .env.example
    │   ├── start.ps1            ← Windows launcher
    │   ├── start.sh             ← macOS/Linux launcher
    │   └── README.md            ← this file
    └── aiClient.js              ← Node-side HTTP wrapper (talks to FastAPI)
```

## Installation

**Prerequisites**: Python 3.10+, Node.js 18+, and FFmpeg on PATH (for `/transcribe`).

**1. Models download automatically.** The BART zero-shot classifier
(`facebook/bart-large-mnli`, ~1.6 GB) and the Whisper `base` model (~140 MB)
are fetched to the HuggingFace cache on first run and reused offline afterwards
— nothing to drop in manually.

**2. Create the env file** (optional — defaults work for local dev):

```powershell
cd Backend\services\ai
copy .env.example .env
# edit .env if you want to set AI_API_KEY or override paths
```

**3. Start the service**:

```powershell
# Windows
cd Backend\services\ai
.\start.ps1
```

```bash
# macOS / Linux / WSL
cd Backend/services/ai
chmod +x start.sh
./start.sh
```

The launchers create a `.venv`, install requirements, and start uvicorn on
`http://localhost:8001` with auto-reload.

**4. Tell Node where FastAPI lives.** Add to `Backend/.env`:

```
AI_SERVICE_URL=http://localhost:8001
AI_API_KEY=
```

Then restart your Node server. The new routes mount automatically at
`/api/ai/*`.

## First-run downloads

The first time you hit each endpoint, supporting models auto-download:

| Endpoint     | What downloads                    | Approx size |
|--------------|-----------------------------------|-------------|
| `/predict`   | `facebook/bart-large-mnli` from HuggingFace | ~1.6 GB |
| `/transcribe`| Whisper `base` (+ reuses BART above) | ~140 MB  |
| `/moderate`  | NudeNet weights                   | ~80 MB      |
| `/chatbot`   | `all-MiniLM-L6-v2` from HuggingFace | ~80 MB    |
| `/recommend` | Nothing — pure heuristic          | 0           |

## Testing — curl / Postman

### `POST /predict`

```bash
curl -X POST http://localhost:8001/predict \
  -H "Content-Type: application/json" \
  -d '{"text": "Learn Python programming for data science"}'
```

Response:
```json
{
  "category": "Educational",
  "confidence": 0.94,
  "second_category": "Technical",
  "second_confidence": 0.04,
  "all_scores": { "Educational": 0.94, "Technical": 0.04, "...": 0.0 },
  "moderation": "ACCEPT",
  "moderation_reason": "accepted-category"
}
```

### `POST /moderate`

```bash
curl -X POST http://localhost:8001/moderate \
  -H "Content-Type: application/json" \
  -d '{"image_url": "https://res.cloudinary.com/.../frame.jpg"}'
```

Response:
```json
{
  "status": "SAFE",
  "confidence": 0.92,
  "detections": [],
  "fallback": false
}
```

Multi-frame video — pass a list:

```json
{
  "image_urls": [
    "https://res.cloudinary.com/.../so_1.jpg",
    "https://res.cloudinary.com/.../so_3.jpg",
    "https://res.cloudinary.com/.../so_5.jpg"
  ]
}
```

### `POST /recommend`

```bash
curl -X POST http://localhost:8001/recommend \
  -H "Content-Type: application/json" \
  -d '{
    "candidates": [
      {"video_id": "v1", "title": "Python basics", "category": "Educational", "educational_score": 0.9, "likes": 200, "views": 5000, "age_hours": 2},
      {"video_id": "v2", "title": "Cat compilation", "category": "Entertainment", "educational_score": 0.1, "likes": 5000, "views": 90000, "age_hours": 12}
    ],
    "user": {
      "interests": ["python", "machine learning"],
      "watch_history_categories": {"Educational": 12, "Professional": 4}
    }
  }'
```

### `POST /chatbot`

```bash
curl -X POST http://localhost:8001/chatbot \
  -H "Content-Type: application/json" \
  -d '{"message": "How do I upload a video?"}'
```

Response:
```json
{
  "answer": "Tap the + button in the bottom tab bar, pick a video ...",
  "matched_question": "How do I upload a video?",
  "confidence": 0.91
}
```

## Going through Node instead

For a real client (the React Native app), call the matching Node routes —
those are auth-protected and add rate limiting:

```
POST /api/ai/predict
POST /api/ai/recommend
POST /api/ai/moderate
POST /api/ai/chatbot
GET  /api/ai/health
```

Node-side wrapper: [`Backend/services/aiClient.js`](../aiClient.js).
React Native wrapper example: [`truevision/services/AiService.js`](../../../truevision/services/AiService.js).

## Upload pipeline

The end-to-end pipeline this service unlocks:

1. Client uploads video → Cloudinary direct upload (unchanged).
2. Client calls Node `POST /api/videos/create`.
3. **Node frame-samples + calls `/moderate`** → if PORN/NSFW: delete from
   Cloudinary, return 422, never persist to MongoDB.
4. **Node fires-and-forgets `/predict`** on the title+description → stores
   the returned category on the Video document.
5. **Feed endpoint calls `/recommend`** with the page of candidates + the
   viewer's interests → returns them sorted by educational-first score.

Steps 3 and 4 are wired in `Backend/controllers/VideoController.js`. Step 5
is wired in the feed endpoint of the same file. See `aiClient.js` for the
exact call shapes Node uses.

## Production notes

- **Auth**: set `AI_API_KEY` in both the FastAPI `.env` and Node `.env`.
  Without it the service is open on its port.
- **CORS**: replace `*` with explicit origins for prod.
- **Workers**: for higher throughput run uvicorn with `--workers 2` (each
  worker loads its own BART + Whisper — budget ~2.5 GB RAM per worker).
- **Don't expose FastAPI publicly**: keep it bound to `127.0.0.1` or behind
  a private network. Public traffic always goes through Node.
