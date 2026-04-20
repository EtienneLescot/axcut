export interface DeleteRange {
  start_word_id: string;
  end_word_id: string;
  reason: string;
}

export interface FollowUpQuestion {
  question: string;
  reason: string;
  start_word_id?: string | null;
  end_word_id?: string | null;
}

export interface EditSuggestion {
  category: 'cut_candidate' | 'style' | 'delivery' | 'topic_focus' | 'clarification';
  suggestion: string;
  reason: string;
  start_word_id?: string | null;
  end_word_id?: string | null;
}

export interface EditPlan {
  summary: string;
  drop_silence_gaps_over_ms: number;
  delete_ranges: DeleteRange[];
  follow_up_questions: FollowUpQuestion[];
  suggestions: EditSuggestion[];
}

export interface AxcutSessionState {
  sessionId: string;
  videoPath?: string;
  artifactDir?: string;
  transcriptPath?: string;
  planPath?: string;
  cleanedPath?: string;
  outputVideoPath?: string;
  baseEditPrompt?: string;
  planValidated?: boolean;
  validationIssues?: string[];
  awaitingConfirmation: boolean;
  updatedAt: string;
}
