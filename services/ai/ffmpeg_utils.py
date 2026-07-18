"""FFmpeg helpers for the transcription pipeline.

Responsibilities (and nothing else):
  • detect whether FFmpeg/ffprobe are on PATH
  • probe a video for duration / audio-stream presence
  • extract a Whisper-ready WAV (16 kHz mono PCM) from a video

FFmpeg is NOT bundled — it must already be installed on the host. See the
README for install instructions. Every failure mode raises a typed exception
so the FastAPI layer can map it to the right HTTP status instead of a generic
500.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)


# ── Typed errors ─────────────────────────────────────────────────────────────

class FFmpegError(RuntimeError):
    """Base class for every FFmpeg-related failure."""


class FFmpegMissingError(FFmpegError):
    """ffmpeg/ffprobe is not installed or not on PATH."""


class UnsupportedVideoError(FFmpegError):
    """The container/codec could not be read by ffprobe."""


class CorruptVideoError(FFmpegError):
    """ffmpeg failed while decoding — file is truncated/corrupted."""


class NoAudioStreamError(FFmpegError):
    """The video is valid but carries no audio track (nothing to transcribe)."""


# ── Binary discovery (cached — PATH doesn't change at runtime) ───────────────

_ffmpeg_bin: str | None = None
_ffprobe_bin: str | None = None
_checked = False


def _discover() -> None:
    global _ffmpeg_bin, _ffprobe_bin, _checked
    if _checked:
        return
    _ffmpeg_bin = settings.ffmpeg_path or shutil.which("ffmpeg")
    _ffprobe_bin = settings.ffprobe_path or shutil.which("ffprobe")
    _checked = True
    if _ffmpeg_bin:
        logger.info("FFmpeg found: %s", _ffmpeg_bin)
    else:
        logger.warning("FFmpeg NOT found on PATH — /transcribe will return 503.")


def ffmpeg_available() -> bool:
    _discover()
    return bool(_ffmpeg_bin)


def ffmpeg_version() -> str | None:
    """First line of `ffmpeg -version`, or None when unavailable."""
    _discover()
    if not _ffmpeg_bin:
        return None
    try:
        out = subprocess.run(
            [_ffmpeg_bin, "-version"],
            capture_output=True, text=True, timeout=10, check=True,
        )
        return out.stdout.splitlines()[0] if out.stdout else None
    except Exception:  # noqa: BLE001
        return None


def _require_ffmpeg() -> str:
    _discover()
    if not _ffmpeg_bin:
        raise FFmpegMissingError(
            "FFmpeg is not installed or not on PATH. Install it "
            "(Windows: `winget install Gyan.FFmpeg`, macOS: `brew install ffmpeg`, "
            "Debian/Ubuntu: `sudo apt install ffmpeg`) or set FFMPEG_PATH in the "
            "AI service .env."
        )
    return _ffmpeg_bin


# ── Probe ────────────────────────────────────────────────────────────────────

def probe(video_path: str | Path) -> dict:
    """Return {duration, has_audio, format}. Raises UnsupportedVideoError when
    ffprobe can't parse the file (wrong format / not a video / corrupted)."""
    _discover()
    if not _ffprobe_bin:
        # ffprobe ships with ffmpeg; if it's missing treat it as FFmpeg missing.
        raise FFmpegMissingError("ffprobe not found on PATH (install FFmpeg).")

    try:
        out = subprocess.run(
            [
                _ffprobe_bin, "-v", "error",
                "-print_format", "json",
                "-show_format", "-show_streams",
                str(video_path),
            ],
            capture_output=True, text=True,
            timeout=settings.ffmpeg_timeout, check=True,
        )
        data = json.loads(out.stdout or "{}")
    except subprocess.CalledProcessError as e:
        raise UnsupportedVideoError(
            f"Could not read the file as a video: {(e.stderr or '').strip()[:300]}"
        ) from e
    except subprocess.TimeoutExpired as e:
        raise CorruptVideoError("ffprobe timed out — file may be corrupted.") from e
    except json.JSONDecodeError as e:
        raise UnsupportedVideoError("ffprobe returned unreadable output.") from e

    streams = data.get("streams") or []
    if not streams:
        raise UnsupportedVideoError("No media streams found in the file.")

    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    duration = 0.0
    try:
        duration = float((data.get("format") or {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0

    return {
        "duration": duration,
        "has_audio": has_audio,
        "format": (data.get("format") or {}).get("format_name", ""),
    }


# ── Audio extraction ─────────────────────────────────────────────────────────

def extract_audio(video_path: str | Path, out_path: str | Path) -> str:
    """Extract a Whisper-ready WAV from `video_path` → `out_path` (audio.wav).

    Output format is exactly what Whisper wants natively, so faster-whisper
    does no resampling of its own:
        PCM signed 16-bit LE · 16 kHz · mono

    Raises NoAudioStreamError / CorruptVideoError / UnsupportedVideoError /
    FFmpegMissingError.
    """
    ffmpeg = _require_ffmpeg()

    info = probe(video_path)
    if not info["has_audio"]:
        raise NoAudioStreamError("This video has no audio track to transcribe.")

    cmd = [
        ffmpeg,
        "-nostdin",
        "-y",                    # overwrite
        "-i", str(video_path),
        "-vn",                   # drop video
        "-acodec", "pcm_s16le",  # uncompressed PCM
        "-ar", "16000",          # 16 kHz — Whisper's native rate
        "-ac", "1",              # mono
    ]
    # Optional hard cap so a pathological upload can't tie up a worker.
    if settings.whisper_max_audio_seconds > 0:
        cmd += ["-t", str(settings.whisper_max_audio_seconds)]
    cmd.append(str(out_path))

    try:
        subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=settings.ffmpeg_timeout, check=True,
        )
    except subprocess.CalledProcessError as e:
        raise CorruptVideoError(
            f"FFmpeg could not decode the video: {(e.stderr or '').strip()[:300]}"
        ) from e
    except subprocess.TimeoutExpired as e:
        raise CorruptVideoError("FFmpeg timed out extracting audio.") from e

    out = Path(out_path)
    if not out.exists() or out.stat().st_size == 0:
        raise NoAudioStreamError("Audio extraction produced an empty file.")

    return str(out)
