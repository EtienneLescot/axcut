import type { AxcutSuggestion } from '@axcut/schema';
import { Check, X } from 'lucide-react';

type SuggestionListProps = {
  suggestions: AxcutSuggestion[];
  lastReasoningSummary?: string;
  busy: boolean;
  onApprove: (suggestionId: string) => void;
  onReject: (suggestionId: string) => void;
};

export function SuggestionList({
  suggestions,
  lastReasoningSummary,
  busy,
  onApprove,
  onReject,
}: SuggestionListProps) {
  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2>Suggestions</h2>
          <p className="muted">Agent-generated structured cuts that can be approved or rejected individually.</p>
        </div>
      </div>

      {lastReasoningSummary ? (
        <div className="selection-summary">
          <strong>Latest reasoning:</strong> {lastReasoningSummary}
        </div>
      ) : null}

      {suggestions.length === 0 ? (
        <p className="muted">No pending suggestions right now.</p>
      ) : (
        <div className="suggestion-list">
          {suggestions.map((suggestion) => (
            <div key={suggestion.id} className={`suggestion-card ${suggestion.status}`}>
              <div className="row suggestion-header">
                <strong>{suggestion.suggestion}</strong>
                <span className="suggestion-status">{suggestion.status}</span>
              </div>
              <p className="muted">{suggestion.reason}</p>
              {suggestion.startSec !== undefined && suggestion.endSec !== undefined ? (
                <p className="muted">Range: {suggestion.startSec.toFixed(2)}s - {suggestion.endSec.toFixed(2)}s</p>
              ) : null}
              {suggestion.status === 'pending' ? (
                <div className="toolbar-actions">
                  <button className="icon-action" onClick={() => onApprove(suggestion.id)} disabled={busy} title="Approve" aria-label="Approve">
                    <Check size={16} strokeWidth={1.8} aria-hidden="true" />
                    <span className="sr-only">Approve</span>
                  </button>
                  <button className="icon-action secondary" onClick={() => onReject(suggestion.id)} disabled={busy} title="Reject" aria-label="Reject">
                    <X size={16} strokeWidth={1.8} aria-hidden="true" />
                    <span className="sr-only">Reject</span>
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
