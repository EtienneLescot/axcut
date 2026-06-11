export type ProjectStreamEvent = {
  type: string;
  projectId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type LiveOperation = {
  operationId: string;
  label: string;
  category: string;
  status: 'running' | 'done' | 'error';
  body?: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
};

export type LiveCompaction = {
  summary: string;
  source: string;
};

export type LiveRunState = {
  active: boolean;
  userMessage: string;
  thinking: string;
  assistantDraft: string;
  operations: LiveOperation[];
  compactions: LiveCompaction[];
};

export const emptyLiveRunState: LiveRunState = {
  active: false,
  userMessage: '',
  thinking: '',
  assistantDraft: '',
  operations: [],
  compactions: [],
};

export function reduceLiveRunState(state: LiveRunState, event: ProjectStreamEvent): LiveRunState {
  if (event.type === 'agent.message.user') {
    return {
      ...emptyLiveRunState,
      active: true,
      userMessage: optionalString(event.payload.content),
    };
  }

  if (event.type === 'agent.thinking.delta') {
    return {
      ...state,
      active: true,
      thinking: state.thinking + optionalString(event.payload.delta),
    };
  }

  if (event.type === 'agent.message.delta') {
    return {
      ...state,
      active: true,
      assistantDraft: state.assistantDraft + optionalString(event.payload.delta),
    };
  }

  if (event.type === 'agent.operation') {
    const operation = normalizeOperation(event.payload.operation);
    if (!operation) {
      return state;
    }
    if (operation.category === 'thinking' && operation.status === 'done' && !operation.body && !operation.summary) {
      return {
        ...state,
        operations: state.operations.filter((item) => item.operationId !== operation.operationId),
      };
    }
    const existingIndex = state.operations.findIndex((item) => item.operationId === operation.operationId);
    const operations = existingIndex >= 0
      ? state.operations.map((item, index) => (index === existingIndex ? { ...item, ...operation } : item))
      : [...state.operations, operation];
    return {
      ...state,
      active: operation.status === 'running' || state.active,
      operations,
    };
  }

  if (event.type === 'agent.compaction') {
    return {
      ...state,
      active: true,
      compactions: [
        ...state.compactions,
        {
          summary: optionalString(event.payload.summary),
          source: optionalString(event.payload.source) || 'fallback',
        },
      ],
    };
  }

  if (event.type === 'agent.message.assistant') {
    return {
      ...state,
      active: false,
      assistantDraft: '',
      thinking: '',
      operations: state.operations.filter((operation) => operation.category !== 'thinking'),
    };
  }

  return state;
}

function normalizeOperation(value: unknown): LiveOperation | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const operationId = optionalString(record.operationId);
  const label = optionalString(record.label);
  const status = optionalString(record.status);
  if (!operationId || !label || (status !== 'running' && status !== 'done' && status !== 'error')) {
    return undefined;
  }
  const startedAt = typeof record.startedAt === 'number' && Number.isFinite(record.startedAt)
    ? record.startedAt
    : Date.now();
  return {
    operationId,
    label,
    category: optionalString(record.category) || 'tool',
    status,
    startedAt,
    ...(typeof record.endedAt === 'number' && Number.isFinite(record.endedAt) ? { endedAt: record.endedAt } : {}),
    ...(typeof record.body === 'string' ? { body: record.body } : {}),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
  };
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
