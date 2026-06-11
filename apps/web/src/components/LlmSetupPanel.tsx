import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';

export type LlmConfigSnapshot = {
  ready: boolean;
  stored: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKeyStored: boolean;
  };
  effective: {
    provider: string;
    providerLabel: string;
    model: string;
    baseUrl?: string;
    apiKeyAvailable: boolean;
    apiKeySource: 'stored' | 'environment';
  };
  providers: Array<{
    id: string;
    label: string;
    defaultModel: string;
    defaultBaseUrl?: string;
    requiresApiKey: boolean;
  }>;
};

type LlmSetupPanelProps = {
  snapshot?: LlmConfigSnapshot;
  busy: boolean;
  onSave: (input: { provider: string; model: string; apiKey?: string; baseUrl?: string; clearApiKey?: boolean }) => void;
};

export function LlmSetupPanel({ snapshot, busy, onSave }: LlmSetupPanelProps) {
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setProvider(snapshot.stored.provider ?? snapshot.effective.provider);
    setModel(snapshot.stored.model ?? snapshot.effective.model);
    setBaseUrl(snapshot.stored.baseUrl ?? snapshot.effective.baseUrl ?? '');
    setApiKey('');
    setClearApiKey(false);
  }, [snapshot]);

  const selectedProvider = useMemo(
    () => snapshot?.providers.find((entry) => entry.id === provider) ?? snapshot?.providers[0],
    [provider, snapshot?.providers],
  );

  return (
    <div className="panel llm-setup-panel">
      <div className="panel-header">
        <div>
          <h2>LLM Setup</h2>
          <p className="muted">Provider-agnostic local model configuration backed by Axcut's native runtime.</p>
        </div>
        <span className={snapshot?.ready ? 'setup-badge ready' : 'setup-badge'}>
          {snapshot?.ready ? 'Ready' : 'Required'}
        </span>
      </div>

      {snapshot ? (
        <div className="setup-summary muted">
          Effective: {snapshot.effective.providerLabel} · {snapshot.effective.model}
          {snapshot.effective.baseUrl ? ` · ${snapshot.effective.baseUrl}` : ''}
          {' · '}
          {snapshot.effective.apiKeyAvailable
            ? `API key from ${snapshot.effective.apiKeySource}`
            : 'No API key available'}
        </div>
      ) : null}

      <div className="stack gap">
        <label className="stack gap-sm">
          <span className="muted">Provider</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            {snapshot?.providers.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.label}</option>
            ))}
          </select>
        </label>

        <label className="stack gap-sm">
          <span className="muted">Model</span>
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={selectedProvider?.defaultModel || 'Model name'}
          />
        </label>

        <label className="stack gap-sm">
          <span className="muted">Base URL</span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={selectedProvider?.defaultBaseUrl || 'Optional base URL'}
          />
        </label>

        <label className="stack gap-sm">
          <span className="muted">
            API Key
            {selectedProvider?.requiresApiKey ? ' (required)' : ' (optional)'}
          </span>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={snapshot?.stored.apiKeyStored ? 'Leave blank to keep stored key' : 'Paste API key'}
            type="password"
          />
        </label>

        {snapshot?.stored.apiKeyStored ? (
          <label className="inline-toggle">
            <input type="checkbox" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)} />
            <span>Clear stored API key</span>
          </label>
        ) : null}

        <button
          className="icon-action"
          onClick={() => onSave({
            provider,
            model,
            apiKey: apiKey || undefined,
            baseUrl: baseUrl || undefined,
            clearApiKey,
          })}
          disabled={busy || !provider}
          title="Save LLM config"
          aria-label="Save LLM config"
        >
          <Save size={16} strokeWidth={1.8} aria-hidden="true" />
          <span className="sr-only">Save LLM config</span>
        </button>
      </div>
    </div>
  );
}
