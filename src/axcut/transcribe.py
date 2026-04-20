from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from faster_whisper import WhisperModel
from huggingface_hub import snapshot_download

from axcut.models import Segment, Transcript, WordToken


MODEL_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}


def probe_duration(video_path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(video_path),
    ]
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    return float(payload["format"]["duration"])


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

        segments.append(
            Segment(
                id=segment_id,
                start=float(words[0].start),
                end=float(words[-1].end),
                text=" ".join(word.text for word in words).strip(),
                words=words,
            )
        )
        segment_counter += 1

    if not segments:
        raise RuntimeError("No words were produced by Whisper.")

    duration = probe_duration(video_path)
    language = info.language or "unknown"
    return Transcript(
        source_video=video_path.name,
        duration=duration,
        language=language,
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

    snapshot_path = snapshot_download(
        repo_id=repo_id,
        local_dir=str(target_dir),
    )
    return snapshot_path
