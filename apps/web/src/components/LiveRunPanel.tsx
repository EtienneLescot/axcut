import type { LiveRunState } from '../lib/live-run.js';

type LiveRunPanelProps = {
  state: LiveRunState;
};

function statusLabel(status: 'running' | 'done' | 'error'): string {
  switch (status) {
    case 'running': return 'Running';
    case 'done': return 'Done';
    case 'error': return 'Error';
  }
}

export function LiveRunPanel({ state }: LiveRunPanelProps) {
  const hasContent = Boolean(
    state.userMessage
    || state.assistantDraft
    || state.finalMessage
    || state.thinking
    || state.operations.length
    || state.compactions.length,
  );

  return (
    <div className="panel live-run-panel">
      <div className="panel-header">
        <div>
          <h2>Live Run</h2>
          <p className="muted">Streaming deltas, thinking, and operation cards from the Yagr-backed agent runtime.</p>
        </div>
        <span className={state.active ? 'live-badge active' : 'live-badge'}>
          {state.active ? 'Streaming' : 'Idle'}
        </span>
      </div>

      {!hasContent ? <p className="muted">No active streamed run yet.</p> : null}

      {state.userMessage ? (
        <div className="live-block user">
          <strong>User</strong>
          <p>{state.userMessage}</p>
        </div>
      ) : null}

      {state.thinking ? (
        <div className="live-block thinking">
          <strong>Thinking</strong>
          <p>{state.thinking}</p>
        </div>
      ) : null}

      {state.assistantDraft || state.finalMessage ? (
        <div className="live-block assistant">
          <strong>Assistant</strong>
          <p>{state.assistantDraft || state.finalMessage}</p>
        </div>
      ) : null}

      {state.operations.length > 0 ? (
        <div className="live-operations">
          {state.operations.map((operation) => (
            <div key={operation.operationId} className={`operation-card ${operation.status}`}>
              <div className="row operation-header">
                <strong>{operation.label}</strong>
                <span className="operation-status">{statusLabel(operation.status)}</span>
              </div>
              {operation.summary ? <p className="muted">{operation.summary}</p> : null}
              {operation.body ? <pre className="operation-body">{operation.body}</pre> : null}
            </div>
          ))}
        </div>
      ) : null}

      {state.compactions.length > 0 ? (
        <div className="live-compactions">
          {state.compactions.map((compaction, index) => (
            <div key={`${compaction.summary}-${index}`} className="compaction-card">
              <strong>Context Compaction</strong>
              <p>{compaction.summary}</p>
              <span className="muted">
                {compaction.source} · compacted {compaction.messagesCompacted} messages
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
