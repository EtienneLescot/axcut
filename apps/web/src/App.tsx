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
  jobs: JobSummary[];
  activeSessionId: string;
  sessions: SessionSummary[];
};

type JobSummary = {
  id: string;
  kind: string;
  status: string;
  progress: number;
  message: string;
  resultJson: string | null;
};

type VideoSource = {
  src: string;
  label: string;
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

const transcriptLanguageOptions = [
  { value: 'auto', label: 'Auto' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
] as const;

type TranscriptLanguageSelection = typeof transcriptLanguageOptions[number]['value'];

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(input, {
    ...init,
    headers,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function requestText(input: RequestInfo, init?: RequestInit): Promise<string> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.text();
}

function authHeaders(sessionToken: string): HeadersInit {
  return { 'X-Axcut-Token': sessionToken };
}

function artifactName(filePath?: string): string | null {
  const name = filePath?.split(/[\\/]/).filter(Boolean).at(-1);
  return name || null;
}

function parseJobResult(job?: JobSummary | null): Record<string, unknown> | null {
  if (!job?.resultJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(job.resultJson) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${minutes}:${String(wholeSeconds).padStart(2, '0')}.${tenths}`;
}

function buildEditedTranscript(document: AxcutDocument): string {
  const transcript = document.transcript;
  if (!transcript) {
    return 'No transcript is available yet.';
  }
  if (document.timeline.clips.length === 0) {
    return 'No edited timeline is available yet.';
  }

  const lines: string[] = [];
  for (const [index, clip] of document.timeline.clips.entries()) {
    const words = transcript.words.filter((word) => word.endSec > clip.sourceStartSec && word.startSec < clip.sourceEndSec);
    const text = words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
    lines.push(`# Clip ${index + 1}: source ${formatTimestamp(clip.sourceStartSec)}-${formatTimestamp(clip.sourceEndSec)} -> timeline ${formatTimestamp(clip.timelineStartSec)}-${formatTimestamp(clip.timelineEndSec)}`);
    lines.push(text || '[No spoken words in this clip]');
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function getSttStatus(document: AxcutDocument | undefined, jobs: JobSummary[] | undefined) {
  const sttJob = jobs?.find((job) => job.kind === 'transcribe_asset' || job.kind === 'ingest_asset') ?? null;
  if (!document?.assets.length) {
    return { label: 'STT idle', detail: 'Load a video to start transcription.', progress: 0, tone: 'idle' as const };
  }
  if (sttJob?.status === 'queued' || sttJob?.status === 'running') {
    const inSttPhase = sttJob.kind === 'transcribe_asset' || sttJob.progress >= 0.7 || /transcrib/i.test(sttJob.message);
    return {
      label: inSttPhase ? 'STT running' : 'Preparing STT',
      detail: sttJob.message,
      progress: Math.max(0, Math.min(1, sttJob.progress)),
      tone: 'running' as const,
    };
  }
  if (sttJob?.status === 'failed') {
    return { label: 'STT failed', detail: sttJob.message, progress: sttJob.progress, tone: 'error' as const };
  }
  if (document.transcript) {
    return { label: 'STT complete', detail: `${document.transcript.segments.length} segments · ${document.transcript.words.length} words · ${document.transcript.language}`, progress: 1, tone: 'ready' as const };
  }
  if (!sttJob) {
    return { label: 'STT waiting', detail: 'Waiting for ingest job.', progress: 0, tone: 'idle' as const };
  }
  return { label: 'STT waiting', detail: sttJob.message, progress: sttJob.progress, tone: 'idle' as const };
}

function getExportStatus(job: JobSummary | null, busy: boolean, error: unknown) {
  if (busy) {
    return { label: 'Export queued', detail: 'Starting render job.', progress: 0, tone: 'running' as const };
  }
  if (error) {
    return { label: 'Export failed', detail: error instanceof Error ? error.message : String(error), progress: 1, tone: 'error' as const };
  }
  if (!job) {
    return null;
  }
  if (job.status === 'completed') {
    return { label: 'Export complete', detail: job.message || 'Rendered MP4 is ready.', progress: 1, tone: 'ready' as const };
  }
  if (job.status === 'failed') {
    return { label: 'Export failed', detail: job.message, progress: job.progress, tone: 'error' as const };
  }
  return {
    label: job.status === 'queued' ? 'Export queued' : 'Export running',
    detail: job.message,
    progress: Math.max(0, Math.min(1, job.progress)),
    tone: 'running' as const,
  };
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
      'ready',
      'job.progress',
      'job.queued',
      'job.completed',
      'job.failed',
      'project.asset.updated',
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
  const [loadVideoOpen, setLoadVideoOpen] = useState(false);
  const [transcriptModal, setTranscriptModal] = useState<'source' | 'edited' | null>(null);
  const [transcriptLanguage, setTranscriptLanguage] = useState<TranscriptLanguageSelection>('auto');
  const [virtualTimeSec, setVirtualTimeSec] = useState(0);
  const [seekTarget, setSeekTarget] = useState<{ timeSec: number; requestId: number } | null>(null);

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => requestJson<SessionPayload>('/api/session'),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
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

  const handleProjectEvent = useCallback((event: ProjectStreamEvent) => {
    invalidateProject();
    if (event.type === 'project.transcript.updated') {
      void queryClient.invalidateQueries({ queryKey: ['source-transcript'] });
    }
  }, [invalidateProject, queryClient]);

  useProjectEvents(projectId, sessionToken, handleProjectEvent);

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

  const loadVideo = useMutation({
    mutationFn: async ({ title, path }: { title: string; path: string }) => {
      if (!sessionToken) {
        throw new Error('No Axcut browser session token.');
      }
      const created = await requestJson<{ document: AxcutDocument }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ title: title.trim() || path.split('/').at(-1) || 'Untitled Project' }),
        headers: authHeaders(sessionToken),
      });
      const createdProjectId = created.document.project.id;
      await requestJson(`/api/projects/${createdProjectId}/assets`, {
        method: 'POST',
        body: JSON.stringify({ path, autoTranscribe: true }),
        headers: authHeaders(sessionToken),
      });
      return createdProjectId;
    },
    onSuccess: async (createdProjectId) => {
      setSelectedProjectId(createdProjectId);
      setActiveSessionId(null);
      setLoadVideoOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.invalidateQueries({ queryKey: ['project', createdProjectId] });
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

  const exportVideo = useMutation({
    mutationFn: async () => {
      if (!projectId || !sessionToken) {
        throw new Error('No active project.');
      }
      return requestJson<{ job: JobSummary }>(`/api/projects/${projectId}/export`, {
        method: 'POST',
        body: JSON.stringify({ preset: document?.export.preset ?? 'final-balanced' }),
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: () => {
      invalidateProject();
    },
  });

  const regenerateTranscript = useMutation({
    mutationFn: async () => {
      if (!projectId || !sessionToken) {
        throw new Error('No active project.');
      }
      return requestJson<{ job: JobSummary }>(`/api/projects/${projectId}/transcribe`, {
        method: 'POST',
        body: JSON.stringify({ language: transcriptLanguage }),
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['source-transcript'] });
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
  const videoSources = useMemo<VideoSource[]>(() => {
    if (!projectId || !primaryAsset || !sessionToken) {
      return [];
    }
    const baseUrl = `/api/projects/${projectId}/assets/${primaryAsset.id}/media`;
    const token = encodeURIComponent(sessionToken);
    const original = { src: `${baseUrl}?variant=original&token=${token}`, label: 'original source' };
    if (!primaryAsset.proxyPath) {
      return [original];
    }
    return [
      { src: `${baseUrl}?variant=proxy&token=${token}`, label: 'proxy preview' },
      original,
    ];
  }, [primaryAsset, projectId, sessionToken]);
  const latestJob = snapshot?.jobs[0] ?? null;
  const latestExportJob = snapshot?.jobs.find((job) => job.kind === 'export') ?? null;
  const exportJobResult = parseJobResult(latestExportJob);
  const exportArtifactName = artifactName(typeof exportJobResult?.outputPath === 'string' ? exportJobResult.outputPath : undefined);
  const exportHref = projectId && sessionToken && latestExportJob?.status === 'completed' && exportArtifactName
    ? `/api/projects/${projectId}/artifacts/${encodeURIComponent(exportArtifactName)}?token=${encodeURIComponent(sessionToken)}`
    : null;
  const exportBusy = exportVideo.isPending || latestExportJob?.status === 'queued' || latestExportJob?.status === 'running';
  const exportStatus = getExportStatus(latestExportJob, exportVideo.isPending, exportVideo.error);
  const statusText = !projectId
    ? 'No configured project. Set AXCUT_VIDEO_PATH before starting the server.'
    : latestJob
      ? latestJob.message
      : 'Ready';
  const providerLabel = llmConfigQuery.data?.ready
    ? `${llmConfigQuery.data.effective.providerLabel} · ${llmConfigQuery.data.effective.model}`
    : 'LLM not configured';
  const projectCount = projectsQuery.data?.projects.length ?? 0;
  const sourceTranscriptName = artifactName(document?.transcript?.sourceDslPath ?? document?.transcript?.sourceJsonPath);
  const sourceTranscriptQuery = useQuery({
    enabled: Boolean(transcriptModal === 'source' && projectId && sessionToken && sourceTranscriptName),
    queryKey: ['source-transcript', projectId, sourceTranscriptName],
    queryFn: () => requestText(`/api/projects/${projectId}/artifacts/${encodeURIComponent(sourceTranscriptName!)}?token=${encodeURIComponent(sessionToken!)}`),
  });
  const editedTranscript = useMemo(() => document ? buildEditedTranscript(document) : 'No project is loaded.', [document]);
  const sttStatus = getSttStatus(document, snapshot?.jobs);
  const sourceTranscriptError = transcriptModal === 'source'
    ? sourceTranscriptQuery.error instanceof Error
      ? sourceTranscriptQuery.error.message
      : regenerateTranscript.error instanceof Error
        ? regenerateTranscript.error.message
        : null
    : null;

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
          {projectCount > 1 ? (
            <select
              value={projectId ?? ''}
              onChange={(event) => {
                setSelectedProjectId(event.target.value || null);
                setActiveSessionId(null);
              }}
              aria-label="Current project"
            >
              {projectsQuery.data?.projects.map((project) => (
                <option key={project.id} value={project.id}>{project.title}</option>
              ))}
            </select>
          ) : (
            <div className="project-title-pill">
              <span className="muted">Project</span>
              <strong>{document?.project.title ?? 'No video loaded'}</strong>
            </div>
          )}
          <button className="secondary" onClick={() => setLoadVideoOpen(true)}>Load video</button>
        </div>

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
          <div className="composer-footer">
            <button type="button" className={llmConfigQuery.data?.ready ? 'provider-pill compact ready' : 'provider-pill compact'} onClick={() => setProviderOpen(true)}>
              {providerLabel}
            </button>
            {sendChat.isPending ? <span className="muted">Waiting for the agent response...</span> : null}
          </div>
          {sendChat.isError ? <p className="error-copy">{sendChat.error instanceof Error ? sendChat.error.message : 'Chat request failed.'}</p> : null}
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
          <div className="preview-actions">
            <button className="secondary" onClick={() => setTranscriptModal('source')} disabled={!sourceTranscriptName}>Source transcript</button>
            <button className="secondary" onClick={() => setTranscriptModal('edited')} disabled={!document?.transcript}>Edited transcript</button>
            <button onClick={() => exportVideo.mutate()} disabled={!document?.timeline.clips.length || !sessionToken || exportBusy}>
              {exportBusy ? 'Exporting...' : 'Export'}
            </button>
          </div>
        </div>

        <SttStatusBar status={sttStatus} />
        {exportStatus ? <ExportStatusBar status={exportStatus} href={exportHref} /> : null}

        {document ? (
          <VirtualPreview
            videoSources={videoSources}
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

      {loadVideoOpen ? (
        <LoadVideoDialog
          busy={loadVideo.isPending}
          error={loadVideo.error instanceof Error ? loadVideo.error.message : null}
          onClose={() => setLoadVideoOpen(false)}
          onLoad={(input) => loadVideo.mutate(input)}
        />
      ) : null}

      {transcriptModal ? (
        <TranscriptDialog
          title={transcriptModal === 'source' ? 'Source Transcript' : 'Edited Transcript'}
          subtitle={transcriptModal === 'source'
            ? sourceTranscriptName ?? 'No transcript artifact available yet.'
            : 'Reconstructed from the current Axcut timeline.'}
          content={transcriptModal === 'source'
            ? sourceTranscriptQuery.data ?? ''
            : editedTranscript}
          loading={transcriptModal === 'source' && sourceTranscriptQuery.isLoading}
          error={sourceTranscriptError}
          detectedLanguage={transcriptModal === 'source' ? document?.transcript?.language : undefined}
          language={transcriptLanguage}
          languageOptions={transcriptLanguageOptions}
          regenerateLabel={transcriptModal === 'source' ? 'Regenerate transcript' : undefined}
          regenerating={regenerateTranscript.isPending}
          onLanguageChange={setTranscriptLanguage}
          onRegenerate={transcriptModal === 'source' ? () => regenerateTranscript.mutate() : undefined}
          onClose={() => setTranscriptModal(null)}
        />
      ) : null}
    </div>
  );
}

function SttStatusBar({ status }: { status: ReturnType<typeof getSttStatus> }) {
  return (
    <div className={`stt-status ${status.tone}`}>
      <div className="stt-status-copy">
        <strong>{status.label}</strong>
        <span className="muted">{status.detail}</span>
      </div>
      <div className="stt-progress" aria-label={`${status.label}: ${Math.round(status.progress * 100)}%`}>
        <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
      </div>
    </div>
  );
}

function ExportStatusBar({ status, href }: { status: NonNullable<ReturnType<typeof getExportStatus>>; href: string | null }) {
  return (
    <div className={`export-status ${status.tone}`}>
      <div className="export-status-copy">
        <div>
          <strong>{status.label}</strong>
          <span className="muted">{status.detail}</span>
        </div>
        {href ? <a className="export-download" href={href} download>Download MP4</a> : null}
      </div>
      <div className="stt-progress" aria-label={`${status.label}: ${Math.round(status.progress * 100)}%`}>
        <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
      </div>
    </div>
  );
}

function TranscriptDialog({
  title,
  subtitle,
  content,
  loading,
  error,
  detectedLanguage,
  language,
  languageOptions,
  regenerateLabel,
  regenerating,
  onLanguageChange,
  onRegenerate,
  onClose,
}: {
  title: string;
  subtitle: string;
  content: string;
  loading: boolean;
  error: string | null;
  detectedLanguage?: string;
  language: TranscriptLanguageSelection;
  languageOptions: typeof transcriptLanguageOptions;
  regenerateLabel?: string;
  regenerating: boolean;
  onLanguageChange: (language: TranscriptLanguageSelection) => void;
  onRegenerate?: () => void;
  onClose: () => void;
}) {
  const showControls = Boolean(onRegenerate);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal panel transcript-modal">
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            <p className="muted">{subtitle}</p>
          </div>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
        {showControls ? (
          <div className="transcript-toolbar">
            <span className="status-pill ready">Detected language: {detectedLanguage || 'unknown'}</span>
            <label>
              <span className="muted">Regenerate as</span>
              <select
                value={language}
                onChange={(event) => onLanguageChange(event.target.value as TranscriptLanguageSelection)}
                disabled={regenerating}
              >
                {languageOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <button onClick={onRegenerate} disabled={regenerating}>
              {regenerating ? 'Regenerating...' : regenerateLabel}
            </button>
          </div>
        ) : null}
        {error ? <p className="error-copy">{error}</p> : null}
        <pre className="transcript-viewer">{loading ? 'Loading transcript...' : content || 'Transcript is empty.'}</pre>
      </section>
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

function LoadVideoDialog({
  busy,
  error,
  onClose,
  onLoad,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onLoad: (input: { title: string; path: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [path, setPath] = useState('');

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal panel load-video-modal">
        <div className="modal-header">
          <div>
            <h2>Load Video</h2>
            <p className="muted">Enter a video path that exists on the machine running the Axcut server.</p>
          </div>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
        <form
          className="provider-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) {
              onLoad({ title, path: path.trim() });
            }
          }}
        >
          <label>
            <span className="muted">Project title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Defaults to the video filename" />
          </label>
          <label>
            <span className="muted">Server-local video path</span>
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/you/Videos/source.mp4" />
          </label>
          {error ? <p className="error-copy">{error}</p> : null}
          <button disabled={busy || !path.trim()}>{busy ? 'Loading...' : 'Create project and ingest'}</button>
        </form>
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
  const [screen, setScreen] = useState<'models' | 'providers' | 'settings'>('models');
  const [providerId, setProviderId] = useState(snapshot?.effective.provider ?? snapshot?.connectedProviders[0]?.id ?? snapshot?.providers[0]?.id ?? 'openai');
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

  const loadModels = async () => {
    if (!sessionToken || !activeProvider) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const params = baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : '';
      const result = await requestJson<{ models: string[] }>(`/api/llm/providers/${activeProvider.id}/models${params}`, {
        headers: authHeaders(sessionToken),
      });
      setModels(result.models);
      setModel((current) => current || result.models[0] || activeProvider.defaultModel);
    } catch (incoming) {
      setError(incoming instanceof Error ? incoming.message : String(incoming));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (screen === 'models' && activeProvider?.connected) {
      void loadModels();
    }
    // Load once per selected provider; base URL changes still have the explicit reload button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider?.id, screen]);

  const useModel = () => runProviderAction(async () => {
    await requestJson(`/api/llm/providers/${activeProvider!.id}/select`, {
      method: 'POST',
      body: JSON.stringify({ model, baseUrl: baseUrl || undefined }),
      headers: authHeaders(sessionToken!),
    });
    onClose();
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal panel provider-modal">
        <div className="modal-header">
          {screen === 'models' ? (
            <button className="icon-button secondary" onClick={() => setScreen('providers')} aria-label="Change provider">←</button>
          ) : (
            <button className="icon-button secondary" onClick={() => setScreen(screen === 'providers' ? 'models' : 'providers')} aria-label="Back">←</button>
          )}
          <div>
            <h2>{screen === 'models' ? 'Select Model' : screen === 'providers' ? 'Connected Providers' : 'Provider Settings'}</h2>
            <p className="muted">
              {screen === 'models'
                ? `${activeProvider?.label ?? 'Provider'} models`
                : screen === 'providers'
                  ? 'Choose one of your connected providers.'
                  : 'Connect or disconnect providers.'}
            </p>
          </div>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>

        {screen === 'models' && activeProvider ? (
          <div className="model-picker-screen">
            <div>
              <h3>{activeProvider.label}</h3>
              <p className="muted">Current model: {snapshot?.effective.model || activeProvider.defaultModel || 'Not selected'}</p>
            </div>
            <label>
              <span className="muted">Model</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={activeProvider.defaultModel} />
            </label>
            <div className="model-list">
              {models.length ? models.map((candidate) => (
                <button key={candidate} className={candidate === model ? 'model-option active' : 'model-option'} onClick={() => setModel(candidate)}>
                  {candidate}
                </button>
              )) : (
                <div className="message-empty muted">{busy ? 'Loading models...' : 'No model list loaded. Use the model field or reload models.'}</div>
              )}
            </div>
            {error ? <p className="error-copy">{error}</p> : null}
            <div className="provider-actions">
              <button onClick={useModel} disabled={busy || !model.trim()}>Use model</button>
              <button className="secondary" onClick={() => void loadModels()} disabled={busy}>Reload models</button>
              <button className="secondary" onClick={() => setScreen('settings')}>Provider settings</button>
            </div>
          </div>
        ) : null}

        {screen === 'providers' ? (
          <div className="provider-section">
            <div className="provider-grid">
              {(snapshot?.connectedProviders ?? []).map((provider) => (
                <button
                  key={provider.id}
                  className={provider.id === providerId ? 'provider-row active' : 'provider-row'}
                  onClick={() => {
                    setProviderId(provider.id);
                    setScreen('models');
                  }}
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
            {snapshot?.connectedProviders.length ? null : <div className="message-empty muted">No connected providers yet.</div>}
            <button className="secondary" onClick={() => setScreen('settings')}>Connect a new provider</button>
          </div>
        ) : null}

        {screen === 'settings' && activeProvider ? (
          <div className="settings-screen">
            <div className="provider-section">
              <h3>Available Providers</h3>
              <div className="provider-grid">
                {(snapshot?.providers ?? []).map((provider) => (
                  <button
                    key={provider.id}
                    className={provider.id === providerId ? 'provider-row active' : 'provider-row'}
                    onClick={() => setProviderId(provider.id)}
                  >
                    <strong>{provider.label}</strong>
                    <span className="muted">{provider.setupHint || provider.defaultModel || 'Custom provider'}</span>
                    <span className="provider-badges">
                      {provider.connected ? <small className="status-pill ready">Connected</small> : null}
                      {provider.oauth ? <small className="status-pill">OAuth</small> : null}
                      {provider.requiresApiKey ? <small className="status-pill">API key</small> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="provider-form">
              <div>
                <h3>{activeProvider.label}</h3>
                <p className="muted">{activeProvider.setupHint || 'Configure this provider for Axcut chat.'}</p>
              </div>
              <label>
                <span className="muted">Model</span>
                <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={activeProvider.defaultModel} />
              </label>
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
                  } else {
                    setScreen('models');
                  }
                })}
                disabled={busy || (!activeProvider.oauth && activeProvider.requiresApiKey && !apiKey && !activeProvider.connected)}
              >
                {activeProvider.oauth ? 'Start login' : 'Connect'}
              </button>
              <button
                className="secondary"
                onClick={useModel}
                disabled={busy || !model.trim()}
              >
                Use provider
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
                    setScreen('models');
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
          </div>
        ) : null}
      </section>
    </div>
  );
}
