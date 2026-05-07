import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxcutDocument } from '@axcut/schema';

import { TimelinePane } from './components/TimelinePane.js';
import { VirtualPreview } from './components/VirtualPreview.js';

type ProjectSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

type Message = {
  id: string;
  sessionId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
};

type SessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  messageCount: number;
  active: boolean;
};

type ProjectSnapshot = {
  document: AxcutDocument;
  messages: Message[];
  jobs: Array<{ id: string; kind: string; status: string; progress: number; message: string; resultJson: string | null }>;
  activeSessionId: string;
  sessions: SessionSummary[];
};

type SessionPayload = {
  token: string;
};

type LlmProviderState = {
  id: string;
  label: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
  oauth: boolean;
  setupHint?: string;
  connected: boolean;
  selected: boolean;
  model?: string;
  baseUrl?: string;
  credentialSource: 'yagr' | 'environment' | null;
};

type LlmStatus = {
  ready: boolean;
  effective: {
    provider: string | null;
    providerLabel: string;
    model: string;
    baseUrl?: string;
  };
  providers: LlmProviderState[];
  connectedProviders: LlmProviderState[];
  availableProviders: LlmProviderState[];
};

type ProjectStreamEvent = {
  type: string;
  projectId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type DeviceChallenge = {
  provider: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode: string;
  deviceAuthId?: string;
  deviceCode?: string;
  intervalMs: number;
  expiresAt: number;
};

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(input, {
    headers,
    ...init,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function authHeaders(sessionToken: string): HeadersInit {
  return { 'X-Axcut-Token': sessionToken };
}

function useProjectEvents(
  projectId: string | null,
  sessionToken: string | undefined,
  onEvent: (event: ProjectStreamEvent) => void,
): void {
  useEffect(() => {
    if (!projectId || !sessionToken) {
      return undefined;
    }
    const source = new EventSource(`/api/projects/${projectId}/stream?token=${encodeURIComponent(sessionToken)}`);
    const eventNames = [
      'job.progress',
      'job.completed',
      'project.transcript.updated',
      'project.revision.created',
      'preview.ready',
      'agent.message.user',
      'agent.message.assistant',
      'agent.message.delta',
      'agent.thinking.delta',
      'agent.operation',
      'agent.compaction',
      'agent.session.created',
      'agent.session.updated',
      'agent.session.deleted',
    ] as const;
    const listeners = eventNames.map((eventName) => {
      const listener = ((incoming: MessageEvent<string>) => {
        try {
          onEvent(JSON.parse(incoming.data) as ProjectStreamEvent);
        } catch {
          // Ignore malformed stream payloads.
        }
      }) as EventListener;
      source.addEventListener(eventName, listener);
      return { eventName, listener };
    });
    return () => {
      for (const { eventName, listener } of listeners) {
        source.removeEventListener(eventName, listener);
      }
      source.close();
    };
  }, [onEvent, projectId, sessionToken]);
}

export function App() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [virtualTimeSec, setVirtualTimeSec] = useState(0);
  const [seekTarget, setSeekTarget] = useState<{ timeSec: number; requestId: number } | null>(null);

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => requestJson<SessionPayload>('/api/session'),
  });
  const sessionToken = sessionQuery.data?.token;

  const llmConfigQuery = useQuery({
    enabled: Boolean(sessionToken),
    queryKey: ['llm-config'],
    queryFn: () => requestJson<LlmStatus>('/api/llm/config', {
      headers: authHeaders(sessionToken!),
    }),
  });

  const projectsQuery = useQuery({
    enabled: Boolean(sessionToken),
    queryKey: ['projects'],
    queryFn: () => requestJson<{ projects: ProjectSummary[] }>('/api/projects', {
      headers: authHeaders(sessionToken!),
    }),
    refetchInterval: 5000,
  });

  useEffect(() => {
    const firstProjectId = projectsQuery.data?.projects[0]?.id;
    if (!selectedProjectId && firstProjectId) {
      setSelectedProjectId(firstProjectId);
    }
  }, [projectsQuery.data?.projects, selectedProjectId]);

  const projectId = selectedProjectId;
  const snapshotQuery = useQuery({
    enabled: Boolean(projectId && sessionToken),
    queryKey: ['project', projectId, activeSessionId],
    queryFn: () => {
      const sessionQueryPart = activeSessionId ? `?sessionId=${encodeURIComponent(activeSessionId)}` : '';
      return requestJson<ProjectSnapshot>(`/api/projects/${projectId}${sessionQueryPart}`, {
        headers: authHeaders(sessionToken!),
      });
    },
  });

  useEffect(() => {
    if (snapshotQuery.data?.activeSessionId && snapshotQuery.data.activeSessionId !== activeSessionId) {
      setActiveSessionId(snapshotQuery.data.activeSessionId);
    }
  }, [activeSessionId, snapshotQuery.data?.activeSessionId]);

  const invalidateProject = useCallback(() => {
    if (!projectId) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }, [projectId, queryClient]);

  useProjectEvents(projectId, sessionToken, invalidateProject);

  const createSession = useMutation({
    mutationFn: async () => {
      if (!projectId || !sessionToken) {
        throw new Error('No active project.');
      }
      return requestJson<{ session: SessionSummary; snapshot: ProjectSnapshot }>(`/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async (result) => {
      setActiveSessionId(result.session.id);
      setHistoryOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const deleteSession = useMutation({
    mutationFn: async (sessionId: string) => {
      if (!projectId || !sessionToken) {
        throw new Error('No active project.');
      }
      return requestJson<{ activeSessionId: string }>(`/api/projects/${projectId}/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async (result) => {
      setActiveSessionId(result.activeSessionId);
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const renameSession = useMutation({
    mutationFn: async ({ sessionId, title }: { sessionId: string; title: string }) => {
      if (!projectId || !sessionToken) {
        throw new Error('No active project.');
      }
      return requestJson(`/api/projects/${projectId}/sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const sendChat = useMutation({
    mutationFn: async () => {
      if (!projectId || !sessionToken) {
        throw new Error('No active project.');
      }
      return requestJson(`/api/projects/${projectId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ sessionId: activeSessionId ?? undefined, message }),
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      setMessage('');
      invalidateProject();
    },
  });

  const snapshot = snapshotQuery.data;
  const document = snapshot?.document;
  const activeSession = snapshot?.sessions.find((session) => session.id === snapshot.activeSessionId) ?? snapshot?.sessions[0];
  const primaryAsset = useMemo(
    () => document?.assets.find((asset) => asset.id === document.project.primaryAssetId) ?? document?.assets[0],
    [document],
  );
  const videoSrc = projectId && primaryAsset
    ? `/api/projects/${projectId}/assets/${primaryAsset.id}/media?variant=${primaryAsset.proxyPath ? 'proxy' : 'original'}&token=${encodeURIComponent(sessionToken ?? '')}`
    : null;
  const latestJob = snapshot?.jobs[0] ?? null;
  const statusText = !projectId
    ? 'No configured project. Set AXCUT_VIDEO_PATH before starting the server.'
    : latestJob
      ? latestJob.message
      : 'Ready';
  const providerLabel = llmConfigQuery.data?.ready
    ? `${llmConfigQuery.data.effective.providerLabel} · ${llmConfigQuery.data.effective.model}`
    : 'LLM not configured';

  return (
    <div className="app-shell">
      <aside className="left-rail panel">
        <header className="chat-header">
          <div>
            <h1>Axcut</h1>
            <p className="muted">Agentic video editor</p>
          </div>
          <div className="header-actions">
            <button className="secondary" onClick={() => setHistoryOpen(true)} disabled={!projectId}>History</button>
            <button onClick={() => createSession.mutate()} disabled={!projectId || createSession.isPending}>New chat</button>
          </div>
        </header>

        <div className="project-row">
          <select
            value={projectId ?? ''}
            onChange={(event) => {
              setSelectedProjectId(event.target.value || null);
              setActiveSessionId(null);
            }}
          >
            {projectsQuery.data?.projects.length ? projectsQuery.data.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.title}</option>
            )) : <option value="">Waiting for project</option>}
          </select>
        </div>

        <button className={llmConfigQuery.data?.ready ? 'provider-pill ready' : 'provider-pill'} onClick={() => setProviderOpen(true)}>
          {providerLabel}
        </button>

        <div className="session-card">
          <span className="muted">Current conversation</span>
          <strong>{activeSession?.title ?? 'New conversation'}</strong>
          <small className="muted">{statusText}</small>
        </div>

        <div className="messages">
          {snapshot?.messages.length ? snapshot.messages.map((item) => (
            <article key={item.id} className={`message ${item.role}`}>
              <div className="message-meta">
                <strong className={`message-role ${item.role}`}>{item.role}</strong>
                <span className="muted">{new Date(item.createdAt).toLocaleTimeString()}</span>
              </div>
              <p>{item.content}</p>
            </article>
          )) : (
            <div className="message-empty muted">
              {projectId ? 'No messages in this conversation yet.' : 'Start the server with AXCUT_VIDEO_PATH set to a local video file.'}
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!sendChat.isPending && message.trim()) {
              sendChat.mutate();
            }
          }}
        >
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && message.trim()) {
                sendChat.mutate();
              }
            }}
            rows={4}
            placeholder="Describe the edit you want."
          />
          <button
            type="submit"
            disabled={!projectId || !sessionToken || !llmConfigQuery.data?.ready || !message.trim() || sendChat.isPending}
          >
            {sendChat.isPending ? 'Working...' : 'Send'}
          </button>
        </form>
      </aside>

      <main className="preview-pane panel">
        <div className="preview-header">
          <div>
            <h2>{document?.project.title ?? 'Video Preview'}</h2>
            <p className="muted">
              {primaryAsset
                ? `${primaryAsset.label}${primaryAsset.proxyPath ? ' · proxy ready' : ' · loading original source'}`
                : 'Waiting for configured video source'}
            </p>
          </div>
        </div>

        {document ? (
          <VirtualPreview
            videoSrc={videoSrc}
            clips={document.timeline.clips}
            revision={document.preview.revision}
            seekTarget={seekTarget}
            onTimeChange={setVirtualTimeSec}
          />
        ) : (
          <div className="video placeholder">No video configured.</div>
        )}
      </main>

      <TimelinePane
        clips={document?.timeline.clips ?? []}
        currentTimeSec={virtualTimeSec}
        onSeek={(timeSec) => setSeekTarget({ timeSec, requestId: Date.now() })}
      />

      {historyOpen ? (
        <SessionHistoryDialog
          sessions={snapshot?.sessions ?? []}
          activeSessionId={snapshot?.activeSessionId ?? activeSessionId}
          busy={createSession.isPending || deleteSession.isPending || renameSession.isPending}
          onClose={() => setHistoryOpen(false)}
          onCreate={() => createSession.mutate()}
          onSelect={(sessionId) => {
            setActiveSessionId(sessionId);
            setHistoryOpen(false);
          }}
          onDelete={(sessionId) => deleteSession.mutate(sessionId)}
          onRename={(sessionId, title) => renameSession.mutate({ sessionId, title })}
        />
      ) : null}

      {providerOpen ? (
        <ProviderSettingsDialog
          snapshot={llmConfigQuery.data}
          sessionToken={sessionToken}
          onClose={() => setProviderOpen(false)}
          onChanged={async () => {
            await queryClient.invalidateQueries({ queryKey: ['llm-config'] });
          }}
        />
      ) : null}
    </div>
  );
}

