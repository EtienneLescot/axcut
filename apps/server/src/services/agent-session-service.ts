import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';

export type DeepAgentSessionScope = {
  kind: string;
  key: string;
};

export type DeepAgentSessionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  closedAt?: string;
  scope?: DeepAgentSessionScope;
  restoredRuntimeCheckpointId?: string;
};

type SessionCheckpointMetadata = {
  id: string;
  sessionId: string;
  createdAt: string;
  messageCount: number;
  runtimeCheckpointId?: string;
};

type SerializedCheckpoint = [unknown, unknown, string | undefined];
type SerializedWrite = [string, string, unknown];
type CheckpointStorage = Record<string, Record<string, Record<string, SerializedCheckpoint>>>;
type CheckpointWrites = Record<string, Record<string, SerializedWrite>>;

export function deriveSessionTitle(text: string, fallback = 'New conversation'): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > 48 ? `${normalized.slice(0, 45).trim()}...` : normalized;
}

export class AgentSessionService {
  private readonly recordsDir: string;
  private readonly checkpointDir: string;
  private checkpointer: PersistentFileCheckpointSaver | undefined;

  constructor(private readonly sessionsRoot: string) {
    this.recordsDir = path.join(sessionsRoot, 'records');
    this.checkpointDir = path.join(sessionsRoot, 'checkpoints');
    fs.mkdirSync(this.recordsDir, { recursive: true });
    fs.mkdirSync(this.checkpointDir, { recursive: true });
  }

  setCheckpointer(checkpointer: PersistentFileCheckpointSaver): void {
    this.checkpointer = checkpointer;
  }

  get(id: string): DeepAgentSessionRecord | undefined {
    return this.readJson<DeepAgentSessionRecord>(this.recordPath(id));
  }

  getActiveForScope(scope: DeepAgentSessionScope): DeepAgentSessionRecord | undefined {
    return this.listForScope(scope)
      .filter((record) => !record.closedAt)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  ensure(sessionId: string, options?: { title?: string; scope?: DeepAgentSessionScope }): DeepAgentSessionRecord {
    return this.get(sessionId) ?? this.create({ id: sessionId, title: options?.title, scope: options?.scope });
  }

  rotateForScope(scope: DeepAgentSessionScope, options?: { title?: string }): DeepAgentSessionRecord {
    const now = new Date().toISOString();
    for (const record of this.listForScope(scope)) {
      if (!record.closedAt) {
        this.writeRecord({ ...record, closedAt: now, updatedAt: now });
      }
    }
    return this.create({ title: options?.title, scope });
  }

  listForScope(scope: DeepAgentSessionScope): DeepAgentSessionRecord[] {
    return this.readRecords().filter((record) => record.scope?.kind === scope.kind && record.scope?.key === scope.key);
  }

  touch(sessionId: string, options?: { title?: string; closed?: boolean }): DeepAgentSessionRecord | undefined {
    const record = this.get(sessionId);
    if (!record) {
      return undefined;
    }
    const next: DeepAgentSessionRecord = {
      ...record,
      updatedAt: new Date().toISOString(),
      ...(options?.title ? { title: options.title } : {}),
      ...(options?.closed ? { closedAt: new Date().toISOString() } : {}),
    };
    this.writeRecord(next);
    return next;
  }

  async delete(sessionId: string): Promise<void> {
    fs.rmSync(this.recordPath(sessionId), { force: true });
    fs.rmSync(this.sessionCheckpointDir(sessionId), { recursive: true, force: true });
    await this.checkpointer?.deleteThread(sessionId);
  }

  buildSessionConfig(sessionId: string): RunnableConfig {
    const record = this.get(sessionId);
    const checkpointId = record?.restoredRuntimeCheckpointId;
    if (record && checkpointId) {
      const { restoredRuntimeCheckpointId: _unused, ...next } = record;
      void _unused;
      this.writeRecord({ ...next, updatedAt: new Date().toISOString() });
    }
    return {
      configurable: {
        thread_id: sessionId,
        ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
      },
    };
  }

  async saveCheckpoint(sessionId: string): Promise<SessionCheckpointMetadata> {
    const createdAt = new Date().toISOString();
    const runtimeCheckpointId = await this.getLatestRuntimeCheckpointId(sessionId);
    const checkpoint: SessionCheckpointMetadata = {
      id: randomUUID(),
      sessionId,
      createdAt,
      messageCount: 0,
      runtimeCheckpointId,
    };
    fs.mkdirSync(this.sessionCheckpointDir(sessionId), { recursive: true });
    this.writeJson(this.checkpointPath(sessionId, checkpoint.id), checkpoint);
    return checkpoint;
  }

  listCheckpointsSync(sessionId: string): SessionCheckpointMetadata[] {
    const dir = this.sessionCheckpointDir(sessionId);
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => this.readJson<SessionCheckpointMetadata>(path.join(dir, file)))
      .filter((checkpoint): checkpoint is SessionCheckpointMetadata => Boolean(checkpoint))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async restoreCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
    const checkpoint = this.readJson<SessionCheckpointMetadata>(this.checkpointPath(sessionId, checkpointId));
    if (!checkpoint?.runtimeCheckpointId) {
      return;
    }
    const record = this.ensure(sessionId);
    this.writeRecord({
      ...record,
      restoredRuntimeCheckpointId: checkpoint.runtimeCheckpointId,
      updatedAt: new Date().toISOString(),
    });
  }

