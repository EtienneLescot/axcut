from __future__ import annotations

import json
import shlex
from pathlib import Path

from axcut.models import Segment, Transcript, WordToken


def _quote(value: str | None) -> str:
    return json.dumps("" if value is None else value, ensure_ascii=False)


def _parse_kv(line: str) -> dict[str, str]:
    parts = shlex.split(line, posix=True)
    data: dict[str, str] = {}
    for item in parts[1:]:
        key, value = item.split("=", 1)
        data[key] = value
    return data


def write_transcript(path: Path, transcript: Transcript) -> None:
    lines = ["AXCUT_TRANSCRIPT v1"]
    meta_bits = [
        f"source_video={_quote(transcript.source_video)}",
        f"duration={transcript.duration:.3f}",
        f"language={_quote(transcript.language)}",
        f"kind={_quote(transcript.kind)}",
    ]
    if transcript.edit_prompt:
        meta_bits.append(f"edit_prompt={_quote(transcript.edit_prompt)}")
    lines.append("META " + " ".join(meta_bits))

    for segment in transcript.segments:
        if segment.kind == "silence":
            lines.append(
                "SILENCE "
                + " ".join(
                    [
                        f"id={segment.id}",
                        f"start={segment.start:.3f}",
                        f"end={segment.end:.3f}",
                        f"duration_ms={segment.duration_ms}",
                    ]
                )
            )
            continue
        lines.append(
            "SEGMENT "
            + " ".join(
                [
                    f"id={segment.id}",
                    f"start={segment.start:.3f}",
                    f"end={segment.end:.3f}",
                    f"text={_quote(segment.text)}",
                ]
            )
        )
        for word in segment.words:
            lines.append(
                "WORD "
                + " ".join(
                    [
                        f"id={word.id}",
                        f"segment={word.segment_id}",
                        f"start={word.start:.3f}",
                        f"end={word.end:.3f}",
                        f"text={_quote(word.text)}",
                    ]
                )
            )
        lines.append("ENDSEGMENT")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_transcript(path: Path) -> Transcript:
    return read_transcript_text(path.read_text(encoding="utf-8"), origin=str(path))


def read_transcript_text(content: str, *, origin: str = "<memory>") -> Transcript:
    raw_lines = [line.strip() for line in content.splitlines() if line.strip()]
    if not raw_lines or raw_lines[0] != "AXCUT_TRANSCRIPT v1":
        raise ValueError(f"Invalid transcript DSL header in {origin}")

    meta = _parse_kv(raw_lines[1])
    segments: list[Segment] = []
    current_segment: Segment | None = None

    for line in raw_lines[2:]:
        if line.startswith("SEGMENT "):
            data = _parse_kv(line)
            current_segment = Segment(
                id=data["id"],
                kind="speech",
                start=float(data["start"]),
                end=float(data["end"]),
                text=data["text"],
                words=[],
            )
            continue

        if line.startswith("SILENCE "):
            if current_segment is not None:
                raise ValueError("SILENCE encountered inside SEGMENT block")
            data = _parse_kv(line)
            segments.append(
                Segment(
                    id=data["id"],
                    kind="silence",
                    start=float(data["start"]),
                    end=float(data["end"]),
                    text="",
                    words=[],
                )
            )
            continue

        if line.startswith("WORD "):
            if current_segment is None:
                raise ValueError("WORD encountered outside SEGMENT block")
            data = _parse_kv(line)
            current_segment.words.append(
                WordToken(
                    id=data["id"],
                    segment_id=data["segment"],
                    start=float(data["start"]),
                    end=float(data["end"]),
                    text=data["text"],
                )
            )
            continue

        if line == "ENDSEGMENT":
            if current_segment is None:
                raise ValueError("ENDSEGMENT encountered without SEGMENT")
            segments.append(current_segment)
            current_segment = None
            continue

        raise ValueError(f"Unsupported DSL line: {line}")

    return Transcript(
        source_video=meta["source_video"],
        duration=float(meta["duration"]),
        language=meta["language"],
        kind=meta.get("kind", "source"),
        edit_prompt=meta.get("edit_prompt"),
        segments=segments,
    )