function SessionHistoryDialog({
  sessions,
  activeSessionId,
  busy,
  onClose,
  onCreate,
  onSelect,
  onDelete,
  onRename,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  busy: boolean;
  onClose: () => void;
  onCreate: () => void;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal panel history-modal">
        <div className="modal-header">
          <div>
            <h2>Conversation History</h2>
            <p className="muted">Switch sessions or start a clean chat.</p>
          </div>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
        <button onClick={onCreate} disabled={busy}>New chat</button>
        <div className="session-list">
          {sessions.map((session) => (
            <article key={session.id} className={session.id === activeSessionId ? 'session-item active' : 'session-item'}>
              {editingId === session.id ? (
                <form
                  className="rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onRename(session.id, editingTitle);
                    setEditingId(null);
                  }}
                >
                  <input value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} />
                  <button disabled={busy || !editingTitle.trim()}>Save</button>
                </form>
              ) : (
                <>
                  <button className="session-main" onClick={() => onSelect(session.id)}>
                    <strong>{session.title}</strong>
                    <span className="muted">
                      {session.messageCount} message{session.messageCount === 1 ? '' : 's'} · {new Date(session.updatedAt).toLocaleString()}
                    </span>
                  </button>
                  <div className="session-actions">
                    {session.id === activeSessionId ? <span className="status-pill ready">Active</span> : null}
                    <button
                      className="secondary"
                      onClick={() => {
                        setEditingId(session.id);
                        setEditingTitle(session.title);
                      }}
                      disabled={busy}
                    >
                      Rename
                    </button>
                    <button className="danger" onClick={() => onDelete(session.id)} disabled={busy || sessions.length <= 1}>Delete</button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProviderSettingsDialog({
  snapshot,
  sessionToken,
  onClose,
  onChanged,
}: {
  snapshot?: LlmStatus;
  sessionToken?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [providerId, setProviderId] = useState(snapshot?.effective.provider ?? snapshot?.providers[0]?.id ?? 'openai');
  const activeProvider = snapshot?.providers.find((provider) => provider.id === providerId) ?? snapshot?.providers[0];
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(activeProvider?.model || activeProvider?.defaultModel || '');
  const [baseUrl, setBaseUrl] = useState(activeProvider?.baseUrl || activeProvider?.defaultBaseUrl || '');
  const [models, setModels] = useState<string[]>([]);
  const [challenge, setChallenge] = useState<DeviceChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModel(activeProvider?.model || activeProvider?.defaultModel || '');
    setBaseUrl(activeProvider?.baseUrl || activeProvider?.defaultBaseUrl || '');
    setApiKey('');
    setModels([]);
    setChallenge(null);
    setError(null);
  }, [activeProvider?.baseUrl, activeProvider?.defaultBaseUrl, activeProvider?.defaultModel, activeProvider?.id, activeProvider?.model]);

  const runProviderAction = async (action: () => Promise<void>) => {
    if (!sessionToken || !activeProvider) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (incoming) {
      setError(incoming instanceof Error ? incoming.message : String(incoming));
    } finally {
      setBusy(false);
    }
  };

  const providerSections = [
    ['Connected providers', snapshot?.connectedProviders ?? []] as const,
    ['Available providers', snapshot?.availableProviders ?? []] as const,
  ];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal panel provider-modal">
        <div className="modal-header">
          <div>
            <h2>Provider Settings</h2>
            <p className="muted">Connect, select, and discover models through Yagr.</p>
          </div>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>

        {providerSections.map(([title, providers]) => providers.length ? (
          <div key={title} className="provider-section">
            <h3>{title}</h3>
            <div className="provider-grid">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  className={provider.id === providerId ? 'provider-row active' : 'provider-row'}
                  onClick={() => setProviderId(provider.id)}
                >
                  <strong>{provider.label}</strong>
                  <span className="muted">{provider.model || provider.defaultModel || 'Custom model'}</span>
                  <span className="provider-badges">
                    {provider.selected ? <small className="status-pill ready">Selected</small> : null}
                    {provider.credentialSource ? <small className="status-pill ready">{provider.credentialSource}</small> : null}
                    {provider.oauth ? <small className="status-pill">OAuth</small> : null}
                    {provider.requiresApiKey ? <small className="status-pill">API key</small> : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null)}

        {activeProvider ? (
          <div className="provider-form">
            <div>
              <h3>{activeProvider.label}</h3>
              <p className="muted">{activeProvider.setupHint || 'Configure this provider for Axcut chat.'}</p>
            </div>
            <label>
              <span className="muted">Model</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={activeProvider.defaultModel} />
            </label>
            {models.length ? (
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {models.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
              </select>
            ) : null}
            {activeProvider.requiresBaseUrl ? (
              <label>
                <span className="muted">Base URL</span>
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={activeProvider.defaultBaseUrl || 'Provider base URL'} />
              </label>
            ) : null}
            {activeProvider.requiresApiKey ? (
              <label>
                <span className="muted">API key</span>
                <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={activeProvider.connected ? 'Leave blank to keep stored key' : 'Paste API key'} />
              </label>
            ) : null}
            {challenge ? (
              <div className="device-challenge">
                <strong>Finish browser login</strong>
                <a href={challenge.verificationUriComplete || challenge.verificationUri} target="_blank" rel="noreferrer">
                  {challenge.verificationUriComplete || challenge.verificationUri}
                </a>
                <code>{challenge.userCode}</code>
              </div>
            ) : null}
            {error ? <p className="error-copy">{error}</p> : null}
            <div className="provider-actions">
              <button
                onClick={() => runProviderAction(async () => {
                  const result = await requestJson<{ challenge?: Omit<DeviceChallenge, 'provider'> }>(`/api/llm/providers/${activeProvider.id}/connect`, {
                    method: 'POST',
                    body: JSON.stringify({ apiKey: apiKey || undefined, model, baseUrl: baseUrl || undefined }),
                    headers: authHeaders(sessionToken!),
                  });
                  if (result.challenge) {
                    setChallenge({ provider: activeProvider.id, ...result.challenge });
                  }
                })}
                disabled={busy || (!activeProvider.oauth && activeProvider.requiresApiKey && !apiKey && !activeProvider.connected)}
              >
                {activeProvider.oauth ? 'Start login' : 'Connect'}
              </button>
              <button
                className="secondary"
                onClick={() => runProviderAction(async () => {
                  await requestJson(`/api/llm/providers/${activeProvider.id}/select`, {
                    method: 'POST',
                    body: JSON.stringify({ model, baseUrl: baseUrl || undefined }),
                    headers: authHeaders(sessionToken!),
                  });
                })}
                disabled={busy || !model.trim()}
              >
                Use provider
              </button>
              <button
                className="secondary"
                onClick={() => runProviderAction(async () => {
                  const params = baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : '';
                  const result = await requestJson<{ models: string[] }>(`/api/llm/providers/${activeProvider.id}/models${params}`, {
                    headers: authHeaders(sessionToken!),
                  });
                  setModels(result.models);
                  setModel((current) => current || result.models[0] || activeProvider.defaultModel);
                })}
                disabled={busy}
              >
                Load models
              </button>
              {challenge ? (
                <button
                  onClick={() => runProviderAction(async () => {
                    await requestJson(`/api/llm/providers/${activeProvider.id}/device/complete`, {
                      method: 'POST',
                      body: JSON.stringify({ ...challenge, model }),
                      headers: authHeaders(sessionToken!),
                    });
                    setChallenge(null);
                  })}
                  disabled={busy}
                >
                  Complete login
                </button>
              ) : null}
              <button
                className="danger"
                onClick={() => runProviderAction(async () => {
                  await requestJson(`/api/llm/providers/${activeProvider.id}`, {
                    method: 'DELETE',
                    headers: authHeaders(sessionToken!),
                  });
                })}
                disabled={busy || !activeProvider.connected}
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
