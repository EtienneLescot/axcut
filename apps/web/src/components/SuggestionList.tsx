import type { AxcutSuggestion } from '@axcut/schema';

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
                  <button onClick={() => onApprove(suggestion.id)} disabled={busy}>Approve</button>
                  <button className="secondary-button" onClick={() => onReject(suggestion.id)} disabled={busy}>Reject</button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
