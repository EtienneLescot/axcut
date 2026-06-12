import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import type { AxcutClip, AxcutDocument } from '@axcut/schema';
import {
  ArrowLeft,
  Brain,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  LogIn,
  MessageSquarePlus,
  Pencil,
  Plus,
  Plug,
  Power,
  RefreshCw,
  SendHorizontal,
  Settings,
  SlidersHorizontal,
  Terminal,
  Trash2,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { TimelinePane } from './components/TimelinePane.js';
import { VirtualPreview } from './components/VirtualPreview.js';
import { emptyLiveRunState, reduceLiveRunState, type LiveOperation, type LiveRunState, type ProjectStreamEvent } from './lib/live-run.js';

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
  checkpointId: string | null;
};

type ContextUsage = {
  promptTokens: number;
  completionTokens: number;
  contextWindowTokens: number;
  fillPercent: number;
  source: 'api' | 'estimated';
};

type CheckpointSummary = {
  id: string;
  sessionId: string;
  createdAt: string;
  messageCount: number;
  summary?: string;
  reason?: string;
  label?: string;
  restoredAt?: string;
};

type WorktreeInfo = {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
};

type SessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  messageCount: number;
  checkpointCount: number;
  contextUsage?: ContextUsage;
  active: boolean;
};

type ProjectSnapshot = {
  document: AxcutDocument;
  messages: Message[];
  jobs: JobSummary[];
  activeSessionId: string;
  sessions: SessionSummary[];
  checkpoints: CheckpointSummary[];
  contextUsage?: ContextUsage;
  activeWorktree?: WorktreeInfo;
  availableWorktrees: WorktreeInfo[];
};

type PendingTimelineEdit = {
  requestId: number;
  projectId: string;
  intervals: Array<{ startSec: number; endSec: number }>;
  reason: string;
};

type ReplaceTimelineInput = PendingTimelineEdit & {
  sessionId: string;
  controller: AbortController;
};

type ReplaceTimelineResult =
  | { aborted?: false; document: AxcutDocument; revisionId: string; message: Message | null }
  | { aborted: true };

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
  supportsReasoningEffort: boolean;
  reasoningEffort?: ReasoningEffort;
  credentialSource: 'stored' | 'environment' | null;
};

type LlmStatus = {
  ready: boolean;
  effective: {
    provider: string | null;
    providerLabel: string;
    model: string;
    baseUrl?: string;
    reasoningEffort?: ReasoningEffort;
    supportsReasoningEffort: boolean;
  };
  providers: LlmProviderState[];
  connectedProviders: LlmProviderState[];
  availableProviders: LlmProviderState[];
};

type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const reasoningEffortOptions = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
] as const satisfies ReadonlyArray<{ value: ReasoningEffort; label: string }>;

const providerUserDescriptions: Record<string, string> = {
  'copilot-proxy': 'Sign in with your GitHub account.',
  'openai-oauth': 'Sign in with your ChatGPT account.',
};

const CHAT_WIDTH_STORAGE_KEY = 'axcut.workbench.chatWidthPx';
const TIMELINE_HEIGHT_STORAGE_KEY = 'axcut.workbench.timelineHeightPx';
const DEFAULT_CHAT_WIDTH = 610;
const DEFAULT_TIMELINE_HEIGHT = 170;

function readStoredNumber(key: string, fallback: number): number {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getProviderUserDescription(provider: Pick<LlmProviderState, 'id' | 'defaultModel'>) {
  return providerUserDescriptions[provider.id] ?? '';
}

function displayMessageRole(role: Message['role']): string {
  if (role === 'user') {
    return 'you';
  }
  if (role === 'assistant') {
    return 'Axcut';
  }
  return role;
}

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

type PopoverAnchor = {
  left: number;
  top: number;
  width: number;
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

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  children?: ReactNode;
};

function IconButton({ icon: Icon, label, className, children, ...props }: IconButtonProps) {
  return (
    <button
      {...props}
      className={['icon-action', children ? 'has-text' : '', className].filter(Boolean).join(' ')}
      aria-label={props['aria-label'] ?? label}
      title={props.title ?? label}
    >
      <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
      {children ? <span className="button-text">{children}</span> : <span className="sr-only">{label}</span>}
    </button>
  );
}

function popoverStyle(anchor: PopoverAnchor | null, width: number): CSSProperties | undefined {
  if (!anchor || typeof window === 'undefined') {
    return undefined;
  }
  const margin = 8;
  const left = Math.min(Math.max(anchor.left, margin), Math.max(margin, window.innerWidth - width - margin));
  return {
    left,
    bottom: Math.max(margin, window.innerHeight - anchor.top + 6),
    width: `min(${width}px, calc(100vw - ${margin * 2}px))`,
  };
}

function popdownStyle(anchor: PopoverAnchor | null, width: number): CSSProperties | undefined {
  if (!anchor || typeof window === 'undefined') {
    return undefined;
  }
  const margin = 8;
  const preferredLeft = anchor.left + anchor.width - width;
  const left = Math.min(Math.max(preferredLeft, margin), Math.max(margin, window.innerWidth - width - margin));
  const top = Math.min(Math.max(anchor.top + 6, margin), Math.max(margin, window.innerHeight - 130));
  return {
    left,
    top,
    width: `min(${width}px, calc(100vw - ${margin * 2}px))`,
  };
}

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
    throw await ApiRequestError.fromResponse(response);
  }
  return response.json() as Promise<T>;
}

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly reconnectRequired = false,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  static async fromResponse(response: Response): Promise<ApiRequestError> {
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as { error?: unknown; code?: unknown; reconnectRequired?: unknown };
      return new ApiRequestError(
        typeof payload.error === 'string' && payload.error.trim() ? payload.error : response.statusText,
        response.status,
        typeof payload.code === 'string' ? payload.code : undefined,
        Boolean(payload.reconnectRequired),
      );
    } catch {
      return new ApiRequestError(text || response.statusText, response.status);
    }
  }
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

function buildOptimisticTimelineDocument(
  document: AxcutDocument,
  intervals: Array<{ startSec: number; endSec: number }>,
  reason: string,
): AxcutDocument {
  const assetId = document.project.primaryAssetId ?? document.assets[0]?.id;
  if (!assetId) {
    return document;
  }
  const asset = document.assets.find((item) => item.id === assetId);
  const normalized = normalizeTimelineIntervals(asset?.durationSec ?? 0, intervals);
  return {
    ...document,
    project: {
      ...document.project,
      updatedAt: new Date().toISOString(),
    },
    timeline: {
      ...document.timeline,
      clips: buildOptimisticClips(document, assetId, normalized, reason),
      gaps: [],
    },
    preview: {
      ...document.preview,
      revision: document.preview.revision + 1,
    },
  };
}

