import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxcutDocument } from '@axcut/schema';
import type { ProjectStreamEvent } from '@yagr/webui-surface';

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

type LlmStatus = {
  ready: boolean;
  effective: {
    providerLabel: string;
    model: string;
  };
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

function useProjectEvents(
  projectId: string | null,
  sessionToken: string | undefined,
  onEvent: () => void,
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
      'agent.message.assistant',
    ] as const;
    const listeners = eventNames.map((eventName) => {
      const listener = ((incoming: MessageEvent<string>) => {
        try {
          const _event = JSON.parse(incoming.data) as ProjectStreamEvent;
          void _event;
          onEvent();
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
  const [message, setMessage] = useState('');

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => requestJson<SessionPayload>('/api/session'),
  });
  const sessionToken = sessionQuery.data?.token;

  const llmConfigQuery = useQuery({
    enabled: Boolean(sessionToken),
    queryKey: ['llm-config'],
    queryFn: () => requestJson<LlmStatus>('/api/llm/config', {
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
  });

  const projectsQuery = useQuery({
    enabled: Boolean(sessionToken),
    queryKey: ['projects'],
    queryFn: () => requestJson<{ projects: ProjectSummary[] }>('/api/projects', {
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
    refetchInterval: 5000,
  });

  const projectId = projectsQuery.data?.projects[0]?.id ?? null;

  const snapshotQuery = useQuery({
    enabled: Boolean(projectId && sessionToken),
    queryKey: ['project', projectId],
    queryFn: () => requestJson<ProjectSnapshot>(`/api/projects/${projectId}`, {
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
  });

  const invalidateProject = useCallback(() => {
    if (!projectId) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }, [projectId, queryClient]);

  useProjectEvents(projectId, sessionToken, invalidateProject);

  const sendChat = useMutation({
    mutationFn: async () => requestJson(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
      headers: {
        'X-Axcut-Token': sessionToken!,
      },
    }),
    onSuccess: async () => {
      setMessage('');
      invalidateProject();
    },
  });

  const snapshot = snapshotQuery.data;
  const document = snapshot?.document;
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

  return (
    <div className="app-shell">
      <aside className="sidebar panel">
        <div className="header-block">
          <h1>Axcut</h1>
          <p className="muted">Chat on the left. Video on the right.</p>
        </div>

        <div className="status-bar">
          <span>{document?.project.title ?? 'Waiting for configured video'}</span>
          <span className={llmConfigQuery.data?.ready ? 'status-pill ready' : 'status-pill'}>
            {llmConfigQuery.data?.ready
              ? `${llmConfigQuery.data.effective.providerLabel} · ${llmConfigQuery.data.effective.model}`
              : 'LLM not configured'}
          </span>
        </div>

        <p className="muted status-copy">{statusText}</p>

        <div className="messages">
          {snapshot?.messages.length ? snapshot.messages.map((item) => (
            <div key={item.id} className={`message ${item.role}`}>
              <div className="message-meta">
                <strong className={`message-role ${item.role}`}>{item.role}</strong>
                <span className="muted">{new Date(item.createdAt).toLocaleTimeString()}</span>
              </div>
              <p>{item.content}</p>
            </div>
          )) : (
            <div className="message-empty muted">
              {projectId ? 'No conversation yet.' : 'Start the server with AXCUT_VIDEO_PATH set to a local video file.'}
            </div>
          )}
        </div>

        <div className="composer">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={5}
            placeholder="Describe the edit you want."
          />
          <button
            onClick={() => sendChat.mutate()}
            disabled={!projectId || !sessionToken || !llmConfigQuery.data?.ready || !message.trim() || sendChat.isPending}
          >
            Send
          </button>
        </div>
      </aside>

      <main className="workspace panel">
        <div className="header-block">
          <h2>{document?.project.title ?? 'Video Preview'}</h2>
          <p className="muted">
            {primaryAsset
              ? `${primaryAsset.label}${primaryAsset.proxyPath ? ' · proxy ready' : ' · loading original source'}`
              : 'Waiting for configured video source'}
          </p>
        </div>

        {document ? (
          <VirtualPreview
            videoSrc={videoSrc}
            clips={document.timeline.clips}
            revision={document.preview.revision}
          />
        ) : (
          <div className="video placeholder">No video configured.</div>
        )}
      </main>
    </div>
  );
}
