from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class WordToken(BaseModel):
    id: str
    segment_id: str
    start: float
    end: float
    text: str


class Segment(BaseModel):
    id: str
    start: float
    end: float
    text: str
    words: list[WordToken] = Field(default_factory=list)


class Transcript(BaseModel):
    source_video: str
    duration: float
    language: str
    kind: Literal["source", "cleaned"] = "source"
    edit_prompt: str | None = None
    segments: list[Segment]

    def all_words(self) -> list[WordToken]:
        return [word for segment in self.segments for word in segment.words]


class DeleteRange(BaseModel):
    start_word_id: str
    end_word_id: str
    reason: str


class FollowUpQuestion(BaseModel):
    question: str
    reason: str
    start_word_id: str | None = None
    end_word_id: str | None = None


class EditSuggestion(BaseModel):
    category: Literal["cut_candidate", "style", "delivery", "topic_focus", "clarification"]
    suggestion: str
    reason: str
    start_word_id: str | None = None
    end_word_id: str | None = None


class EditPlan(BaseModel):
    summary: str
    drop_silence_gaps_over_ms: int = Field(default=0, ge=0, le=5000)
    delete_ranges: list[DeleteRange] = Field(default_factory=list)
    follow_up_questions: list[FollowUpQuestion] = Field(default_factory=list)
    suggestions: list[EditSuggestion] = Field(default_factory=list)


class KeepInterval(BaseModel):
    start: float
    end: float
