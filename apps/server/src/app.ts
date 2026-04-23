import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { applyOperationInputSchema, exportInputSchema } from '@axcut/schema';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';

import { streamFile } from './lib/media-stream.js';
import { databasePath, projectArtifactsRoot } from './lib/paths.js';
import { AxcutAgentRuntime } from './services/axcut-agent-runtime.js';
import { ChatService } from './services/chat-service.js';
import { DatabaseService } from './services/database.js';
import { DocumentService } from './services/document-service.js';
import { EventBus } from './services/event-bus.js';
import { JobService } from './services/job-service.js';
import { PythonWorker } from './services/python-worker.js';

export async function createServer() {
  const fastify = Fastify({ logger: true });
  await fastify.register(cors, {
    origin: ['http://127.0.0.1:5173', 'http://localhost:5173'],
  });
  const sessionToken = randomUUID();

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
  const documents = new DocumentService(db);
  const worker = new PythonWorker();
  const jobs = new JobService(db, documents, worker, events);
  const agentRuntime = new AxcutAgentRuntime(documents, events);
  const chat = new ChatService(db, documents, agentRuntime, events);

  fastify.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: 'Validation error',
        issues: error.issues,
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

  fastify.get('/api/projects', async () => ({ projects: documents.listProjects() }));

  fastify.post('/api/projects', async (request, reply) => {
    const document = documents.createProject(request.body);
    reply.code(201);
    return { document };
  });

  fastify.get('/api/projects/:projectId', async (request) => {
    const { projectId } = request.params as { projectId: string };
    return documents.getSnapshot(projectId);
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
    const document = documents.readDocument(projectId);
    const asset = document.assets.find((item) => item.id === document.project.primaryAssetId) ?? document.assets[0];
    if (!asset) {
      reply.code(400);
      return { error: 'No asset available to transcribe.' };
    }
    const job = jobs.enqueueAssetIngest(projectId, asset.id, { autoTranscribe: true });
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
    await streamFile(request, reply, filePath);
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
    await streamFile(request, reply, artifactPath);
  });

  return fastify;
}
