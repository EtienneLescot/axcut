from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

from dotenv import load_dotenv

from axcut_core.dsl import read_transcript, write_transcript
from axcut_core.edit_agent import (
    CleanedTranscriptValidationError,
    TranscriptRewriteAgent,
)
from axcut_core.models import EditPlan, KeepInterval, Transcript
from axcut_core.render import (
    compute_keep_intervals_from_cleaned,
    create_proxy_video,
    read_keep_intervals,
    render_cut_video,
    write_keep_intervals,
)
from axcut_core.transcribe import probe_media, transcribe_video


def main() -> None:
    warnings.filterwarnings(
        "ignore",
        message=r"Pydantic serializer warnings:.*",
        category=UserWarning,
    )
    load_dotenv(override=True)

    parser = argparse.ArgumentParser(prog="axcut-worker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    probe_parser = subparsers.add_parser("probe")
    probe_parser.add_argument("--video", required=True)

    proxy_parser = subparsers.add_parser("proxy")
    proxy_parser.add_argument("--video", required=True)
    proxy_parser.add_argument("--output", required=True)

    transcribe_parser = subparsers.add_parser("transcribe")
    transcribe_parser.add_argument("--video", required=True)
    transcribe_parser.add_argument("--asset-id", required=True)
    transcribe_parser.add_argument("--dsl-output", required=True)
    transcribe_parser.add_argument("--json-output", required=True)
    transcribe_parser.add_argument("--model", default="medium")
    transcribe_parser.add_argument("--language", required=False)

    plan_parser = subparsers.add_parser("plan-prompt")
    plan_parser.add_argument("--transcript", required=True)
    plan_parser.add_argument("--prompt", required=True)
    plan_parser.add_argument("--cleaned-output", required=True)
    plan_parser.add_argument("--plan-output", required=True)
    plan_parser.add_argument("--intervals-output", required=True)
    plan_parser.add_argument("--llm-model", default="gpt-5.4")

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("--video", required=True)
    export_parser.add_argument("--intervals", required=True)
    export_parser.add_argument("--output", required=True)

    args = parser.parse_args()

    if args.command == "probe":
        _emit({"ok": True, "data": probe_media(Path(args.video))})
        return

    if args.command == "proxy":
        output_path = create_proxy_video(Path(args.video), Path(args.output))
        _emit({"ok": True, "data": {"outputPath": str(output_path)}})
        return

    if args.command == "transcribe":
        transcript = transcribe_video(
            Path(args.video), model_name=args.model, language=args.language
        )
        dsl_output = Path(args.dsl_output)
        json_output = Path(args.json_output)
        write_transcript(dsl_output, transcript)
        json_output.parent.mkdir(parents=True, exist_ok=True)
        json_output.write_text(
            json.dumps(
                _transcript_to_document_payload(args.asset_id, dsl_output, transcript),
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        _emit(
            {
                "ok": True,
                "data": {
                    "dslPath": str(dsl_output),
                    "jsonPath": str(json_output),
                    "transcript": _transcript_to_document_payload(
                        args.asset_id, dsl_output, transcript
                    ),
                },
            }
        )
        return

    if args.command == "plan-prompt":
        transcript = read_transcript(Path(args.transcript))
        cleaned_output = Path(args.cleaned_output)
        plan_output = Path(args.plan_output)
        intervals_output = Path(args.intervals_output)
        agent = TranscriptRewriteAgent(model=args.llm_model)
        try:
            cleaned = agent.run(transcript, args.prompt)
        except CleanedTranscriptValidationError as exc:
            if exc.best_transcript is None:
                raise
            cleaned = exc.best_transcript
        plan = _build_manifest_plan(transcript, cleaned)
        intervals = compute_keep_intervals_from_cleaned(transcript, cleaned)
        write_transcript(cleaned_output, cleaned)
        _write_json(plan_output, plan.model_dump())
        write_keep_intervals(intervals_output, intervals)
        _emit(
            {
                "ok": True,
                "data": {
                    "summary": plan.summary,
                    "cleanedPath": str(cleaned_output),
                    "planPath": str(plan_output),
                    "intervalsPath": str(intervals_output),
                    "intervals": [
                        {"startSec": interval.start, "endSec": interval.end}
                        for interval in intervals
                    ],
                },
            }
        )
        return

    if args.command == "export":
        intervals = read_keep_intervals(Path(args.intervals))
        render_cut_video(Path(args.video), Path(args.output), intervals)
        _emit({"ok": True, "data": {"outputPath": str(Path(args.output))}})
        return


def _emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _build_manifest_plan(source: Transcript, cleaned: Transcript) -> EditPlan:
    source_word_count = len(source.all_words())
    cleaned_word_count = len(cleaned.all_words())
    removed_word_count = source_word_count - cleaned_word_count
    return EditPlan(
        summary=(
            "Cut plan generated from transcript rewrite. "
            f"Kept {cleaned_word_count}/{source_word_count} words across {len(cleaned.segments)} segments; "
            f"removed {removed_word_count} words."
        ),
        drop_silence_gaps_over_ms=0,
        delete_ranges=[],
        follow_up_questions=[],
        suggestions=[],
    )


def _transcript_to_document_payload(
    asset_id: str, dsl_output: Path, transcript: Transcript
) -> dict[str, object]:
    words = []
    segments = []
    for segment in transcript.segments:
        word_ids = []
        for word in segment.words:
            words.append(
                {
                    "id": word.id,
                    "segmentId": word.segment_id,
                    "startSec": word.start,
                    "endSec": word.end,
                    "text": word.text,
                }
            )
            word_ids.append(word.id)
        segments.append(
            {
                "id": segment.id,
                "kind": segment.kind,
                "startSec": segment.start,
                "endSec": segment.end,
                "text": segment.text,
                "wordIds": word_ids,
            }
        )
    return {
        "assetId": asset_id,
        "language": transcript.language,
        "sourceDslPath": str(dsl_output),
        "segments": segments,
        "words": words,
    }


if __name__ == "__main__":
    main()
