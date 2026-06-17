from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from axcut_core.models import KeepInterval, Transcript


def compute_keep_intervals_from_cleaned(
    source: Transcript, cleaned: Transcript
) -> list[KeepInterval]:
    if source.source_video != cleaned.source_video:
        raise RuntimeError(
            "Source and cleaned transcripts do not refer to the same video."
        )

    source_word_ids = {word.id for word in source.all_words()}
    intervals: list[KeepInterval] = []
    current_start: float | None = None
    current_end: float | None = None
    for index, segment in enumerate(cleaned.segments):
        if segment.kind == "silence":
            if current_start is None:
                current_start = segment.start
            current_end = segment.end
            continue
        if any(word.id not in source_word_ids for word in segment.words):
            raise RuntimeError(
                f"Cleaned segment {segment.id} contains unknown word ids."
            )
        if current_start is None:
            current_start = segment.words[0].start
        current_end = segment.words[-1].end
        next_segment = (
            cleaned.segments[index + 1] if index + 1 < len(cleaned.segments) else None
        )
        if next_segment is None or next_segment.kind == "speech":
            intervals.append(KeepInterval(start=current_start, end=current_end))
            current_start = None
            current_end = None
    if current_start is not None and current_end is not None:
        intervals.append(KeepInterval(start=current_start, end=current_end))
    return _merge_intervals(intervals)


def _merge_intervals(intervals: list[KeepInterval]) -> list[KeepInterval]:
    if not intervals:
        return []
    merged = [intervals[0]]
    for item in intervals[1:]:
        last = merged[-1]
        if item.start <= last.end:
            last.end = max(last.end, item.end)
        else:
            merged.append(item)
    return merged


def read_keep_intervals(path: Path) -> list[KeepInterval]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [KeepInterval(**item) for item in payload]


def write_keep_intervals(path: Path, intervals: list[KeepInterval]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([item.model_dump() for item in intervals], indent=2),
        encoding="utf-8",
    )


def create_proxy_video(video_path: Path, output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        "scale='min(1280,iw)':-2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-g",
        "24",
        "-keyint_min",
        "24",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
    subprocess.run(cmd, check=True)
    return output_path


def render_cut_video(
    video_path: Path, output_path: Path, intervals: list[KeepInterval]
) -> None:
    if not intervals:
        raise RuntimeError(
            "No keep intervals available. The cleaned transcript removed everything."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        dir=output_path.parent, prefix=".axcut-render-"
    ) as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        clip_paths: list[Path] = []

        for index, item in enumerate(intervals):
            clip_path = temp_dir / f"clip_{index:03d}.mp4"
            clip_paths.append(clip_path)
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                f"{item.start:.3f}",
                "-to",
                f"{item.end:.3f}",
                "-i",
                str(video_path),
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(clip_path),
            ]
            subprocess.run(cmd, check=True)

        concat_manifest = temp_dir / "concat.txt"
        concat_manifest.write_text(
            "\n".join(f"file '{clip_path.name}'" for clip_path in clip_paths) + "\n",
            encoding="utf-8",
        )

        temp_output = temp_dir / "assembled.mp4"
        concat_cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_manifest),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(temp_output),
        ]
        subprocess.run(concat_cmd, check=True, cwd=temp_dir)
        shutil.move(temp_output, output_path)


def render_clip_sequence(
    clips: list[dict[str, object]], output_path: Path
) -> None:
    if not clips:
        raise RuntimeError("No timeline clips available for export.")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(
        dir=output_path.parent, prefix=".axcut-render-"
    ) as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        clip_paths: list[Path] = []

        for index, item in enumerate(clips):
            source_path = Path(str(item["path"]))
            clip_path = temp_dir / f"clip_{index:03d}.mp4"
            clip_paths.append(clip_path)
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                f"{float(item['start']):.3f}",
                "-to",
                f"{float(item['end']):.3f}",
                "-i",
                str(source_path),
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(clip_path),
            ]
            subprocess.run(cmd, check=True)

        concat_manifest = temp_dir / "concat.txt"
        concat_manifest.write_text(
            "\n".join(f"file '{clip_path.name}'" for clip_path in clip_paths) + "\n",
            encoding="utf-8",
        )

        temp_output = temp_dir / "assembled.mp4"
        concat_cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_manifest),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(temp_output),
        ]
        subprocess.run(concat_cmd, check=True, cwd=temp_dir)
        shutil.move(temp_output, output_path)
