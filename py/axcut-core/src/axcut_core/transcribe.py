from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from faster_whisper import WhisperModel
from huggingface_hub import snapshot_download

from axcut_core.models import Segment, Transcript, WordToken

SILENCE_GAP_THRESHOLD_SEC = 0.5

MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}


def probe_duration(video_path: Path) -> float:
    payload = probe_media(video_path)
    return float(payload["durationSec"])


def probe_media(video_path: Path) -> dict[str, object]:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
        "-of",
        "json",
        str(video_path),
    ]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    video = next(
        (stream for stream in streams if stream.get("codec_type") == "video"), {}
    )
    audio = next(
        (stream for stream in streams if stream.get("codec_type") == "audio"), {}
    )
    fps = _parse_frame_rate(str(video.get("avg_frame_rate", "0/1")))
    return {
        "durationSec": float(payload["format"]["duration"]),
        "video": {
            "codec": str(video.get("codec_name", "unknown")),
            "width": int(video.get("width", 0) or 0),
            "height": int(video.get("height", 0) or 0),
            "fps": fps,
        },
        "audio": {
            "codec": str(audio.get("codec_name", "unknown")),
            "sampleRate": int(audio.get("sample_rate", 0) or 0),
            "channels": int(audio.get("channels", 0) or 0),
        },
    }


def transcribe_video(
    video_path: Path,
    *,
    model_name: str = "medium",
    device: str = "auto",
    compute_type: str = "int8",
    language: str | None = None,
) -> Transcript:
    model_source = resolve_model_source(model_name)
    model = WhisperModel(model_source, device=device, compute_type=compute_type)
    segments_iter, info = model.transcribe(
        str(video_path),
        beam_size=5,
        word_timestamps=True,
        vad_filter=False,
        language=language,
    )

    segments: list[Segment] = []
    word_counter = 1
    segment_counter = 1
    silence_counter = 1

    for item in segments_iter:
        segment_id = f"s{segment_counter:04d}"
        words: list[WordToken] = []
        for token in item.words or []:
            if token.start is None or token.end is None:
                continue
            words.append(
                WordToken(
                    id=f"w{word_counter:06d}",
                    segment_id=segment_id,
                    start=float(token.start),
                    end=float(token.end),
                    text=(token.word or "").strip(),
                )
            )
            word_counter += 1

        if not words:
            continue

        segment = Segment(
            id=segment_id,
            kind="speech",
            start=float(words[0].start),
            end=float(words[-1].end),
            text=" ".join(word.text for word in words).strip(),
            words=words,
        )
        if segments:
            gap_start = segments[-1].end
            gap_end = segment.start
            if gap_end - gap_start > SILENCE_GAP_THRESHOLD_SEC:
                segments.append(
                    Segment(
                        id=f"z{silence_counter:04d}",
                        kind="silence",
                        start=gap_start,
                        end=gap_end,
                        text="",
                        words=[],
                    )
                )
                silence_counter += 1
        segments.append(segment)
        segment_counter += 1

    if not segments:
        raise RuntimeError("No words were produced by Whisper.")

    duration = probe_duration(video_path)
    detected_language = info.language or "unknown"
    return Transcript(
        source_video=video_path.name,
        duration=duration,
        language=detected_language,
        kind="source",
        segments=segments,
    )


def resolve_model_source(model_name: str) -> str:
    model_path = Path(model_name).expanduser()
    if model_path.exists():
        return str(model_path)

    repo_id = MODEL_REPOS.get(model_name)
    if repo_id is None:
        return model_name

    cache_root = Path(
        os.getenv(
            "AXCUT_MODEL_CACHE",
            Path.home() / ".cache" / "axcut" / "models",
        )
    ).expanduser()
    target_dir = cache_root / model_name
    target_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path = snapshot_download(repo_id=repo_id, local_dir=str(target_dir))
    return snapshot_path


def _parse_frame_rate(value: str) -> float:
    if "/" not in value:
        return float(value or 0)
    numerator, denominator = value.split("/", 1)
    num = float(numerator or 0)
    den = float(denominator or 1)
    if den == 0:
        return 0.0
    return num / den
