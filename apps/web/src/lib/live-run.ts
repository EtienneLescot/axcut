export type ProjectStreamEvent = {
  type: string;
  projectId: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type LiveOperation = {
  operationId: string;
  label: string;
  category: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
  body?: string;
  startedAt: number;
  endedAt?: number;
};

export type LiveCompaction = {
  summary: string;
  source: 'llm' | 'fallback';
  messagesCompacted: number;
  preservedRecentMessages: number;
};

export type LiveRunState = {
  userMessage: string;
  assistantDraft: string;
  finalMessage: string;
  thinking: string;
  operations: LiveOperation[];
  compactions: LiveCompaction[];
  active: boolean;
  startedAt?: string;
  completedAt?: string;
};

export const emptyLiveRunState: LiveRunState = {
  userMessage: '',
  assistantDraft: '',
  finalMessage: '',
  thinking: '',
  operations: [],
  compactions: [],
  active: false,
};

export function reduceLiveRunState(state: LiveRunState, event: ProjectStreamEvent): LiveRunState {
  switch (event.type) {
    case 'agent.message.user':
      return {
        ...emptyLiveRunState,
        userMessage: stringValue(event.payload.content),
        active: true,
        startedAt: event.createdAt,
      };

    case 'agent.message.delta':
      return {
        ...state,
        active: true,
        assistantDraft: `${state.assistantDraft}${stringValue(event.payload.delta)}`,
      };

    case 'agent.thinking.delta':
      return {
        ...state,
        active: true,
        thinking: `${state.thinking}${stringValue(event.payload.delta)}`,
      };

    case 'agent.operation': {
      const operation = event.payload.operation;
      if (!operation || typeof operation !== 'object') {
        return state;
      }
      const nextOperation = normalizeOperation(operation as Record<string, unknown>);
      if (!nextOperation) {
        return state;
      }
      return {
        ...state,
        active: true,
        operations: upsertOperation(state.operations, nextOperation),
      };
    }

    case 'agent.compaction': {
      const compaction = normalizeCompaction(event.payload.compaction as Record<string, unknown> | undefined);
      if (!compaction) {
        return state;
      }
      return {
        ...state,
        compactions: [...state.compactions, compaction],
      };
    }

    case 'agent.message.assistant':
      return {
        ...state,
        active: false,
        finalMessage: stringValue(event.payload.content),
        completedAt: event.createdAt,
      };

    default:
      return state;
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeOperation(value: Record<string, unknown>): LiveOperation | null {
  if (typeof value.operationId !== 'string' || typeof value.label !== 'string' || typeof value.category !== 'string') {
    return null;
  }
  const status = value.status;
  if (status !== 'running' && status !== 'done' && status !== 'error') {
    return null;
  }
  return {
    operationId: value.operationId,
    label: value.label,
    category: value.category,
    status,
    summary: typeof value.summary === 'string' ? value.summary : undefined,
    body: typeof value.body === 'string' ? value.body : undefined,
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : Date.now(),
    endedAt: typeof value.endedAt === 'number' ? value.endedAt : undefined,
  };
}

function normalizeCompaction(value: Record<string, unknown> | undefined): LiveCompaction | null {
  if (!value || typeof value.summary !== 'string') {
    return null;
  }
  return {
    summary: value.summary,
    source: value.source === 'fallback' ? 'fallback' : 'llm',
    messagesCompacted: typeof value.messagesCompacted === 'number' ? value.messagesCompacted : 0,
    preservedRecentMessages: typeof value.preservedRecentMessages === 'number' ? value.preservedRecentMessages : 0,
  };
}

function upsertOperation(existing: LiveOperation[], nextOperation: LiveOperation): LiveOperation[] {
  const index = existing.findIndex((operation) => operation.operationId === nextOperation.operationId);
  if (index < 0) {
    return [...existing, nextOperation];
  }
  return existing.map((operation, operationIndex) => (
    operationIndex === index ? { ...operation, ...nextOperation } : operation
  ));
}
