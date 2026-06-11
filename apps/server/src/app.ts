import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { applyOperationInputSchema, exportInputSchema, transcribeInputSchema } from '@axcut/schema';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';

import { streamFile } from './lib/media-stream.js';
import { databasePath, projectArtifactsRoot, runtimeRoot } from './lib/paths.js';
import { AxcutAgentRuntime } from './services/axcut-agent-runtime.js';
import { ChatService } from './services/chat-service.js';
import { DatabaseService } from './services/database.js';
import { DocumentService } from './services/document-service.js';
import { EventBus } from './services/event-bus.js';
import { JobService } from './services/job-service.js';
import { LlmConfigService } from './services/llm-config-service.js';
import { PythonWorker } from './services/python-worker.js';

async function ensureConfiguredProject(documents: DocumentService, jobs: JobService, logger: ReturnType<typeof Fastify>['log']): Promise<void> {
  const configuredVideoPath = process.env.AXCUT_VIDEO_PATH?.trim();
  if (!configuredVideoPath) {
    return;
  }

  const resolvedVideoPath = path.resolve(configuredVideoPath);
  const configuredTitle = process.env.AXCUT_PROJECT_TITLE?.trim() || path.basename(resolvedVideoPath);
  const existingProjects = documents.listProjects();

  for (const project of existingProjects) {
    const snapshot = documents.getSnapshot(project.id).document;
    const asset = snapshot.assets.find((item) => item.originalPath === resolvedVideoPath);
    if (!asset) {
      continue;
    }
    if (!asset.proxyPath || !snapshot.transcript) {
      jobs.enqueueAssetIngest(project.id, asset.id, { autoTranscribe: true });
      logger.info(`Axcut resumed ingest for configured video ${resolvedVideoPath}`);
    }
    return;
  }

  const document = documents.createProject({ title: configuredTitle });
  const { asset } = documents.addAsset(document.project.id, { path: resolvedVideoPath, autoTranscribe: true });
  jobs.enqueueAssetIngest(document.project.id, asset.id, { autoTranscribe: true });
  logger.info(`Axcut bootstrapped project ${document.project.id} for ${resolvedVideoPath}`);
}

function resolveSessionToken(): string {
  const configured = process.env.AXCUT_SESSION_TOKEN?.trim();
  if (configured) {
    return configured;
  }
  const tokenPath = path.join(runtimeRoot, 'session-token');
  const existing = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf-8').trim() : '';
  if (existing) {
    return existing;
  }
  const token = randomUUID();
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
  return token;
}

