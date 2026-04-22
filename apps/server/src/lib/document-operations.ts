import type {
  AxcutDocument,
  AxcutOperation,
  AxcutSuggestion,
  AxcutTimelineOperation,
} from '@axcut/schema';

import { applyTimelineOperation } from './timeline.js';

export function applyDocumentOperation(
  document: AxcutDocument,
  operation: AxcutOperation,
  origin: 'system' | 'agent' | 'user',
): AxcutDocument {
  switch (operation.type) {
    case 'approve_suggestion':
      return applySuggestionDecision(document, operation.suggestionId, 'approved', origin, operation.reason);
    case 'reject_suggestion':
      return applySuggestionDecision(document, operation.suggestionId, 'rejected', origin, operation.reason);
    default:
      return applyTimelineMutation(document, operation, origin);
  }
}

export function replaceSuggestions(
  document: AxcutDocument,
  suggestions: AxcutSuggestion[],
  lastReasoningSummary: string,
): AxcutDocument {
  return {
    ...document,
    agent: {
      ...document.agent,
      suggestions,
      lastReasoningSummary,
      lastAppliedOperations: suggestions.length > 0 ? ['propose_cut'] : document.agent.lastAppliedOperations,
    },
  };
}

function applySuggestionDecision(
  document: AxcutDocument,
  suggestionId: string,
  status: 'approved' | 'rejected',
  origin: 'system' | 'agent' | 'user',
  reason: string,
): AxcutDocument {
  const suggestion = document.agent.suggestions.find((item) => item.id === suggestionId);
  if (!suggestion) {
    throw new Error(`Unknown suggestion ${suggestionId}.`);
  }

  let next = document;
  if (status === 'approved' && suggestion.proposedOperation) {
    next = applyTimelineMutation(document, suggestion.proposedOperation, origin);
  }

  return {
    ...next,
    agent: {
      ...next.agent,
      lastReasoningSummary: reason || suggestion.reason || next.agent.lastReasoningSummary,
      lastAppliedOperations: [status === 'approved' ? 'approve_suggestion' : 'reject_suggestion'],
      suggestions: next.agent.suggestions.map((item) => (
        item.id === suggestionId ? { ...item, status } : item
      )),
    },
  };
}

function applyTimelineMutation(
  document: AxcutDocument,
  operation: AxcutTimelineOperation,
  origin: 'system' | 'agent' | 'user',
): AxcutDocument {
  return {
    ...applyTimelineOperation(document, operation, origin),
    agent: {
      ...document.agent,
      lastAppliedOperations: [operation.type],
      suggestions: clearExecutedSuggestions(document.agent.suggestions, operation),
    },
  };
}

function clearExecutedSuggestions(
  suggestions: AxcutSuggestion[],
  operation: AxcutTimelineOperation,
): AxcutSuggestion[] {
  return suggestions.map((suggestion) => {
    if (!suggestion.proposedOperation) {
      return suggestion;
    }
    return sameOperation(suggestion.proposedOperation, operation)
      ? { ...suggestion, status: 'approved' }
      : suggestion;
  });
}

function sameOperation(left: AxcutTimelineOperation, right: AxcutTimelineOperation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
