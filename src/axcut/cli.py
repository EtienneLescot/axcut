from __future__ import annotations

import argparse
import json
import os
import re
import warnings
from pathlib import Path

from dotenv import load_dotenv

from axcut.dsl import read_transcript, write_transcript
from axcut.edit_agent import CleanedTranscriptValidationError, TranscriptRewriteAgent
from axcut.models import EditPlan, Transcript
from axcut.render import (
    compute_keep_intervals_from_cleaned,
    render_cut_video,
    write_keep_intervals,
)
from axcut.transcribe import transcribe_video


def main() -> None:
    warnings.filterwarnings(
        "ignore",
        message=r"Pydantic serializer warnings:.*",
        category=UserWarning,
    )
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(prog="axcut")
    subparsers = parser.add_subparsers(dest="command", required=True)

    transcribe_parser = subparsers.add_parser("transcribe")
    transcribe_parser.add_argument("--video", required=True)
    transcribe_parser.add_argument("--model", default="medium")
    transcribe_parser.add_argument("--language", required=False)
    transcribe_parser.add_argument("--output", required=False)

    edit_parser = subparsers.add_parser("edit")
    edit_parser.add_argument("--transcript", required=True)
    edit_parser.add_argument("--edit-prompt", required=False)
    edit_parser.add_argument("--output-plan", required=False)
    edit_parser.add_argument("--output-cleaned", required=False)
    edit_parser.add_argument("--llm-model", default="gpt-5.4")

    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("--video", required=True)
    render_parser.add_argument("--transcript", required=True)
    render_parser.add_argument("--cleaned", required=False)
    render_parser.add_argument("--plan", required=False)
    render_parser.add_argument("--intervals-output", required=False)
    render_parser.add_argument("--output-video", required=True)

    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--video", required=True)
    run_parser.add_argument("--edit-prompt", required=False)
    run_parser.add_argument("--whisper-model", default="medium")
    run_parser.add_argument("--language", required=False)
    run_parser.add_argument("--llm-model", default="gpt-5.4")

    args = parser.parse_args()

    if args.command == "transcribe":
        video_path = Path(args.video)
        output = (
            Path(args.output)
            if args.output
            else _artifact_dir(video_path) / "01_transcript.axcut"
        )
        transcript = transcribe_video(
            video_path, model_name=args.model, language=args.language
        )
        write_transcript(output, transcript)
        print(output)
        return

    if args.command == "edit":
        transcript_path = Path(args.transcript)
        transcript = read_transcript(transcript_path)
        plan_path = (
            Path(args.output_plan)
            if args.output_plan
            else transcript_path.parent / "02_edit_plan.json"
        )
        cleaned_path = (
            Path(args.output_cleaned)
            if args.output_cleaned
            else transcript_path.parent / "03_cleaned.axcut"
        )
        review_path = transcript_path.parent / "02_edit_plan.review.json"
        edit_prompt = _resolve_edit_prompt(args.edit_prompt, parser)
        agent = TranscriptRewriteAgent(model=args.llm_model)
        try:
            cleaned = agent.run(transcript, edit_prompt)
            _write_plan(plan_path, _build_manifest_plan(transcript, cleaned))
            write_transcript(cleaned_path, cleaned)
            _write_plan_review(review_path, validated=True, issues=[])
            print(plan_path)
            print(cleaned_path)
            return
        except CleanedTranscriptValidationError as exc:
            if exc.best_transcript is not None:
                _write_plan(
                    plan_path, _build_manifest_plan(transcript, exc.best_transcript)
                )
                write_transcript(cleaned_path, exc.best_transcript)
                _write_plan_review(review_path, validated=False, issues=exc.issues)
                print(plan_path)
                print(cleaned_path)
            raise

    if args.command == "render":
        transcript_path = Path(args.transcript)
        transcript = read_transcript(transcript_path)
        cleaned_path = (
            Path(args.cleaned)
            if args.cleaned
            else transcript_path.parent / "03_cleaned.axcut"
        )
        if not cleaned_path.exists():
            parser.error(
                "Missing cleaned transcript. Pass --cleaned or generate 03_cleaned.axcut first."
            )
        cleaned = read_transcript(cleaned_path)
        intervals = compute_keep_intervals_from_cleaned(transcript, cleaned)
        intervals_path = (
            Path(args.intervals_output)
            if args.intervals_output
            else transcript_path.parent / "04_keep_intervals.json"
        )
        output_video = Path(args.output_video)
        write_keep_intervals(intervals_path, intervals)
        render_cut_video(Path(args.video), output_video, intervals)
        print(intervals_path)
        print(output_video)
        return

    if args.command == "run":
        video_path = Path(args.video)
        edit_prompt = _resolve_edit_prompt(args.edit_prompt, parser)
        artifact_dir = _artifact_dir(video_path)
        transcript_path = artifact_dir / "01_transcript.axcut"
        plan_path = artifact_dir / "02_edit_plan.json"
        cleaned_path = artifact_dir / "03_cleaned.axcut"
        intervals_path = artifact_dir / "04_keep_intervals.json"
        output_video = artifact_dir / "05_cut.mp4"

        transcript = transcribe_video(
            video_path, model_name=args.whisper_model, language=args.language
        )
        write_transcript(transcript_path, transcript)

        agent = TranscriptRewriteAgent(model=args.llm_model)
        cleaned = agent.run(transcript, edit_prompt)
        _write_plan(plan_path, _build_manifest_plan(transcript, cleaned))
        write_transcript(cleaned_path, cleaned)

        intervals = compute_keep_intervals_from_cleaned(transcript, cleaned)
        write_keep_intervals(intervals_path, intervals)
        render_cut_video(video_path, output_video, intervals)

        print(transcript_path)
        print(plan_path)
        print(cleaned_path)
        print(intervals_path)
        print(output_video)
        return


def _artifact_dir(video_path: Path) -> Path:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", video_path.stem).strip("-").lower()
    artifact_dir = Path("artifacts") / slug
    artifact_dir.mkdir(parents=True, exist_ok=True)
    return artifact_dir


def _write_plan(path: Path, plan: EditPlan) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(plan.model_dump(), indent=2, ensure_ascii=False), encoding="utf-8"
    )


def _write_plan_review(path: Path, *, validated: bool, issues: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"validated": validated, "issues": issues}, indent=2, ensure_ascii=False
        ),
        encoding="utf-8",
    )


def _build_manifest_plan(source: Transcript, cleaned: Transcript) -> EditPlan:
    source_word_count = len(source.all_words())
    cleaned_word_count = len(cleaned.all_words())
    removed_word_count = source_word_count - cleaned_word_count
    return EditPlan(
        summary=(
            f"Cleaned transcript generated by direct AXCUT rewrite. "
            f"Kept {cleaned_word_count}/{source_word_count} words across {len(cleaned.segments)} segments; "
            f"removed {removed_word_count} words."
        ),
        drop_silence_gaps_over_ms=0,
        delete_ranges=[],
        follow_up_questions=[],
        suggestions=[],
    )


def _resolve_edit_prompt(cli_value: str | None, parser: argparse.ArgumentParser) -> str:
    prompt = cli_value or os.getenv("AXCUT_EDIT_PROMPT")
    if not prompt:
        parser.error(
            "Missing edit prompt. Pass --edit-prompt or set AXCUT_EDIT_PROMPT in .env."
        )
    return prompt


if __name__ == "__main__":
    main()