function normalizeTimelineIntervals(durationSec: number, intervals: Array<{ startSec: number; endSec: number }>): Array<{ startSec: number; endSec: number }> {
  const bounded = intervals
    .map((interval) => ({
      startSec: Math.max(0, Math.min(durationSec, interval.startSec)),
      endSec: Math.max(0, Math.min(durationSec, interval.endSec)),
    }))
    .filter((interval) => interval.endSec > interval.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const merged: Array<{ startSec: number; endSec: number }> = [];
  for (const interval of bounded) {
    const previous = merged.at(-1);
    if (!previous || interval.startSec > previous.endSec) {
      merged.push({ ...interval });
      continue;
    }
    previous.endSec = Math.max(previous.endSec, interval.endSec);
  }
  return merged;
}

function buildOptimisticClips(
  document: AxcutDocument,
  assetId: string,
  intervals: Array<{ startSec: number; endSec: number }>,
  reason: string,
): AxcutClip[] {
  let cursor = 0;
  return intervals.map((interval, index) => {
    const duration = interval.endSec - interval.startSec;
    const clip: AxcutClip = {
      id: `clip_${index + 1}`,
      assetId,
      sourceStartSec: interval.startSec,
      sourceEndSec: interval.endSec,
      timelineStartSec: cursor,
      timelineEndSec: cursor + duration,
      wordRefs: collectOptimisticWordRefs(document, interval.startSec, interval.endSec),
      origin: 'user',
      reason,
    };
    cursor = clip.timelineEndSec;
    return clip;
  });
}

function collectOptimisticWordRefs(document: AxcutDocument, startSec: number, endSec: number): string[] {
  return document.transcript?.words
    .filter((word) => word.endSec > startSec && word.startSec < endSec)
    .map((word) => word.id) ?? [];
}

function applyPendingTimelineEdit(snapshot: ProjectSnapshot, pendingEdit: PendingTimelineEdit | null): ProjectSnapshot {
  if (!pendingEdit || snapshot.document.project.id !== pendingEdit.projectId) {
    return snapshot;
  }
  return {
    ...snapshot,
    document: buildOptimisticTimelineDocument(snapshot.document, pendingEdit.intervals, pendingEdit.reason),
  };
}

function getSttStatus(document: AxcutDocument | undefined, jobs: JobSummary[] | undefined) {
  const sttJob = jobs?.find((job) => job.kind === 'transcribe_asset' || job.kind === 'ingest_asset') ?? null;
  if (!document?.assets.length) {
    return { label: 'Transcription idle', detail: 'Load a video to start transcription.', progress: 0, tone: 'idle' as const };
  }
  if (sttJob?.status === 'queued' || sttJob?.status === 'running') {
    const inSttPhase = sttJob.kind === 'transcribe_asset' || sttJob.progress >= 0.7 || /transcrib/i.test(sttJob.message);
    return {
      label: inSttPhase ? 'Transcription running' : 'Preparing transcription',
      detail: sttJob.message,
      progress: Math.max(0, Math.min(1, sttJob.progress)),
      tone: 'running' as const,
    };
  }
  if (sttJob?.status === 'failed') {
    return { label: 'Transcription failed', detail: sttJob.message, progress: sttJob.progress, tone: 'error' as const };
  }
  if (document.transcript) {
    return { label: 'Transcription complete', detail: `${document.transcript.segments.length} segments · ${document.transcript.words.length} words · ${document.transcript.language}`, progress: 1, tone: 'ready' as const };
  }
  if (!sttJob) {
    return { label: 'Transcription waiting', detail: 'Waiting for ingest job.', progress: 0, tone: 'idle' as const };
  }
  return { label: 'Transcription waiting', detail: sttJob.message, progress: sttJob.progress, tone: 'idle' as const };
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

function LiveRunFeed({ state }: { state: LiveRunState }) {
  const hasContent = state.active || state.thinking || state.assistantDraft || state.operations.length > 0 || state.compactions.length > 0;
  if (!hasContent) {
    return null;
  }

  return (
    <div className="live-run-feed" aria-live="polite">
      {state.thinking ? (
        <article className="message live-entry thinking">
          <div className="live-entry-head">
            <span className="live-entry-title"><Brain size={15} aria-hidden="true" /> Thinking</span>
          </div>
          <p>{state.thinking}</p>
        </article>
      ) : null}
      {state.operations.map((operation) => (
        <LiveOperationCard key={operation.operationId} operation={operation} />
      ))}
      {state.compactions.map((compaction, index) => (
        <article key={`${compaction.summary}-${index}`} className="message live-entry compaction">
          <div className="live-entry-head">
            <span className="live-entry-title"><Brain size={15} aria-hidden="true" /> Context compacted</span>
            <span className="muted">{compaction.source}</span>
          </div>
          <p>{compaction.summary}</p>
        </article>
      ))}
      {state.assistantDraft ? (
        <article className="message assistant streaming">
          <div className="message-meta">
            <strong className="message-role assistant">{displayMessageRole('assistant')}</strong>
            <span className="muted">streaming</span>
          </div>
          <p>{state.assistantDraft}</p>
        </article>
      ) : null}
      {state.active ? <RunIndicator /> : null}
    </div>
  );
}

function LiveOperationCard({ operation }: { operation: LiveOperation }) {
  const Icon = operation.category === 'thinking'
    ? Brain
    : operation.category === 'shell'
      ? Terminal
      : Wrench;
  const statusLabel = operation.status === 'running' ? 'Running' : operation.status === 'done' ? 'Done' : 'Error';
  return (
    <article className={`message live-entry operation ${operation.status}`}>
      <div className="live-entry-head">
        <span className="live-entry-title"><Icon size={15} aria-hidden="true" /> {operation.label}</span>
        <span className={`live-entry-status ${operation.status}`}>{statusLabel}</span>
      </div>
      {operation.summary ? <p className="muted">{operation.summary}</p> : null}
      {operation.body ? (
        <details className="details">
          <summary>Show details</summary>
          <pre className="details-body">{operation.body}</pre>
        </details>
      ) : null}
    </article>
  );
}

function RunIndicator() {
  return (
    <div className="run-indicator active" aria-label="Agent running" title="Agent running">
      <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
    </div>
  );
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
      'agent.checkpoint.saved',
      'agent.checkpoint.restored',
      'agent.checkpoint.deleted',
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
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerInitialScreen, setProviderInitialScreen] = useState<'models' | 'providers' | 'settings' | 'provider-form'>('models');
  const [providerAnchor, setProviderAnchor] = useState<PopoverAnchor | null>(null);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [reasoningAnchor, setReasoningAnchor] = useState<PopoverAnchor | null>(null);
  const [rewindConfirmation, setRewindConfirmation] = useState<{ messageId: string; anchor: PopoverAnchor } | null>(null);
  const [loadVideoOpen, setLoadVideoOpen] = useState(false);
  const [transcriptModal, setTranscriptModal] = useState<'source' | 'edited' | null>(null);
  const [transcriptLanguage, setTranscriptLanguage] = useState<TranscriptLanguageSelection>('auto');
  const [virtualTimeSec, setVirtualTimeSec] = useState(0);
  const [seekTarget, setSeekTarget] = useState<{ timeSec: number; requestId: number } | null>(null);
  const [sourcePreviewTarget, setSourcePreviewTarget] = useState<{ sourceTimeSec: number; requestId: number } | null>(null);
  const [liveRun, setLiveRun] = useState<LiveRunState>(emptyLiveRunState);
  const [autoScrollMessages, setAutoScrollMessages] = useState(true);
  const [chatPanelWidth, setChatPanelWidth] = useState(() => readStoredNumber(CHAT_WIDTH_STORAGE_KEY, DEFAULT_CHAT_WIDTH));
  const [timelinePanelHeight, setTimelinePanelHeight] = useState(() => readStoredNumber(TIMELINE_HEIGHT_STORAGE_KEY, DEFAULT_TIMELINE_HEIGHT));
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const providerButtonRef = useRef<HTMLButtonElement | null>(null);
  const reasoningButtonRef = useRef<HTMLButtonElement | null>(null);
  const replaceTimelineRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const pendingTimelineEditRef = useRef<PendingTimelineEdit | null>(null);

  const layoutStyle = useMemo(() => ({
    '--chat-panel-width': `${chatPanelWidth}px`,
    '--timeline-panel-height': `${timelinePanelHeight}px`,
  }) as CSSProperties, [chatPanelWidth, timelinePanelHeight]);

  const startChatResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 980) {
      return;
    }
    event.preventDefault();
    const shell = event.currentTarget.closest<HTMLElement>('.app-shell');
    if (!shell) {
      return;
    }
    const rect = shell.getBoundingClientRect();
    let nextWidth = chatPanelWidth;
    const update = (clientX: number) => {
      const maxWidth = Math.max(320, rect.width - 430);
      nextWidth = Math.round(clamp(clientX - rect.left, 320, maxWidth));
      setChatPanelWidth(nextWidth);
    };
    const onMove = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const onUp = () => {
      window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(nextWidth));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      globalThis.document.body.classList.remove('resizing-chat');
    };
    globalThis.document.body.classList.add('resizing-chat');
    update(event.clientX);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [chatPanelWidth]);

  const startTimelineResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 980) {
      return;
    }
    event.preventDefault();
    const shell = event.currentTarget.closest<HTMLElement>('.app-shell');
    if (!shell) {
      return;
    }
    const rect = shell.getBoundingClientRect();
    let nextHeight = timelinePanelHeight;
    const update = (clientY: number) => {
      const maxHeight = Math.max(120, rect.height - 340);
      nextHeight = Math.round(clamp(rect.bottom - clientY, 120, maxHeight));
      setTimelinePanelHeight(nextHeight);
    };
    const onMove = (moveEvent: PointerEvent) => update(moveEvent.clientY);
    const onUp = () => {
      window.localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, String(nextHeight));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      globalThis.document.body.classList.remove('resizing-timeline');
    };
    globalThis.document.body.classList.add('resizing-timeline');
    update(event.clientY);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [timelinePanelHeight]);

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
      const pendingEdit = pendingTimelineEditRef.current;
      return requestJson<ProjectSnapshot>(`/api/projects/${projectId}${sessionQueryPart}`, {
        headers: authHeaders(sessionToken!),
      }).then((snapshot) => applyPendingTimelineEdit(snapshot, pendingEdit));
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
    if (pendingTimelineEditRef.current?.projectId === projectId) {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  }, [projectId, queryClient]);

  const handleProjectEvent = useCallback((event: ProjectStreamEvent) => {
    if (event.type.startsWith('agent.')) {
      setLiveRun((current) => reduceLiveRunState(current, event));
      if (event.type === 'agent.message.user') {
        setAutoScrollMessages(true);
      }
    }
    if (!event.type.startsWith('agent.message.delta') && !event.type.startsWith('agent.thinking.delta') && event.type !== 'agent.operation') {
      invalidateProject();
    }
    if (event.type === 'project.transcript.updated') {
      void queryClient.invalidateQueries({ queryKey: ['source-transcript'] });
    }
  }, [invalidateProject, queryClient]);

  useProjectEvents(projectId, sessionToken, handleProjectEvent);

  const isMessagesNearBottom = useCallback(() => {
    const element = messagesRef.current;
    if (!element) {
      return true;
    }
    return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
  }, []);

  const handleMessagesScroll = useCallback(() => {
    setAutoScrollMessages(isMessagesNearBottom());
    setRewindConfirmation(null);
  }, [isMessagesNearBottom]);

  useEffect(() => {
    if (!autoScrollMessages) {
      return;
    }
    const element = messagesRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [autoScrollMessages, liveRun, snapshotQuery.data?.messages.length]);

  useEffect(() => {
    if (!rewindConfirmation) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-rewind-confirmation="true"], [data-rewind-trigger="true"]')) {
        return;
      }
      setRewindConfirmation(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setRewindConfirmation(null);
      }
    };
    globalThis.document.addEventListener('pointerdown', handlePointerDown);
    globalThis.document.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.document.removeEventListener('pointerdown', handlePointerDown);
      globalThis.document.removeEventListener('keydown', handleKeyDown);
    };
  }, [rewindConfirmation]);

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
    mutationFn: async (text: string) => {
      if (!projectId || !sessionToken) {
        throw new Error('No active project.');
      }
      return requestJson(`/api/projects/${projectId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ sessionId: activeSessionId ?? undefined, message: text }),
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      invalidateProject();
    },
  });

  const rewindMessage = useMutation({
    mutationFn: async (messageId: string) => {
      if (!projectId || !sessionToken || !activeSessionId) {
        throw new Error('No active conversation.');
      }
      return requestJson<{ prompt: string; snapshot: ProjectSnapshot }>(`/api/projects/${projectId}/sessions/${activeSessionId}/messages/${messageId}/rewind`, {
        method: 'POST',
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async (result) => {
      setLiveRun(emptyLiveRunState);
      setMessage(result.prompt);
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const replaceTimeline = useMutation({
    mutationFn: async (input: ReplaceTimelineInput) => {
      if (!sessionToken) {
        throw new Error('No active conversation.');
      }
      return requestJson<ReplaceTimelineResult>(`/api/projects/${input.projectId}/operations`, {
        method: 'POST',
        body: JSON.stringify({
          sessionId: input.sessionId,
          conversationMessage: `Timeline edit: ${input.reason}`,
          operation: {
            type: 'replace_timeline',
            reason: input.reason,
            intervals: input.intervals,
          },
        }),
        headers: authHeaders(sessionToken),
        signal: input.controller.signal,
      });
    },
    onMutate: async (input) => {
      const pendingEdit: PendingTimelineEdit = {
        requestId: input.requestId,
        projectId: input.projectId,
        intervals: input.intervals,
        reason: input.reason,
      };
      pendingTimelineEditRef.current = pendingEdit;
      await queryClient.cancelQueries({ queryKey: ['project', input.projectId] });
      const previousSnapshots = queryClient.getQueriesData<ProjectSnapshot>({ queryKey: ['project', input.projectId] });
      queryClient.setQueriesData<ProjectSnapshot>({ queryKey: ['project', input.projectId] }, (current) => (
        current ? applyPendingTimelineEdit(current, pendingEdit) : current
      ));
      return { requestId: input.requestId, projectId: input.projectId, previousSnapshots };
    },
    onError: async (error, _input, context) => {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      if (!context || context.requestId !== replaceTimelineRequestRef.current?.id) {
        return;
      }
      await queryClient.cancelQueries({ queryKey: ['project', context.projectId] });
      pendingTimelineEditRef.current = null;
      replaceTimelineRequestRef.current = null;
      for (const [queryKey, snapshot] of context.previousSnapshots) {
        queryClient.setQueryData(queryKey, snapshot);
      }
    },
    onSuccess: async (result, _input, context) => {
      if (context.requestId !== replaceTimelineRequestRef.current?.id) {
        return;
      }
      await queryClient.cancelQueries({ queryKey: ['project', context.projectId] });
      if ('aborted' in result && result.aborted) {
        pendingTimelineEditRef.current = null;
        replaceTimelineRequestRef.current = null;
        for (const [queryKey, snapshot] of context.previousSnapshots) {
          queryClient.setQueryData(queryKey, snapshot);
        }
        return;
      }
      queryClient.setQueriesData<ProjectSnapshot>({ queryKey: ['project', context.projectId] }, (current) => {
        if (!current) {
          return current;
        }
        const message = result.message;
        const shouldAppendMessage = Boolean(
          message
          && current.activeSessionId === message.sessionId
          && !current.messages.some((item) => item.id === message.id),
        );
        return {
          ...current,
          document: result.document,
          messages: shouldAppendMessage && message ? [...current.messages, message] : current.messages,
        };
      });
      pendingTimelineEditRef.current = null;
      replaceTimelineRequestRef.current = null;
      setAutoScrollMessages(true);
      await queryClient.invalidateQueries({ queryKey: ['project', context.projectId] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const queueReplaceTimeline = useCallback((intervals: Array<{ startSec: number; endSec: number }>, reason: string) => {
    if (!projectId || !activeSessionId) {
      return;
    }
    replaceTimelineRequestRef.current?.controller.abort();
    const requestId = (replaceTimelineRequestRef.current?.id ?? 0) + 1;
    const controller = new AbortController();
    replaceTimelineRequestRef.current = { id: requestId, controller };
    pendingTimelineEditRef.current = {
      requestId,
      projectId,
      intervals,
      reason,
    };
    replaceTimeline.mutate({
      requestId,
      projectId,
      sessionId: activeSessionId,
      intervals,
      reason,
      controller,
    });
  }, [activeSessionId, projectId, replaceTimeline]);

  const compactContext = useMutation({
    mutationFn: async () => {
      if (!projectId || !sessionToken || !activeSessionId) {
        throw new Error('No active conversation.');
      }
      return requestJson<{ snapshot: ProjectSnapshot }>(`/api/projects/${projectId}/sessions/${activeSessionId}/compact`, {
        method: 'POST',
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      setLiveRun(emptyLiveRunState);
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const createWorktree = useMutation({
    mutationFn: async () => {
      if (!projectId || !sessionToken || !activeSessionId) {
        throw new Error('No active conversation.');
      }
      return requestJson<{ snapshot: ProjectSnapshot }>(`/api/projects/${projectId}/sessions/${activeSessionId}/worktrees`, {
        method: 'POST',
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const selectWorktree = useMutation({
    mutationFn: async (path: string | null) => {
      if (!projectId || !sessionToken || !activeSessionId) {
        throw new Error('No active conversation.');
      }
      return requestJson<{ snapshot: ProjectSnapshot }>(`/api/projects/${projectId}/sessions/${activeSessionId}/worktrees/select`, {
        method: 'POST',
        body: JSON.stringify({ path: path ?? '' }),
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const removeWorktree = useMutation({
    mutationFn: async (path: string) => {
      if (!projectId || !sessionToken || !activeSessionId) {
        throw new Error('No active conversation.');
      }
      return requestJson<{ snapshot: ProjectSnapshot }>(`/api/projects/${projectId}/sessions/${activeSessionId}/worktrees`, {
        method: 'DELETE',
        body: JSON.stringify({ path }),
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const updateReasoning = useMutation({
    mutationFn: async (reasoningEffort: ReasoningEffort) => {
      const effective = llmConfigQuery.data?.effective;
      if (!sessionToken || !effective?.provider || !effective.model) {
        throw new Error('No configured model.');
      }
      return requestJson(`/api/llm/providers/${effective.provider}/select`, {
        method: 'POST',
        body: JSON.stringify({
          model: effective.model,
          baseUrl: effective.baseUrl || undefined,
          reasoningEffort,
        }),
        headers: authHeaders(sessionToken),
      });
    },
    onSuccess: async () => {
      setReasoningOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['llm-config'] });
    },
  });

  const submitChat = useCallback(() => {
    const text = message.trim();
    if (!text || sendChat.isPending) {
      return;
    }
    setMessage('');
    sendChat.mutate(text);
  }, [message, sendChat]);

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
  const contextUsage = snapshot?.contextUsage;
  const activeWorktreeLabel = snapshot?.activeWorktree?.branch?.replace(/^refs\/heads\//, '') || artifactName(snapshot?.activeWorktree?.path);
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
  const latestExportJob = snapshot?.jobs.find((job) => job.kind === 'export') ?? null;
  const exportJobResult = parseJobResult(latestExportJob);
  const exportArtifactName = artifactName(typeof exportJobResult?.outputPath === 'string' ? exportJobResult.outputPath : undefined);
  const exportHref = projectId && sessionToken && latestExportJob?.status === 'completed' && exportArtifactName
    ? `/api/projects/${projectId}/artifacts/${encodeURIComponent(exportArtifactName)}?token=${encodeURIComponent(sessionToken)}`
    : null;
  const exportBusy = exportVideo.isPending || latestExportJob?.status === 'queued' || latestExportJob?.status === 'running';
  const exportStatus = getExportStatus(latestExportJob, exportVideo.isPending, exportVideo.error);
  const effectiveLlm = llmConfigQuery.data?.effective;
  const providerLabel = llmConfigQuery.data?.ready && effectiveLlm
    ? [
        effectiveLlm.provider || effectiveLlm.providerLabel,
        effectiveLlm.model,
      ].filter(Boolean).join(' / ')
    : 'LLM not configured';
  const agentResponsePending = sendChat.isPending && liveRun.active && !liveRun.assistantDraft;
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
    <div className="app-shell" style={layoutStyle}>
      <aside className="left-rail panel">
        <header className="chat-header">
          <div className="chat-title-block">
            <h1 className="app-title">
              <img src="/assets/logo_mascot_128.png" alt="" />
              <span>Axcut</span>
              <span className="title-separator muted">-</span>
              <span className="chat-session-title muted" title={activeSession?.title ?? 'New conversation'}>
                {activeSession?.title ?? 'New conversation'}
              </span>
            </h1>
          </div>
          <div className="header-actions">
            {contextUsage ? (
              <span className="context-pill" title={`${contextUsage.promptTokens} estimated prompt tokens of ${contextUsage.contextWindowTokens}`}>
                {contextUsage.fillPercent}% context
              </span>
            ) : null}
            {activeWorktreeLabel ? (
              <button className="worktree-pill active" onClick={() => setWorktreeOpen(true)} type="button" title={snapshot?.activeWorktree?.path}>
                <GitBranch size={14} aria-hidden="true" />
                <span>{activeWorktreeLabel}</span>
              </button>
            ) : null}
            <IconButton icon={GitBranch} label="Worktrees" className="secondary" onClick={() => setWorktreeOpen(true)} disabled={!projectId || !activeSessionId} />
            <IconButton icon={Brain} label="Compact context" className="secondary" onClick={() => compactContext.mutate()} disabled={!activeSessionId || compactContext.isPending || sendChat.isPending} />
            <IconButton
              icon={Settings}
              label="Settings"
              className="secondary"
              onClick={() => {
                setProviderInitialScreen('settings');
                setProviderAnchor(null);
                setReasoningOpen(false);
                setProviderOpen(true);
              }}
            />
            <IconButton icon={History} label="History" className="secondary" onClick={() => setHistoryOpen(true)} disabled={!projectId} />
            <IconButton icon={MessageSquarePlus} label="New chat" onClick={() => createSession.mutate()} disabled={!projectId || createSession.isPending} />
          </div>
        </header>

        <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
          {snapshot?.messages.length ? snapshot.messages.map((item) => (
            <div key={item.id} className={`message-group ${item.role}`}>
              <article className={`message ${item.role}`}>
                <div className="message-meta">
                  <strong className={`message-role ${item.role}`}>{displayMessageRole(item.role)}</strong>
                  <span className="muted">{new Date(item.createdAt).toLocaleTimeString()}</span>
                </div>
                <p>{item.content}</p>
              </article>
              <div className="message-actions">
                {item.role === 'user' && item.checkpointId ? (
                  <IconButton
                    icon={ArrowLeft}
                    label="Rewind to before this message"
                    className="secondary"
                    data-rewind-trigger="true"
                    aria-expanded={rewindConfirmation?.messageId === item.id}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setRewindConfirmation({
                        messageId: item.id,
                        anchor: {
                          left: rect.left,
                          top: rect.bottom,
                          width: rect.width,
                        },
                      });
                    }}
                    disabled={sendChat.isPending || rewindMessage.isPending}
                  />
                ) : null}
                <IconButton icon={Copy} label="Copy message" className="secondary" onClick={() => void navigator.clipboard.writeText(item.content)} />
              </div>
            </div>
          )) : (
            <div className="message-empty muted">
              {projectId ? 'No messages in this conversation yet.' : 'Start the server with AXCUT_VIDEO_PATH set to a local video file.'}
            </div>
          )}
          {rewindConfirmation ? (
            <div
              className="confirm-popover rewind-confirm-popover"
              data-rewind-confirmation="true"
              role="dialog"
              aria-label="Confirm rewind"
              style={popdownStyle(rewindConfirmation.anchor, 260)}
            >
              <strong>Rewind here?</strong>
              <p className="muted">Project, conversation, and agent state will be restored.</p>
              <div className="confirm-popover-actions">
                <button type="button" className="secondary" onClick={() => setRewindConfirmation(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const messageId = rewindConfirmation.messageId;
                    setRewindConfirmation(null);
                    rewindMessage.mutate(messageId);
                  }}
                  disabled={sendChat.isPending || rewindMessage.isPending}
                >
                  Rewind
                </button>
              </div>
            </div>
          ) : null}
          <LiveRunFeed state={liveRun} />
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            submitChat();
          }}
        >
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && message.trim()) {
                event.preventDefault();
                submitChat();
              }
            }}
            rows={2}
            placeholder="Describe the edit you want."
          />
          <div className="composer-footer">
            <button
              ref={providerButtonRef}
              type="button"
              className={llmConfigQuery.data?.ready ? 'provider-pill compact ready' : 'provider-pill compact'}
              onClick={() => {
                setProviderInitialScreen(llmConfigQuery.data?.ready ? 'models' : 'providers');
                const rect = providerButtonRef.current?.getBoundingClientRect();
                setProviderAnchor(rect ? { left: rect.left, top: rect.top, width: rect.width } : null);
                setReasoningOpen(false);
                setProviderOpen(true);
              }}
            >
              <SlidersHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
              <span>{providerLabel}</span>
            </button>
            {llmConfigQuery.data?.ready && effectiveLlm?.supportsReasoningEffort ? (
              <button
                ref={reasoningButtonRef}
                type="button"
                className="reasoning-pill"
                onClick={() => {
                  const rect = reasoningButtonRef.current?.getBoundingClientRect();
                  setReasoningAnchor(rect ? { left: rect.left, top: rect.top, width: rect.width } : null);
                  setProviderOpen(false);
                  setReasoningOpen(true);
                }}
                disabled={updateReasoning.isPending}
                aria-label="Reasoning effort"
              >
                Reasoning {effectiveLlm.reasoningEffort || 'medium'}
              </button>
            ) : null}
            {reasoningOpen && effectiveLlm?.supportsReasoningEffort ? (
              <ReasoningPopover
                anchor={reasoningAnchor}
                selected={effectiveLlm.reasoningEffort || 'medium'}
                busy={updateReasoning.isPending}
                onClose={() => setReasoningOpen(false)}
                onSelect={(nextReasoning) => updateReasoning.mutate(nextReasoning)}
              />
            ) : null}
            {agentResponsePending ? <span className="muted">Waiting for the agent response...</span> : null}
            <IconButton
              type="submit"
              icon={SendHorizontal}
              label={sendChat.isPending ? 'Working' : 'Send'}
              disabled={!projectId || !sessionToken || !llmConfigQuery.data?.ready || !message.trim() || sendChat.isPending}
            />
          </div>
          {sendChat.isError ? <p className="error-copy">{sendChat.error instanceof Error ? sendChat.error.message : 'Chat request failed.'}</p> : null}
        </form>
      </aside>

      <div
        className="chat-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        onPointerDown={startChatResize}
      />

      <main className="preview-pane panel">
        <div className="preview-header">
          <div>
            <h2>{document?.project.title ?? 'Video Preview'}</h2>
          </div>
          <div className="preview-actions">
            <div className="preview-statuses">
              <StatusChip label={sttStatus.label} detail={sttStatus.detail} tone={sttStatus.tone} />
              {exportStatus ? <StatusChip label={exportStatus.label} detail={exportStatus.detail} tone={exportStatus.tone} href={exportHref} /> : null}
            </div>
            <div className="preview-project-controls">
              {projectCount > 1 ? (
                <select
                  className="project-select"
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
                <div className="project-title-pill compact">
                  <span className="muted">Project</span>
                  <strong>{document?.project.title ?? 'No video loaded'}</strong>
                </div>
              )}
              <IconButton icon={FolderOpen} label="Load video" className="secondary" onClick={() => setLoadVideoOpen(true)} />
            </div>
            <IconButton icon={FileText} label="Source transcript" className="secondary" onClick={() => setTranscriptModal('source')} disabled={!sourceTranscriptName} />
            <IconButton icon={Eye} label="Timeline transcript" className="secondary" onClick={() => setTranscriptModal('edited')} disabled={!document?.transcript} />
            <IconButton icon={Download} label={exportBusy ? 'Exporting' : 'Export'} onClick={() => exportVideo.mutate()} disabled={!document?.timeline.clips.length || !sessionToken || exportBusy} />
          </div>
        </div>

        {document ? (
          <VirtualPreview
            videoSources={videoSources}
            clips={document.timeline.clips}
            revision={document.preview.revision}
            seekTarget={seekTarget}
            sourcePreviewTarget={sourcePreviewTarget}
            onTimeChange={setVirtualTimeSec}
          />
        ) : (
          <div className="video placeholder">No video configured.</div>
        )}
      </main>

      <div
        className="timeline-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline panel"
        onPointerDown={startTimelineResize}
      />

      <TimelinePane
        clips={document?.timeline.clips ?? []}
        currentTimeSec={virtualTimeSec}
        sourceDurationSec={primaryAsset?.durationSec ?? 0}
        busy={!activeSessionId || sendChat.isPending}
        onSeek={(timeSec) => setSeekTarget({ timeSec, requestId: Date.now() })}
        onPreviewSource={(sourceTimeSec) => setSourcePreviewTarget({ sourceTimeSec, requestId: Date.now() })}
        onReplaceTimeline={queueReplaceTimeline}
      />

      {historyOpen ? (
        <SessionHistoryDialog
          sessions={snapshot?.sessions ?? []}
          activeSessionId={snapshot?.activeSessionId ?? activeSessionId}
          busy={createSession.isPending || deleteSession.isPending || renameSession.isPending}
          onClose={() => setHistoryOpen(false)}
          onSelect={(sessionId) => {
            setActiveSessionId(sessionId);
            setHistoryOpen(false);
          }}
          onDelete={(sessionId) => deleteSession.mutate(sessionId)}
          onRename={(sessionId, title) => renameSession.mutate({ sessionId, title })}
        />
      ) : null}

      {worktreeOpen ? (
        <WorktreeDialog
          activeWorktree={snapshot?.activeWorktree}
          worktrees={snapshot?.availableWorktrees ?? []}
          busy={createWorktree.isPending || selectWorktree.isPending || removeWorktree.isPending}
          onClose={() => setWorktreeOpen(false)}
          onCreate={() => createWorktree.mutate()}
          onSelect={(worktreePath) => selectWorktree.mutate(worktreePath)}
          onRemove={(worktreePath) => removeWorktree.mutate(worktreePath)}
        />
      ) : null}

      {providerOpen ? (
        <ProviderSettingsDialog
          snapshot={llmConfigQuery.data}
          sessionToken={sessionToken}
          initialScreen={providerInitialScreen}
          anchor={providerAnchor}
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
          title={transcriptModal === 'source' ? 'Source Transcript' : 'Timeline Transcript'}
          subtitle={transcriptModal === 'source'
            ? sourceTranscriptName ?? 'No transcript artifact available yet.'
            : 'Reconstructed from the current timeline clips using source word timestamps.'}
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

function StatusChip({ label, detail, tone, href }: { label: string; detail: string; tone: 'idle' | 'running' | 'ready' | 'error'; href?: string | null }) {
  return (
    <div className={`status-chip ${tone}`} title={detail} aria-label={`${label}: ${detail}`}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-chip-copy">
        <strong>{label}</strong>
        <span className="muted">{detail}</span>
      </span>
      {href ? (
        <a className="export-download" href={href} download title="Download MP4" aria-label="Download MP4">
          <Download size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>MP4</span>
        </a>
      ) : null}
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
          <IconButton icon={X} label="Close" className="secondary" onClick={onClose} />
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
            <IconButton icon={RefreshCw} label={regenerating ? 'Regenerating' : regenerateLabel ?? 'Regenerate transcript'} onClick={onRegenerate} disabled={regenerating} />
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
  onSelect,
  onDelete,
  onRename,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  busy: boolean;
  onClose: () => void;
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
            <p className="muted">Switch sessions or manage existing conversations.</p>
          </div>
          <IconButton icon={X} label="Close" className="secondary" onClick={onClose} />
        </div>
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
                  <IconButton icon={Check} label="Save" disabled={busy || !editingTitle.trim()} />
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
                    <IconButton
                      icon={Pencil}
                      label="Rename"
                      className="secondary"
                      onClick={() => {
                        setEditingId(session.id);
                        setEditingTitle(session.title);
                      }}
                      disabled={busy}
                    />
                    <IconButton icon={Trash2} label="Delete" className="danger" onClick={() => onDelete(session.id)} disabled={busy || sessions.length <= 1} />
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
          <IconButton icon={X} label="Close" className="secondary" onClick={onClose} />
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
          <IconButton icon={Upload} label={busy ? 'Loading video' : 'Create project and ingest'} disabled={busy || !path.trim()} />
        </form>
      </section>
    </div>
  );
}

function ReasoningPopover({
  anchor,
  selected,
  busy,
  onClose,
  onSelect,
}: {
  anchor: PopoverAnchor | null;
  selected: ReasoningEffort;
  busy: boolean;
  onClose: () => void;
  onSelect: (reasoningEffort: ReasoningEffort) => void;
}) {
  return (
    <div
      className="llm-popover-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="llm-popover reasoning-popover" style={popoverStyle(anchor, 240)}>
        <div className="llm-popover-header">
          <strong>Reasoning</strong>
        </div>
        <div className="reasoning-option-list">
          {reasoningEffortOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              className={option.value === selected ? 'model-option active' : 'model-option'}
              onClick={() => onSelect(option.value)}
              disabled={busy}
            >
              <span>
                <strong>{option.label}</strong>
                <small className="muted">Reasoning effort</small>
              </span>
              {option.value === selected ? <span className="muted">Active</span> : null}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function WorktreeDialog({
  activeWorktree,
  worktrees,
  busy,
  onClose,
  onCreate,
  onSelect,
  onRemove,
}: {
  activeWorktree?: WorktreeInfo;
  worktrees: WorktreeInfo[];
  busy: boolean;
  onClose: () => void;
  onCreate: () => void;
  onSelect: (path: string | null) => void;
  onRemove: (path: string) => void;
}) {
  const activePath = activeWorktree?.path;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal panel history-modal">
        <div className="modal-header">
          <div>
            <h2>Worktrees</h2>
            <p className="muted">Use an isolated branch for agent changes.</p>
          </div>
          <div className="header-actions">
            <IconButton icon={GitBranch} label="Create worktree" onClick={onCreate} disabled={busy}>Create</IconButton>
            <IconButton icon={X} label="Close" className="secondary" onClick={onClose} />
          </div>
        </div>
        <div className="session-list">
          <article className={!activePath ? 'session-item active' : 'session-item'}>
            <button className="session-main" onClick={() => onSelect(null)} disabled={busy}>
              <strong>Main workspace</strong>
              <span className="muted">Use the current repository checkout.</span>
            </button>
            <div className="session-actions">{!activePath ? <span className="status-pill ready">Active</span> : null}</div>
          </article>
          {worktrees.map((worktree) => {
            const branch = worktree.branch?.replace(/^refs\/heads\//, '') || artifactName(worktree.path) || 'worktree';
            const isActive = activePath === worktree.path;
            return (
              <article key={worktree.path} className={isActive ? 'session-item active' : 'session-item'}>
                <button className="session-main" onClick={() => onSelect(worktree.path)} disabled={busy}>
                  <strong>{branch}</strong>
                  <span className="muted">{worktree.path}</span>
                </button>
                <div className="session-actions">
                  {isActive ? <span className="status-pill ready">Active</span> : null}
                  {worktree.locked ? <span className="status-pill">Locked</span> : null}
                  <IconButton icon={Trash2} label="Remove" className="danger" onClick={() => onRemove(worktree.path)} disabled={busy || worktree.locked} />
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ProviderSettingsDialog({
  snapshot,
  sessionToken,
  initialScreen,
  anchor,
  onClose,
  onChanged,
}: {
  snapshot?: LlmStatus;
  sessionToken?: string;
  initialScreen?: 'models' | 'providers' | 'settings' | 'provider-form' | 'provider-create-select';
  anchor: PopoverAnchor | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [screen, setScreen] = useState<'models' | 'providers' | 'settings' | 'provider-form' | 'provider-create-select'>(initialScreen ?? 'models');
  const [surface, setSurface] = useState<'popover' | 'modal'>(initialScreen === 'settings' || initialScreen === 'provider-form' ? 'modal' : 'popover');
  const [providerId, setProviderId] = useState(snapshot?.effective.provider ?? snapshot?.connectedProviders[0]?.id ?? snapshot?.providers[0]?.id ?? 'openai');
  const activeProvider = snapshot?.providers.find((provider) => provider.id === providerId) ?? snapshot?.providers[0];
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(activeProvider?.model || '');
  const [baseUrl, setBaseUrl] = useState(activeProvider?.baseUrl || activeProvider?.defaultBaseUrl || '');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(activeProvider?.reasoningEffort || snapshot?.effective.reasoningEffort || 'medium');
  const [models, setModels] = useState<string[]>([]);
  const [challenge, setChallenge] = useState<DeviceChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [completingAuth, setCompletingAuth] = useState(false);
  const [copiedAuthCode, setCopiedAuthCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [providerFormMode, setProviderFormMode] = useState<'create' | 'edit'>('edit');
  const [modelSearch, setModelSearch] = useState('');
  const connectedProviders = snapshot?.connectedProviders ?? [];
  const addableProviders = snapshot?.providers.filter((provider) => !provider.connected) ?? [];
  const providerCreateOptions = addableProviders.length ? addableProviders : (snapshot?.providers ?? []);

  useEffect(() => {
    setModel(activeProvider?.model || '');
    setBaseUrl(activeProvider?.baseUrl || activeProvider?.defaultBaseUrl || '');
    setReasoningEffort(activeProvider?.reasoningEffort || snapshot?.effective.reasoningEffort || 'medium');
    setApiKey('');
    setModels([]);
    setModelSearch('');
    setChallenge(null);
    setCompletingAuth(false);
    setCopiedAuthCode(false);
    setError(null);
    setReconnectRequired(false);
  }, [activeProvider?.baseUrl, activeProvider?.defaultBaseUrl, activeProvider?.defaultModel, activeProvider?.id, activeProvider?.model, activeProvider?.reasoningEffort, snapshot?.effective.reasoningEffort]);

  const runProviderAction = async (action: () => Promise<void>) => {
    if (!sessionToken || !activeProvider) {
      return;
    }
    setBusy(true);
    setError(null);
    setReconnectRequired(false);
    try {
      await action();
      await onChanged();
      setReconnectRequired(false);
    } catch (incoming) {
      setReconnectRequired(incoming instanceof ApiRequestError && (incoming.reconnectRequired || incoming.code === 'provider_auth_expired'));
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
    setReconnectRequired(false);
    try {
      const params = baseUrl ? `?baseUrl=${encodeURIComponent(baseUrl)}` : '';
      const result = await requestJson<{ models: string[] }>(`/api/llm/providers/${activeProvider.id}/models${params}`, {
        headers: authHeaders(sessionToken),
      });
      setModels(result.models);
      setModel((current) => {
        if (current && result.models.includes(current)) {
          return current;
        }
        if (activeProvider.model && result.models.includes(activeProvider.model)) {
          return activeProvider.model;
        }
        return result.models[0] || '';
      });
    } catch (incoming) {
      setModels([]);
      setModel('');
      setReconnectRequired(incoming instanceof ApiRequestError && (incoming.reconnectRequired || incoming.code === 'provider_auth_expired'));
      setError(incoming instanceof Error ? incoming.message : String(incoming));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if ((screen === 'models' || screen === 'provider-form') && activeProvider?.connected) {
      void loadModels();
    }
    // Load once per selected provider; base URL changes still have the explicit reload button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider?.id, screen]);

  const openProviderForm = (providerIdToEdit: string, mode: 'create' | 'edit') => {
    setProviderId(providerIdToEdit);
    setProviderFormMode(mode);
    setSurface('modal');
    setScreen('provider-form');
  };

  const openCreateProviderForm = () => {
    setProviderFormMode('create');
    setSurface('modal');
    setScreen('provider-create-select');
  };

  const goBack = () => {
    if (screen === 'models') {
      setScreen('providers');
      return;
    }
    if (screen === 'providers') {
      setScreen('models');
      return;
    }
    if (screen === 'provider-form') {
      setSurface('modal');
      setScreen(providerFormMode === 'create' ? 'provider-create-select' : 'settings');
      return;
    }
    if (screen === 'provider-create-select') {
      setSurface('modal');
      setScreen('settings');
      return;
    }
    setScreen('models');
  };

  const selectModel = (nextModel = model) => runProviderAction(async () => {
    if (!nextModel) {
      return;
    }
    await requestJson(`/api/llm/providers/${activeProvider!.id}/select`, {
      method: 'POST',
      body: JSON.stringify({
        model: nextModel,
        baseUrl: baseUrl || undefined,
        reasoningEffort: activeProvider?.supportsReasoningEffort ? reasoningEffort : undefined,
      }),
      headers: authHeaders(sessionToken!),
    });
    onClose();
  });
  const useModel = () => selectModel(model);
  const startProviderConnection = () => runProviderAction(async () => {
    const result = await requestJson<{ challenge?: Omit<DeviceChallenge, 'provider'> }>(`/api/llm/providers/${activeProvider!.id}/connect`, {
      method: 'POST',
      body: JSON.stringify({
        apiKey: apiKey || undefined,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        reasoningEffort: activeProvider?.supportsReasoningEffort ? reasoningEffort : undefined,
      }),
      headers: authHeaders(sessionToken!),
    });
    if (result.challenge) {
      const nextChallenge = { provider: activeProvider!.id, ...result.challenge };
      setChallenge(nextChallenge);
      setCopiedAuthCode(false);
      void completeProviderLogin(nextChallenge);
      return;
    }
    setScreen(providerFormMode === 'create' || screen === 'provider-form' ? 'settings' : 'models');
    await loadModels();
  });
  const completeProviderLogin = async (nextChallenge: DeviceChallenge) => {
    if (!sessionToken || !activeProvider) {
      return;
    }
    setCompletingAuth(true);
    setError(null);
    setReconnectRequired(false);
    try {
      await requestJson(`/api/llm/providers/${nextChallenge.provider}/device/complete`, {
        method: 'POST',
        body: JSON.stringify({
          ...nextChallenge,
          model: model || undefined,
          reasoningEffort: activeProvider.supportsReasoningEffort ? reasoningEffort : undefined,
        }),
        headers: authHeaders(sessionToken),
      });
      setChallenge(null);
      setScreen(providerFormMode === 'create' || screen === 'provider-form' ? 'settings' : 'models');
      await onChanged();
      await loadModels();
    } catch (incoming) {
      setReconnectRequired(incoming instanceof ApiRequestError && (incoming.reconnectRequired || incoming.code === 'provider_auth_expired'));
      setError(incoming instanceof Error ? incoming.message : String(incoming));
    } finally {
      setCompletingAuth(false);
    }
  };
  const copyAuthCode = async () => {
    if (!challenge) {
      return;
    }
    await navigator.clipboard.writeText(challenge.userCode);
    setCopiedAuthCode(true);
    window.setTimeout(() => setCopiedAuthCode(false), 1400);
  };
  const modelIsSelectable = Boolean(model && models.includes(model));
  const filteredModels = modelSearch.trim()
    ? models.filter((candidate) => candidate.toLowerCase().includes(modelSearch.trim().toLowerCase()))
    : models;

  const openProviderSettings = () => {
    setSurface('modal');
    setScreen('settings');
  };

  const isModalSurface = surface === 'modal';

  return (
    <div
      className={isModalSurface ? 'modal-backdrop' : 'llm-popover-backdrop'}
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className={isModalSurface ? 'modal panel provider-modal provider-settings-modal' : 'llm-popover provider-modal'}
        style={isModalSurface ? undefined : popoverStyle(anchor, 390)}
      >
        <div className="modal-header">
          <div className="modal-title-row">
            <IconButton icon={ArrowLeft} label={screen === 'models' ? 'Change provider' : 'Back'} className="secondary" onClick={goBack} />
            <div>
              <h2>{screen === 'models' ? 'Model' : screen === 'providers' ? 'Providers' : screen === 'provider-create-select' ? 'Add Provider' : screen === 'provider-form' ? (providerFormMode === 'create' ? 'Provider Settings' : 'Edit Provider') : 'Provider Settings'}</h2>
              <p className="muted">
                {screen === 'models'
                  ? `${activeProvider?.label ?? 'Provider'} model selection`
                  : screen === 'providers'
                    ? 'Choose one of your connected providers.'
                    : screen === 'provider-create-select'
                      ? 'Choose a provider to connect.'
                      : screen === 'provider-form'
                      ? providerFormMode === 'create' ? 'Configure this provider connection.' : 'Update provider credentials and defaults.'
                      : 'Manage configured providers.'}
              </p>
            </div>
          </div>
          <IconButton icon={X} label="Close" className="secondary" onClick={onClose} />
        </div>

        {screen === 'models' && activeProvider ? (
          <div className="model-picker-screen">
            <div className="model-screen-header">
              <div>
                <h3>{activeProvider.label}</h3>
                <p className="muted">Current model: {snapshot?.effective.model || activeProvider.defaultModel || 'Not selected'}</p>
              </div>
	              {!challenge && reconnectRequired ? (
	                <div className="provider-actions model-actions">
	                  <IconButton icon={RefreshCw} label="Reconnect provider" className="secondary" onClick={startProviderConnection} disabled={busy}>Reconnect</IconButton>
	                </div>
	              ) : null}
	            </div>
            <label className="model-search-field">
              <span className="muted">Models</span>
              <input
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder={busy ? 'Loading models...' : 'Search models...'}
                disabled={busy || !models.length}
              />
            </label>
	            {!models.length ? (
	              <div className="model-list">
	                <div className="message-empty muted">
                  {busy
                    ? 'Loading models...'
                    : reconnectRequired
                      ? 'The saved login has expired. Reconnect this provider to load its live model list.'
	                      : 'No models available from this provider. Check credentials or provider settings.'}
	                </div>
	              </div>
	            ) : (
	              <div className="model-list" role="listbox" aria-label={`${activeProvider.label} models`}>
	                {filteredModels.map((candidate) => (
	                  <button
	                    type="button"
	                    key={candidate}
	                    className={candidate === model ? 'model-option active' : 'model-option'}
	                    onClick={() => selectModel(candidate)}
	                    disabled={busy}
	                  >
	                    <span>
	                      <strong>{candidate}</strong>
	                      <small className="muted">{activeProvider.label}</small>
	                    </span>
	                    {candidate === model ? <span className="muted">Active</span> : null}
	                  </button>
	                ))}
	                {filteredModels.length ? null : <div className="message-empty muted">No models match this search.</div>}
	              </div>
	            )}
            {challenge ? (
              <div className="device-challenge auth-panel">
                <div>
                  <strong>Browser login pending</strong>
                  <p className="muted">{completingAuth ? 'Waiting for authorization...' : 'Open the login page and enter this code.'}</p>
                </div>
                <div className="auth-code-row">
                  <code>{challenge.userCode}</code>
                  <IconButton icon={copiedAuthCode ? Check : Copy} label={copiedAuthCode ? 'Copied' : 'Copy code'} className="secondary" onClick={() => void copyAuthCode()} />
                </div>
                <div className="provider-actions">
                  <a className="button-link secondary" href={challenge.verificationUriComplete || challenge.verificationUri} target="_blank" rel="noreferrer">
                    <ExternalLink size={16} /> Open login page
                  </a>
                </div>
              </div>
            ) : null}
            {error ? <p className="error-copy">{error}</p> : null}
          </div>
        ) : null}

        {screen === 'providers' ? (
          <div className="provider-section">
            <div className="provider-grid">
              {connectedProviders.map((provider) => (
                <button
                  type="button"
                  key={provider.id}
                  className={provider.id === providerId ? 'provider-row active' : 'provider-row'}
                  onClick={() => {
                    setProviderId(provider.id);
                    setScreen('models');
                  }}
                >
                  <strong>{provider.label}</strong>
                  <span className="muted">{provider.model || provider.defaultModel || 'Custom model'}</span>
                </button>
              ))}
            </div>
            {connectedProviders.length ? null : <div className="message-empty muted">No connected providers yet.</div>}
            <IconButton icon={Settings} label="Provider settings" className="secondary" onClick={openProviderSettings}>Provider settings</IconButton>
          </div>
        ) : null}

        {screen === 'settings' ? (
          <div className="settings-screen">
            <div className="provider-list-header">
              <div>
                <h3>Providers</h3>
                <p className="muted">Edit connected providers or add a new connection.</p>
              </div>
              <IconButton icon={Plus} label="Add provider" onClick={openCreateProviderForm}>Add provider</IconButton>
            </div>
            <div className="provider-list">
              {connectedProviders.map((provider) => (
                <article key={provider.id} className="provider-list-item">
                  <div className="provider-list-main">
                    <strong>{provider.label}</strong>
                    <span className="muted">{provider.model || provider.defaultModel || 'No model selected'}</span>
                  </div>
                  <IconButton
                    icon={Pencil}
                    label={`Edit ${provider.label}`}
                    className="secondary"
                    onClick={() => openProviderForm(provider.id, 'edit')}
                  />
                </article>
              ))}
              {connectedProviders.length ? null : <div className="message-empty muted">No connected providers yet.</div>}
            </div>
          </div>
        ) : null}

        {screen === 'provider-create-select' ? (
          <div className="settings-screen">
            <div className="provider-list-header">
              <div>
                <h3>Select provider</h3>
                <p className="muted">Choose the service you want to connect.</p>
              </div>
            </div>
            <div className="provider-list provider-choice-list">
              {providerCreateOptions.map((provider) => {
                const description = getProviderUserDescription(provider);
                return (
                  <button
                    type="button"
                    key={provider.id}
                    className="provider-choice-item"
                    onClick={() => openProviderForm(provider.id, 'create')}
                  >
                    <span>
                      <strong>{provider.label}</strong>
                      {description ? <small className="muted">{description}</small> : null}
                    </span>
                    {provider.connected ? <span className="muted">Connected</span> : null}
                  </button>
                );
              })}
              {providerCreateOptions.length ? null : <div className="message-empty muted">No providers available.</div>}
            </div>
          </div>
        ) : null}

        {screen === 'provider-form' && activeProvider ? (
          <div className="settings-screen">
            <div className="provider-form">
              <div className="provider-form-title">
                <div>
                  <h3>{activeProvider.label}</h3>
                  {getProviderUserDescription(activeProvider) ? <p className="muted">{getProviderUserDescription(activeProvider)}</p> : null}
                  {reconnectRequired ? <p className="error-copy">The saved credential no longer works. Reconnect this provider, or replace the stored key.</p> : null}
                </div>
                {activeProvider.connected ? <span className="status-pill ready">Connected</span> : null}
              </div>

              <label>
                <span className="muted">Model</span>
                {activeProvider.connected ? (
                  <select value={model} onChange={(event) => setModel(event.target.value)} disabled={busy || !models.length}>
                    <option value="" disabled>{busy ? 'Loading models...' : 'Select a model'}</option>
                    {models.map((candidate) => (
                      <option key={candidate} value={candidate}>{candidate}</option>
                    ))}
                  </select>
                ) : (
                  <span className="message-empty muted">Connect this provider to load its available models.</span>
                )}
              </label>
              {activeProvider.supportsReasoningEffort ? (
                <label>
                  <span className="muted">Reasoning effort</span>
                  <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}>
                    {reasoningEffortOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
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
                <div className="device-challenge auth-panel">
                  <div>
                    <strong>Browser login pending</strong>
                    <p className="muted">{completingAuth ? 'Waiting for authorization...' : 'Open the login page and enter this code.'}</p>
                  </div>
                  <div className="auth-code-row">
                    <code>{challenge.userCode}</code>
                    <IconButton icon={copiedAuthCode ? Check : Copy} label={copiedAuthCode ? 'Copied' : 'Copy code'} className="secondary" onClick={() => void copyAuthCode()} />
                  </div>
                  <div className="provider-actions">
                    <a className="button-link secondary" href={challenge.verificationUriComplete || challenge.verificationUri} target="_blank" rel="noreferrer">
                      <ExternalLink size={16} /> Open login page
                    </a>
                  </div>
                </div>
              ) : null}
              {error ? <p className="error-copy">{error}</p> : null}
              {!challenge ? (
                <div className="provider-actions provider-form-actions">
                  {activeProvider.connected ? (
                    <IconButton
                      icon={Power}
                      label="Disconnect"
                      className="danger"
                      onClick={() => runProviderAction(async () => {
                        await requestJson(`/api/llm/providers/${activeProvider.id}`, {
                          method: 'DELETE',
                          headers: authHeaders(sessionToken!),
                        });
                      })}
                      disabled={busy}
                    >
                      Disconnect
                    </IconButton>
                  ) : null}
                  <IconButton
                    icon={activeProvider.oauth && activeProvider.connected ? RefreshCw : activeProvider.oauth ? LogIn : Plug}
                    label={activeProvider.oauth && activeProvider.connected ? 'Reconnect login' : activeProvider.oauth ? 'Start login' : 'Connect'}
                    className={activeProvider.connected ? 'secondary' : undefined}
                    onClick={startProviderConnection}
                    disabled={busy || (!activeProvider.oauth && activeProvider.requiresApiKey && !apiKey && !activeProvider.connected)}
                  >
                    {activeProvider.oauth && activeProvider.connected ? 'Reconnect' : activeProvider.oauth ? 'Start login' : activeProvider.connected ? 'Update key' : 'Connect'}
                  </IconButton>
                  <IconButton
                    icon={Check}
                    label="Use provider"
                    onClick={useModel}
                    disabled={busy || !activeProvider.connected || !modelIsSelectable}
                  >
                    Use provider
                  </IconButton>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