  private create(options: { id?: string; title?: string; scope?: DeepAgentSessionScope } = {}): DeepAgentSessionRecord {
    const now = new Date().toISOString();
    const record: DeepAgentSessionRecord = {
      id: options.id || randomUUID(),
      title: options.title || 'New conversation',
      createdAt: now,
      updatedAt: now,
      scope: options.scope,
    };
    this.writeRecord(record);
    return record;
  }

  private readRecords(): DeepAgentSessionRecord[] {
    if (!fs.existsSync(this.recordsDir)) {
      return [];
    }
    return fs.readdirSync(this.recordsDir)
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
      .map((file) => this.normalizeRecord(this.readJson<DeepAgentSessionRecord>(path.join(this.recordsDir, file))))
      .filter((record): record is DeepAgentSessionRecord => Boolean(record));
  }

  private normalizeRecord(record: DeepAgentSessionRecord | undefined): DeepAgentSessionRecord | undefined {
    if (!record?.id) {
      return undefined;
    }
    const now = new Date().toISOString();
    return {
      id: record.id,
      title: record.title || 'New conversation',
      createdAt: record.createdAt || now,
      updatedAt: record.updatedAt || record.createdAt || now,
      scope: record.scope,
      closedAt: record.closedAt,
      restoredRuntimeCheckpointId: record.restoredRuntimeCheckpointId,
    };
  }

