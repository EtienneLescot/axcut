import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApplyOperationInput, AxcutDocument } from '@axcut/schema';

import { SuggestionList } from './components/SuggestionList.js';
import { TranscriptEditor } from './components/TranscriptEditor.js';
import { VirtualPreview } from './components/VirtualPreview.js';

type ProjectSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

type ProjectSnapshot = {
  document: AxcutDocument;
  messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string }>;
  jobs: Array<{ id: string; kind: string; status: string; progress: number; message: string; resultJson: string | null }>;
};

type SessionPayload = {
  token: string;
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

function useProjectEvents(projectId: string | null, sessionToken: string | undefined, onEvent: () => void): void {
  useEffect(() => {
    if (!projectId || !sessionToken) {
      return undefined;
    }
    const source = new EventSource(`/api/projects/${projectId}/stream?token=${encodeURIComponent(sessionToken)}`);
    source.onmessage = () => onEvent();
    source.addEventListener('job.progress', onEvent as EventListener);
    source.addEventListener('job.completed', onEvent as EventListener);
    source.addEventListener('project.transcript.updated', onEvent as EventListener);
    source.addEventListener('project.revision.created', onEvent as EventListener);
    source.addEventListener('preview.ready', onEvent as EventListener);
    return () => {
      source.close();
    };
  }, [onEvent, projectId, sessionToken]);
}

export function App() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState('Axcut Session');
  const [assetPath, setAssetPath] = useState('');
  const [message, setMessage] = useState('Cut filler words, stutters, and dead air aggressively.');

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => requestJson<SessionPayload>('/api/session'),
  });
  const sessionToken = sessionQuery.data?.token;

  const invalidateProject = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }, [queryClient, selectedProjectId]);

  const projectsQuery = useQuery({
    enabled: Boolean(sessionToken),
    queryKey: ['projects'],
    queryFn: () => requestJson<{ projects: ProjectSummary[] }>('/api/projects', {
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
  });

  const snapshotQuery = useQuery({
    enabled: Boolean(selectedProjectId && sessionToken),
    queryKey: ['project', selectedProjectId],
    queryFn: () => requestJson<ProjectSnapshot>(`/api/projects/${selectedProjectId}`, {
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
  });

  useEffect(() => {
    if (!selectedProjectId && projectsQuery.data?.projects[0]) {
      setSelectedProjectId(projectsQuery.data.projects[0].id);
    }
  }, [projectsQuery.data, selectedProjectId]);

  useProjectEvents(selectedProjectId, sessionToken, invalidateProject);

  const createProject = useMutation({
    mutationFn: async () => requestJson<{ document: AxcutDocument }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title }),
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
    onSuccess: async (data) => {
      setSelectedProjectId(data.document.project.id);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.invalidateQueries({ queryKey: ['project', data.document.project.id] });
    },
  });

  const attachAsset = useMutation({
    mutationFn: async () => requestJson(`/api/projects/${selectedProjectId}/assets`, {
      method: 'POST',
      body: JSON.stringify({ path: assetPath, autoTranscribe: true }),
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
    onSuccess: async () => {
      setAssetPath('');
      await queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
    },
  });

  const sendChat = useMutation({
    mutationFn: async () => requestJson(`/api/projects/${selectedProjectId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
    onSuccess: async () => {
      setMessage('');
      await queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
    },
  });

  const triggerExport = useMutation({
    mutationFn: async () => requestJson(`/api/projects/${selectedProjectId}/export`, {
      method: 'POST',
      body: JSON.stringify({ preset: 'final-balanced' }),
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', selectedProjectId] });
    },
  });

  const applyOperation = useMutation({
    mutationFn: async (operation: ApplyOperationInput['operation']) => requestJson(`/api/projects/${selectedProjectId}/operations`, {
      method: 'POST',
      body: JSON.stringify({ operation }),
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
    onSuccess: async () => {
      await invalidateProject();
    },
  });

  const snapshot = snapshotQuery.data;
  const document = snapshot?.document;
  const primaryAsset = useMemo(
    () => document?.assets.find((asset) => asset.id === document.project.primaryAssetId) ?? document?.assets[0],
    [document],
  );
  const videoSrc = selectedProjectId && primaryAsset
    ? `/api/projects/${selectedProjectId}/assets/${primaryAsset.id}/media?variant=${primaryAsset.proxyPath ? 'proxy' : 'original'}&token=${encodeURIComponent(sessionToken ?? '')}`
    : null;
  const exportOutput = snapshot?.jobs.find((job) => job.kind === 'export' && job.status === 'completed' && job.resultJson)?.resultJson;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="panel">
          <h1>Axcut</h1>
          <p className="muted">TypeScript app layer, Python media worker, canonical `.axcut` project document.</p>
          <div className="row gap">
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Project title" />
            <button onClick={() => createProject.mutate()} disabled={!sessionToken || createProject.isPending}>New project</button>
          </div>
        </div>

        <div className="panel grow">
          <h2>Projects</h2>
          <div className="project-list">
            {projectsQuery.data?.projects.map((project) => (
              <button
                key={project.id}
                className={project.id === selectedProjectId ? 'project-item active' : 'project-item'}
                onClick={() => setSelectedProjectId(project.id)}
              >
                <strong>{project.title}</strong>
                <span>{new Date(project.updatedAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>

        {document ? (
          <>
            <div className="panel">
              <h2>Asset Ingest</h2>
              <div className="stack gap">
                <input value={assetPath} onChange={(event) => setAssetPath(event.target.value)} placeholder="Absolute path to a local video" />
                 <button onClick={() => attachAsset.mutate()} disabled={!sessionToken || !assetPath || attachAsset.isPending}>Attach video</button>
              </div>
            </div>

            <div className="panel grow">
              <h2>Conversation</h2>
              <div className="messages">
                {snapshot?.messages.map((item) => (
                  <div key={item.id} className={`message ${item.role}`}>
                    <strong>{item.role}</strong>
                    <p>{item.content}</p>
                  </div>
                ))}
              </div>
              <div className="stack gap">
                <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={4} placeholder="Describe the cut you want." />
                 <button onClick={() => sendChat.mutate()} disabled={!sessionToken || !message || sendChat.isPending}>Run agent</button>
              </div>
            </div>

            <SuggestionList
              suggestions={document.agent.suggestions}
              lastReasoningSummary={document.agent.lastReasoningSummary}
              busy={applyOperation.isPending}
              onApprove={(suggestionId) => {
                applyOperation.mutate({
                  type: 'approve_suggestion',
                  suggestionId,
                  reason: 'Approved from the suggestions panel.',
                });
              }}
              onReject={(suggestionId) => {
                applyOperation.mutate({
                  type: 'reject_suggestion',
                  suggestionId,
                  reason: 'Rejected from the suggestions panel.',
                });
              }}
            />
          </>
        ) : null}
      </aside>

      <main className="workspace">
        {document ? (
          <>
            <section className="panel preview-panel">
              <div className="panel-header">
                <div>
                  <h2>{document.project.title}</h2>
                  <p className="muted">Preview strategy: {document.preview.strategy} · Revision {document.preview.revision}</p>
                </div>
                 <button onClick={() => triggerExport.mutate()} disabled={!sessionToken || triggerExport.isPending || !document.timeline.clips.length}>Export</button>
              </div>
              <VirtualPreview
                videoSrc={videoSrc}
                clips={document.timeline.clips}
                revision={document.preview.revision}
              />
            </section>

            <section className="columns">
              <TranscriptEditor
                document={document}
                busy={applyOperation.isPending}
                onDropWordRange={(startWordId, endWordId) => {
                  applyOperation.mutate({
                    type: 'drop_word_range',
                    startWordId,
                    endWordId,
                    reason: 'Removed from the transcript editor selection.',
                  });
                }}
                onRestoreTimeline={() => {
                  applyOperation.mutate({
                    type: 'restore_full_timeline',
                    reason: 'Restored from the transcript editor.',
                  });
                }}
              />

              <div className="panel">
                <h2>Jobs</h2>
                <div className="jobs">
                  {snapshot?.jobs.map((job) => (
                    <div key={job.id} className="job-item">
                      <strong>{job.kind}</strong>
                      <span>{job.status}</span>
                      <progress value={job.progress} max={1} />
                      <p>{job.message}</p>
                    </div>
                  ))}
                </div>
                {exportOutput ? <p className="muted">Last export: {exportOutput}</p> : null}
              </div>
            </section>
          </>
        ) : (
          <section className="empty-state">
            <h2>No project selected</h2>
            <p>Create a project to start the new Axcut web workflow.</p>
          </section>
        )}
      </main>
    </div>
  );
}