export async function createServer() {
  const fastify = Fastify({ logger: true });
  await fastify.register(cors, {
    origin: ['http://127.0.0.1:5173', 'http://localhost:5173'],
  });
  const sessionToken = resolveSessionToken();

  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url.startsWith('/api/session')) {
      return;
    }
    const headerToken = request.headers['x-axcut-token'];
    const queryToken = typeof (request.query as { token?: unknown } | undefined)?.token === 'string'
      ? (request.query as { token?: string }).token
      : undefined;
    const token = typeof headerToken === 'string' ? headerToken : queryToken;
    if (token !== sessionToken) {
      reply.code(401);
      return reply.send({ error: 'Invalid Axcut session token.' });
    }
  });

  const events = new EventBus();
  const db = new DatabaseService(databasePath);
  const interruptedJobs = db.markInterruptedJobs();
  if (interruptedJobs.length > 0) {
    fastify.log.warn({ jobIds: interruptedJobs.map((job) => job.id) }, 'Marked interrupted jobs as failed');
  }
  const documents = new DocumentService(db);
  const llmConfig = new LlmConfigService();
  const worker = new PythonWorker();
  const jobs = new JobService(db, documents, worker, events);
  const agentRuntime = new AxcutAgentRuntime(documents, events, llmConfig);
  const chat = new ChatService(db, documents, agentRuntime, events);

  const buildSessionSummary = (projectId: string, activeSessionId?: string) => {
    const counts = db.countMessagesBySession(projectId);
    return agentRuntime.listSessions(projectId).map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      closedAt: session.closedAt,
      messageCount: counts[session.id] ?? 0,
      active: session.id === activeSessionId,
    }));
  };

  const buildProjectSnapshot = (projectId: string, requestedSessionId?: string) => {
    const activeSession = requestedSessionId
      ? agentRuntime.getSession(projectId, requestedSessionId)
      : agentRuntime.getOrCreateSession(projectId);
    return {
      ...documents.getSnapshot(projectId, activeSession.id),
      activeSessionId: activeSession.id,
      sessions: buildSessionSummary(projectId, activeSession.id),
    };
  };

  await ensureConfiguredProject(documents, jobs, fastify.log);

  fastify.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : undefined;
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
    const reconnectRequired = Boolean((error as { reconnectRequired?: unknown }).reconnectRequired);
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: 'Validation error',
        issues: error.issues,
      });
      return;
    }

    if (statusCode && statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({
        error: message,
        ...(code ? { code } : {}),
        ...(reconnectRequired ? { reconnectRequired } : {}),
      });
      return;
    }

    if (
      message.includes('Asset path must point')
      || message.includes('Unsupported asset type')
      || message.includes('Cannot update timeline')
      || message.includes('No asset available')
      || message.includes('Unknown transcript word id')
    ) {
      reply.code(400).send({ error: message });
      return;
    }

    reply.code(500).send({ error: message || 'Internal server error' });
  });

  fastify.get('/api/session', async () => ({ token: sessionToken }));
  fastify.get('/api/llm/config', async () => llmConfig.getSnapshot());

  fastify.post('/api/llm/providers/:provider/connect', async (request) => {
    const { provider } = request.params as { provider: string };
    return llmConfig.connectProvider(provider, request.body as Record<string, unknown>);
  });

  fastify.post('/api/llm/providers/:provider/device/complete', async (request) => {
    const { provider } = request.params as { provider: string };
    return llmConfig.completeDeviceProvider(provider, request.body as Record<string, unknown>);
  });

  fastify.post('/api/llm/providers/:provider/select', async (request) => {
    const { provider } = request.params as { provider: string };
    return { snapshot: llmConfig.selectProvider(provider, request.body as Record<string, unknown>) };
  });

  fastify.delete('/api/llm/providers/:provider', async (request) => {
    const { provider } = request.params as { provider: string };
    return { snapshot: llmConfig.disconnectProvider(provider) };
  });

  fastify.get('/api/llm/providers/:provider/models', async (request) => {
    const { provider } = request.params as { provider: string };
    return llmConfig.listProviderModels(provider, request.query as { baseUrl?: string });
  });

  fastify.get('/api/projects', async () => ({ projects: documents.listProjects() }));

  fastify.post('/api/projects', async (request, reply) => {
    const document = documents.createProject(request.body);
    reply.code(201);
    return { document };
  });

  fastify.get('/api/projects/:projectId/sessions', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const activeSession = agentRuntime.getOrCreateSession(projectId);
    return {
      activeSessionId: activeSession.id,
      sessions: buildSessionSummary(projectId, activeSession.id),
    };
  });

  fastify.post('/api/projects/:projectId/sessions', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const session = agentRuntime.createSession(projectId);
    events.emit(projectId, 'agent.session.created', { sessionId: session.id });
    reply.code(201);
    return {
      session,
      snapshot: buildProjectSnapshot(projectId, session.id),
    };
  });

  fastify.get('/api/projects/:projectId/sessions/:sessionId', async (request) => {
    const { projectId, sessionId } = request.params as { projectId: string; sessionId: string };
    const session = agentRuntime.getSession(projectId, sessionId);
    return {
      session,
      messages: db.listMessages(projectId, session.id),
    };
  });

  fastify.patch('/api/projects/:projectId/sessions/:sessionId', async (request) => {
    const { projectId, sessionId } = request.params as { projectId: string; sessionId: string };
    const title = typeof (request.body as { title?: unknown } | undefined)?.title === 'string'
      ? (request.body as { title: string }).title
      : '';
    const session = agentRuntime.renameSession(projectId, sessionId, title);
    events.emit(projectId, 'agent.session.updated', { sessionId: session.id });
    return {
      session,
      sessions: buildSessionSummary(projectId, session.id),
    };
  });

  fastify.delete('/api/projects/:projectId/sessions/:sessionId', async (request) => {
    const { projectId, sessionId } = request.params as { projectId: string; sessionId: string };
    await agentRuntime.deleteSession(projectId, sessionId);
    const nextSessionId = agentRuntime.listSessions(projectId)[0]?.id;
    const activeSession = nextSessionId
      ? agentRuntime.getSession(projectId, nextSessionId)
      : agentRuntime.getOrCreateSession(projectId);
    events.emit(projectId, 'agent.session.deleted', { sessionId });
    return {
      activeSessionId: activeSession.id,
      sessions: buildSessionSummary(projectId, activeSession.id),
    };
  });

  fastify.get('/api/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const sessionId = typeof (request.query as { sessionId?: unknown } | undefined)?.sessionId === 'string'
      ? (request.query as { sessionId: string }).sessionId
      : undefined;
    return buildProjectSnapshot(projectId, sessionId);
  });

  fastify.get('/api/projects/:projectId/document', async (request) => {
    const { projectId } = request.params as { projectId: string };
    return { document: documents.readDocument(projectId) };
  });

  fastify.post('/api/projects/:projectId/assets', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { document, asset } = documents.addAsset(projectId, request.body);
    const payload = request.body as { autoTranscribe?: boolean };
    const job = jobs.enqueueAssetIngest(projectId, asset.id, { autoTranscribe: payload.autoTranscribe ?? true });
    reply.code(202);
    return { document, asset, job };
  });

  fastify.post('/api/projects/:projectId/transcribe', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const payload = transcribeInputSchema.parse(request.body ?? {});
    const language = payload.language === 'auto' ? undefined : payload.language;
    const document = documents.readDocument(projectId);
    const asset = document.assets.find((item) => item.id === document.project.primaryAssetId) ?? document.assets[0];
    if (!asset) {
      reply.code(400);
      return { error: 'No asset available to transcribe.' };
    }
    const job = jobs.enqueueTranscription(projectId, asset.id, { language });
    reply.code(202);
    return { job };
  });

  fastify.post('/api/projects/:projectId/chat', async (request) => {
    const { projectId } = request.params as { projectId: string };
    return chat.run(projectId, request.body);
  });

  fastify.post('/api/projects/:projectId/operations', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const payload = applyOperationInputSchema.parse(request.body);
    const result = documents.applyOperation(projectId, payload.operation, payload.operation.reason || 'Manual timeline update', 'user');
    events.emit(projectId, 'project.revision.created', { revisionId: result.revisionId });
    return result;
  });

  fastify.post('/api/projects/:projectId/export', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const payload = exportInputSchema.parse(request.body ?? {});
    const job = jobs.enqueueExport(projectId, payload.preset);
    reply.code(202);
    return { job };
  });

  fastify.get('/api/projects/:projectId/jobs/:jobId', async (request) => {
    const { jobId } = request.params as { projectId: string; jobId: string };
    return { job: db.getJob(jobId) };
  });

  fastify.get('/api/projects/:projectId/stream', async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ projectId })}\n\n`);

    const unsubscribe = events.subscribe(projectId, (event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on('close', () => {
      unsubscribe();
    });
    return reply;
  });

  fastify.get('/api/projects/:projectId/assets/:assetId/media', async (request, reply) => {
    const { projectId, assetId } = request.params as { projectId: string; assetId: string };
    const variant = (request.query as { variant?: 'original' | 'proxy' }).variant ?? 'proxy';
    const document = documents.readDocument(projectId);
    const asset = document.assets.find((item) => item.id === assetId);
    if (!asset) {
      reply.code(404);
      return { error: 'Asset not found' };
    }
    const filePath = variant === 'proxy' ? asset.proxyPath ?? asset.originalPath : asset.originalPath;
    if (!fs.existsSync(filePath)) {
      reply.code(404);
      return { error: 'Media file not found' };
    }
    return streamFile(request, reply, filePath);
  });

  fastify.get('/api/projects/:projectId/artifacts/:name', async (request, reply) => {
    const { projectId, name } = request.params as { projectId: string; name: string };
    const artifactRoot = projectArtifactsRoot(projectId);
    const artifactPath = path.resolve(artifactRoot, name);
    if (!artifactPath.startsWith(`${artifactRoot}${path.sep}`)) {
      reply.code(400);
      return { error: 'Invalid artifact path' };
    }
    if (!fs.existsSync(artifactPath)) {
      reply.code(404);
      return { error: 'Artifact not found' };
    }
    return streamFile(request, reply, artifactPath);
  });

  return fastify;
}