  private async getLatestRuntimeCheckpointId(sessionId: string): Promise<string | undefined> {
    const config = { configurable: { thread_id: sessionId } };
    const tuple = await this.checkpointer?.getTuple(config).catch(() => undefined);
    const tupleCheckpointId = tuple?.checkpoint?.id || tuple?.config?.configurable?.checkpoint_id;
    if (typeof tupleCheckpointId === 'string' && tupleCheckpointId) {
      return tupleCheckpointId;
    }
    const iterator = this.checkpointer?.list(config, { limit: 1 });
    if (!iterator) {
      return undefined;
    }
    try {
      for await (const checkpoint of iterator) {
        const checkpointId = checkpoint.checkpoint?.id || checkpoint.config?.configurable?.checkpoint_id;
        if (typeof checkpointId === 'string' && checkpointId) {
          return checkpointId;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private writeRecord(record: DeepAgentSessionRecord): void {
    this.writeJson(this.recordPath(record.id), record);
  }

  private recordPath(id: string): string {
    return path.join(this.recordsDir, `${this.safeId(id)}.json`);
  }

  private sessionCheckpointDir(sessionId: string): string {
    return path.join(this.checkpointDir, this.safeId(sessionId));
  }

  private checkpointPath(sessionId: string, checkpointId: string): string {
    return path.join(this.sessionCheckpointDir(sessionId), `${this.safeId(checkpointId)}.json`);
  }

  private safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private readJson<T>(filePath: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

export class PersistentFileCheckpointSaver extends BaseCheckpointSaver {
  private readonly threads = new Map<string, { storage: CheckpointStorage; writes: CheckpointWrites }>();

  constructor(private readonly rootDir: string) {
    super();
    fs.mkdirSync(rootDir, { recursive: true });
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = String(config.configurable?.thread_id ?? '');
    const checkpointNamespace = String(config.configurable?.checkpoint_ns ?? '');
    if (!threadId) {
      return undefined;
    }
    let checkpointId = getCheckpointId(config);
    const threadData = this.loadThread(threadId);
    if (!checkpointId) {
      const checkpoints = threadData.storage[threadId]?.[checkpointNamespace];
      if (!checkpoints) {
        return undefined;
      }
      checkpointId = Object.keys(checkpoints).sort((a, b) => b.localeCompare(a))[0];
    }

    const saved = threadData.storage[threadId]?.[checkpointNamespace]?.[checkpointId];
    if (!saved) {
      return undefined;
    }
    const [checkpoint, metadata, parentCheckpointId] = saved;
    const key = generateKey(threadId, checkpointNamespace, checkpointId);
    const pendingWrites = await Promise.all(Object.values(threadData.writes[key] || {}).map(async ([taskId, channel, value]): Promise<[string, string, unknown]> => [
      taskId,
      channel,
      await this.serde.loadsTyped('json', decodeSerializedValue(value)),
    ]));
    const checkpointTuple: CheckpointTuple = {
      config: { configurable: { thread_id: threadId, checkpoint_ns: checkpointNamespace, checkpoint_id: checkpointId } },
      checkpoint: await this.serde.loadsTyped('json', decodeSerializedValue(checkpoint)) as Checkpoint,
      metadata: await this.serde.loadsTyped('json', decodeSerializedValue(metadata)) as CheckpointMetadata,
      pendingWrites,
    };
    if (parentCheckpointId !== undefined) {
      checkpointTuple.parentConfig = { configurable: { thread_id: threadId, checkpoint_ns: checkpointNamespace, checkpoint_id: parentCheckpointId } };
    }
    return checkpointTuple;
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    let { before, limit, filter } = options ?? {};
    void before;
    const threadIds = config.configurable?.thread_id
      ? [String(config.configurable.thread_id)]
      : fs.existsSync(this.rootDir)
        ? fs.readdirSync(this.rootDir).map((entry) => decodeURIComponent(entry))
        : [];
    const configCheckpointNamespace = config.configurable?.checkpoint_ns;

    for (const threadId of threadIds) {
      const threadData = this.loadThread(threadId);
      for (const checkpointNamespace of Object.keys(threadData.storage[threadId] ?? {})) {
        if (configCheckpointNamespace !== undefined && checkpointNamespace !== configCheckpointNamespace) {
          continue;
        }
        const checkpoints = threadData.storage[threadId]?.[checkpointNamespace] ?? {};
        const sortedCheckpoints = Object.entries(checkpoints).sort((a, b) => b[0].localeCompare(a[0]));
        for (const [checkpointId] of sortedCheckpoints) {
          const tuple = await this.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: checkpointNamespace, checkpoint_id: checkpointId } });
          if (!tuple) {
            continue;
          }
          if (filter && !Object.entries(filter).every(([key, value]) => (tuple.metadata as Record<string, unknown> | undefined)?.[key] === value)) {
            continue;
          }
          if (limit !== undefined) {
            if (limit <= 0) {
              break;
            }
            limit -= 1;
          }
          yield tuple;
        }
      }
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const threadId = String(config.configurable?.thread_id ?? '');
    const checkpointNamespace = String(config.configurable?.checkpoint_ns ?? '');
    if (!threadId) {
      throw new Error('Failed to put checkpoint. The passed RunnableConfig is missing configurable.thread_id.');
    }
    const threadData = this.loadThread(threadId);
    threadData.storage[threadId] ??= {};
    threadData.storage[threadId][checkpointNamespace] ??= {};
    const [[, serializedCheckpoint], [, serializedMetadata]] = await Promise.all([
      this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
      this.serde.dumpsTyped(metadata),
    ]);
    threadData.storage[threadId][checkpointNamespace][checkpoint.id] = [
      encodeSerializedValue(serializedCheckpoint),
      encodeSerializedValue(serializedMetadata),
      typeof config.configurable?.checkpoint_id === 'string' ? config.configurable.checkpoint_id : undefined,
    ];
    this.saveThread(threadId, threadData);
    return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNamespace, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = String(config.configurable?.thread_id ?? '');
    const checkpointNamespace = String(config.configurable?.checkpoint_ns ?? '');
    const checkpointId = String(config.configurable?.checkpoint_id ?? '');
    if (!threadId || !checkpointId) {
      throw new Error('Failed to put writes. The passed RunnableConfig is missing configurable.thread_id or configurable.checkpoint_id.');
    }
    const outerKey = generateKey(threadId, checkpointNamespace, checkpointId);
    const threadData = this.loadThread(threadId);
    const existingWrites = threadData.writes[outerKey];
    threadData.writes[outerKey] ??= {};
    await Promise.all(writes.map(async ([channel, value], index) => {
      const [, serializedValue] = await this.serde.dumpsTyped(value);
      const writeIndex = WRITES_IDX_MAP[channel] ?? index;
      const innerKey = `${taskId},${writeIndex}`;
      if (writeIndex >= 0 && existingWrites && innerKey in existingWrites) {
        return;
      }
      threadData.writes[outerKey][innerKey] = [taskId, channel, encodeSerializedValue(serializedValue)];
    }));
    this.saveThread(threadId, threadData);
  }

  async deleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
    fs.rmSync(this.threadFilePath(threadId), { force: true });
  }

  private loadThread(threadId: string): { storage: CheckpointStorage; writes: CheckpointWrites } {
    const cached = this.threads.get(threadId);
    if (cached) {
      return cached;
    }
    const filePath = this.threadFilePath(threadId);
    const parsed = readJson<{ storage?: CheckpointStorage; writes?: CheckpointWrites }>(filePath);
    const data = {
      storage: parsed?.storage && typeof parsed.storage === 'object' ? parsed.storage : {},
      writes: parsed?.writes && typeof parsed.writes === 'object' ? parsed.writes : {},
    };
    this.threads.set(threadId, data);
    return data;
  }

  private saveThread(threadId: string, data: { storage: CheckpointStorage; writes: CheckpointWrites }): void {
    const filePath = this.threadFilePath(threadId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, storage: data.storage, writes: data.writes })}\n`, 'utf8');
  }

  private threadFilePath(threadId: string): string {
    return path.join(this.rootDir, encodeURIComponent(threadId), 'state.json');
  }
}

function generateKey(threadId: string, checkpointNamespace: string, checkpointId: string): string {
  return JSON.stringify([threadId, checkpointNamespace, checkpointId]);
}

function encodeSerializedValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(value as ArrayBufferView);
  }
  return JSON.stringify(value);
}

function decodeSerializedValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return String(value ?? '');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || !entries.every(([key, byte]) => /^\d+$/.test(key) && typeof byte === 'number')) {
    return JSON.stringify(value);
  }
  const bytes = entries
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, byte]) => Number(byte));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
