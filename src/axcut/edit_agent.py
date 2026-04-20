from __future__ import annotations

import os
import re
import json

from langchain.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI

from axcut.dsl import read_transcript_text
from axcut.models import Segment, Transcript


REWRITE_SYSTEM_PROMPT = """You are a senior video transcript editor.

You receive:
- a user editing request
- a source transcript in the AXCUT DSL
- structural validation feedback from previous failed attempts

Your task is to rewrite the transcript directly as a cleaned AXCUT DSL file.

Rules:
- Output only a valid AXCUT DSL file. No markdown fences. No commentary.
- Keep the AXCUT_TRANSCRIPT v1 header.
- Keep the same source_video, duration, and language metadata as the source transcript.
- Set kind=\"cleaned\".
- You may omit words or split/regroup segments to create the intended cut.
- Every kept WORD must come from the source transcript exactly as-is.
- Do not invent, paraphrase, rename, reorder, or retime any kept words.
- If you keep a word, preserve its id, start, end, and text exactly.
- Every kept WORD must belong to exactly one SEGMENT.
- Each SEGMENT must contain at least one WORD.
- SEGMENT text must equal the exact concatenation of its WORD texts separated by single spaces.
- SEGMENT start must equal the first kept word start.
- SEGMENT end must equal the last kept word end.
- You may create new segment ids, but they must be unique and each WORD segment field must match its containing SEGMENT id.
- If the user wants pauses removed, express that by splitting segments so unwanted gaps are not inside a kept segment.
- Validation feedback is structural only. Fix format and consistency issues precisely.
"""


class CleanedTranscriptValidationError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        best_transcript: Transcript | None = None,
        issues: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.best_transcript = best_transcript
        self.issues = issues or []


class TranscriptRewriteAgent:
    def __init__(self, *, model: str = "gpt-5.4") -> None:
        api_key = os.getenv("OPENAI_API_KEY")
        base_url = os.getenv("OPENAI_BASE_URL")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY is missing. Put it in a .env file at the repository root or export it in the shell."
            )
        if api_key == "lm-studio" and not base_url:
            raise RuntimeError(
                "OPENAI_API_KEY=lm-studio requires OPENAI_BASE_URL to point to a running OpenAI-compatible server. "
                "Otherwise set a real OpenAI API key in .env."
            )
        self._llm = ChatOpenAI(
            model=model, temperature=0, api_key=api_key, base_url=base_url
        )
        self._max_validation_attempts = 5

    def run(self, transcript: Transcript, user_prompt: str) -> Transcript:
        prompt = ChatPromptTemplate.from_messages(
            [
                ("system", REWRITE_SYSTEM_PROMPT),
                (
                    "human",
                    "User request:\n{user_prompt}\n\n"
                    "Source AXCUT transcript:\n{source_dsl}\n\n"
                    "Previous validation feedback:\n{validation_feedback}",
                ),
            ]
        )
        chain = prompt | self._llm

        validation_feedback = "No previous validation issues."
        best_transcript: Transcript | None = None
        best_issues: list[str] = []

        for _ in range(self._max_validation_attempts):
            response = chain.invoke(
                {
                    "user_prompt": user_prompt,
                    "source_dsl": _serialize_source_dsl(transcript),
                    "validation_feedback": validation_feedback,
                }
            )
            candidate_text = _extract_dsl(str(response.content))
            parsed, issues = _parse_and_validate_candidate(candidate_text, transcript)
            if parsed is not None and (
                best_transcript is None
                or not best_issues
                or len(issues) < len(best_issues)
            ):
                best_transcript = parsed
                best_issues = issues
            elif parsed is None and not best_issues:
                best_issues = issues
            if not issues and parsed is not None:
                return parsed
            validation_feedback = "\n".join(f"- {issue}" for issue in issues)

        raise CleanedTranscriptValidationError(
            "The transcript rewrite agent could not produce a structurally valid cleaned transcript after multiple attempts. "
            f"Last validation issues:\n{validation_feedback}",
            best_transcript=best_transcript,
            issues=best_issues,
        )


def _serialize_source_dsl(transcript: Transcript) -> str:
    lines = [
        "AXCUT_TRANSCRIPT v1",
        (
            f"META source_video={json.dumps(transcript.source_video, ensure_ascii=False)} "
            f"duration={transcript.duration:.3f} "
            f"language={json.dumps(transcript.language, ensure_ascii=False)} "
            f"kind={json.dumps(transcript.kind, ensure_ascii=False)}"
        ),
    ]
    for segment in transcript.segments:
        lines.append(
            f"SEGMENT id={segment.id} start={segment.start:.3f} end={segment.end:.3f} "
            f"text={json.dumps(segment.text, ensure_ascii=False)}"
        )
        for word in segment.words:
            lines.append(
                f"WORD id={word.id} segment={word.segment_id} start={word.start:.3f} end={word.end:.3f} "
                f"text={json.dumps(word.text, ensure_ascii=False)}"
            )
        lines.append("ENDSEGMENT")
    return "\n".join(lines)


def _extract_dsl(raw: str) -> str:
    stripped = raw.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
    start = stripped.find("AXCUT_TRANSCRIPT v1")
    if start >= 0:
        stripped = stripped[start:]
    return stripped


def _parse_and_validate_candidate(
    candidate_text: str, source: Transcript
) -> tuple[Transcript | None, list[str]]:
    try:
        candidate = read_transcript_text(candidate_text, origin="llm_cleaned")
    except ValueError as exc:
        return None, [str(exc)]
    issues = _validate_cleaned_transcript(candidate, source)
    return candidate, issues


def _validate_cleaned_transcript(
    candidate: Transcript, source: Transcript
) -> list[str]:
    issues: list[str] = []
    if candidate.source_video != source.source_video:
        issues.append("META source_video must match the source transcript exactly.")
    if abs(candidate.duration - source.duration) > 0.001:
        issues.append("META duration must match the source transcript exactly.")
    if candidate.language != source.language:
        issues.append("META language must match the source transcript exactly.")
    if candidate.kind != "cleaned":
        issues.append("META kind must be 'cleaned'.")

    source_words = source.all_words()
    source_word_map = {word.id: word for word in source_words}
    source_order = {word.id: index for index, word in enumerate(source_words)}
    seen_segment_ids: set[str] = set()
    kept_word_ids: list[str] = []
    seen_word_ids: set[str] = set()

    for segment in candidate.segments:
        issues.extend(_validate_segment_shape(segment, seen_segment_ids))
        for word in segment.words:
            if word.id in seen_word_ids:
                issues.append(
                    f"WORD {word.id} is duplicated in the cleaned transcript."
                )
                continue
            seen_word_ids.add(word.id)
            kept_word_ids.append(word.id)

            source_word = source_word_map.get(word.id)
            if source_word is None:
                issues.append(
                    f"WORD {word.id} does not exist in the source transcript."
                )
                continue
            if word.segment_id != segment.id:
                issues.append(
                    f"WORD {word.id} must reference its containing segment id {segment.id}."
                )
            if word.start != source_word.start or word.end != source_word.end:
                issues.append(f"WORD {word.id} must keep the exact source timestamps.")
            if word.text != source_word.text:
                issues.append(f"WORD {word.id} must keep the exact source text.")

        issues.extend(_validate_segment_content(segment))

    if kept_word_ids:
        ordered_ids = sorted(kept_word_ids, key=lambda word_id: source_order[word_id])
        if kept_word_ids != ordered_ids:
            issues.append(
                "Kept WORD entries must remain in the same global order as the source transcript."
            )

    return _dedupe_issues(issues)


def _validate_segment_shape(segment: Segment, seen_segment_ids: set[str]) -> list[str]:
    issues: list[str] = []
    if not segment.id:
        issues.append("Every SEGMENT must have a non-empty id.")
    elif segment.id in seen_segment_ids:
        issues.append(f"SEGMENT id {segment.id} is duplicated.")
    else:
        seen_segment_ids.add(segment.id)
    if not segment.words:
        issues.append(
            f"SEGMENT {segment.id or '[missing id]'} must contain at least one WORD."
        )
    return issues


def _validate_segment_content(segment: Segment) -> list[str]:
    if not segment.words:
        return []
    issues: list[str] = []
    expected_text = " ".join(word.text for word in segment.words).strip()
    if segment.text != expected_text:
        issues.append(
            f"SEGMENT {segment.id} text must equal its WORD texts joined by single spaces."
        )
    if segment.start != segment.words[0].start:
        issues.append(f"SEGMENT {segment.id} start must match the first WORD start.")
    if segment.end != segment.words[-1].end:
        issues.append(f"SEGMENT {segment.id} end must match the last WORD end.")
    for previous, current in zip(segment.words, segment.words[1:]):
        if current.start < previous.start:
            issues.append(
                f"SEGMENT {segment.id} WORD entries must be in chronological order."
            )
            break
    return issues


def _dedupe_issues(issues: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for issue in issues:
        normalized = re.sub(r"\s+", " ", issue).strip()
        if normalized and normalized not in seen:
            deduped.append(issue)
            seen.add(normalized)
    return deduped
