import fs from 'node:fs';
import path from 'node:path';

import {
  addAssetInputSchema,
  createEmptyDocument,
  createProjectInputSchema,
  documentSchema,
  type AxcutAsset,
  type AxcutDocument,
  type AxcutOperation,
  type AxcutRevision,
  type AxcutTranscript,
} from '@axcut/schema';

import { createId } from '../lib/ids.js';
import { applyTimelineOperation, buildTimelineFromIntervals, normalizeIntervals } from '../lib/timeline.js';
import { projectArtifactsRoot, projectDocumentPath, projectRoot } from '../lib/paths.js';
import type { DatabaseService } from './database.js';

const allowedAssetExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

export class DocumentService {
  constructor(private readonly db: DatabaseService) {}

  listProjects(): Array<{ id: string; title: string; updatedAt: string }> {
    return this.db.listProjects().map((row) => ({ id: row.id, title: row.title, updatedAt: row.updatedAt }));
  }

  createProject(input: unknown): AxcutDocument {
    const payload = createProjectInputSchema.parse(input);
    const projectId = createId('proj');
    const document = createEmptyDocument({ projectId, title: payload.title });
    this.writeDocument(document, 'Project created');
    return document;
  }

  getSnapshot(projectId: string): { document: AxcutDocument; messages: ReturnType<DatabaseService['listMessages']>; jobs: ReturnType<DatabaseService['listJobs']> } {
    return {
      document: this.readDocument(projectId),
      messages: this.db.listMessages(projectId),
      jobs: this.db.listJobs(projectId),
    };
  }

  readDocument(projectId: string): AxcutDocument {
    const documentPath = projectDocumentPath(projectId);
    const raw = fs.readFileSync(documentPath, 'utf-8');
    return documentSchema.parse(JSON.parse(raw));
  }

  addAsset(projectId: string, input: unknown): { document: AxcutDocument; asset: AxcutAsset } {
    const payload = addAssetInputSchema.parse(input);
    const resolvedPath = path.resolve(payload.path);
    this.assertAttachableAssetPath(resolvedPath);
    const asset: AxcutAsset = {
      id: createId('asset'),
      kind: 'video',
      label: payload.label?.trim() || path.basename(resolvedPath),
      originalPath: resolvedPath,
    };
    const document = this.mutateDocument(projectId, 'Asset attached', (current) => ({
      ...current,
      project: {
        ...current.project,
        primaryAssetId: current.project.primaryAssetId ?? asset.id,
      },
      assets: [...current.assets, asset],
    }));
    return { document, asset };
  }

  updateAsset(projectId: string, assetId: string, patch: Partial<AxcutAsset>, summary: string): AxcutDocument {
    return this.mutateDocument(projectId, summary, (current) => ({
      ...current,
      assets: current.assets.map((asset) => (asset.id === assetId ? { ...asset, ...patch } : asset)),
    }));
  }

  updateTranscript(projectId: string, transcript: AxcutTranscript, summary: string): AxcutDocument {
    return this.mutateDocument(projectId, summary, (current) => {
      const asset = current.assets.find((item) => item.id === transcript.assetId);
      const fullIntervals = asset?.durationSec ? [{ startSec: 0, endSec: asset.durationSec }] : [];
      return {
        ...current,
        transcript,
        timeline: {
          ...current.timeline,
          clips: buildTimelineFromIntervals(transcript.assetId, fullIntervals, {
            origin: 'system',
            reason: 'Initial full-length timeline from transcript import',
            transcript,
          }),
          gaps: [],
        },
      };
    });
  }

  applyOperation(projectId: string, operation: AxcutOperation, summary: string, author: 'user' | 'agent' | 'system'): { document: AxcutDocument; revisionId: string } {
    const current = this.readDocument(projectId);
    const next = this.refreshUpdatedAt(this.appendRevision(applyTimelineOperation(current, operation), {
      author,
      summary,
      operations: [operation],
    }));
    this.writeDocument(next, summary);
    return { document: next, revisionId: next.history.revisions.at(-1)?.id ?? '' };
  }

  replaceTimeline(projectId: string, intervals: Array<{ startSec: number; endSec: number }>, summary: string, author: 'agent' | 'user' | 'system'): { document: AxcutDocument; revisionId: string } {
    const current = this.readDocument(projectId);
    const assetId = current.project.primaryAssetId ?? current.assets[0]?.id;
    if (!assetId) {
      throw new Error('No asset available to update the timeline.');
    }
    const asset = current.assets.find((item) => item.id === assetId);
    const normalized = normalizeIntervals(asset?.durationSec ?? 0, intervals);
    const next = this.refreshUpdatedAt(this.appendRevision(
      {
        ...current,
        timeline: {
          ...current.timeline,
          clips: buildTimelineFromIntervals(assetId, normalized, {
            origin: author,
            reason: summary,
            transcript: current.transcript,
          }),
          gaps: [],
        },
        agent: {
          ...current.agent,
          lastReasoningSummary: summary,
          lastAppliedOperations: ['replace_timeline'],
        },
        preview: {
          ...current.preview,
          revision: current.preview.revision + 1,
        },
      },
      {
        author,
        summary,
        operations: [{ type: 'replace_timeline', reason: summary, intervals: normalized }],
      },
    ));
    this.writeDocument(next, summary);
    return { document: next, revisionId: next.history.revisions.at(-1)?.id ?? '' };
  }

  updateExportState(projectId: string, patch: Partial<AxcutDocument['export']>): AxcutDocument {
    return this.mutateDocument(projectId, 'Export state updated', (current) => ({
      ...current,
      export: {
        ...current.export,
        ...patch,
      },
    }));
  }

  private mutateDocument(
    projectId: string,
    summary: string,
    updater: (current: AxcutDocument) => AxcutDocument,
    updateProjectRow = true,
  ): AxcutDocument {
    const current = this.readDocument(projectId);
    let next = updater(current);
    next = {
      ...next,
      project: {
        ...next.project,
        updatedAt: new Date().toISOString(),
      },
    };
    this.writeDocument(next, summary, updateProjectRow);
    return next;
  }

  private appendRevision(document: AxcutDocument, input: { author: 'system' | 'agent' | 'user'; summary: string; operations: AxcutRevision['operations'] }): AxcutDocument {
    const revision: AxcutRevision = {
      id: createId('rev'),
      createdAt: new Date().toISOString(),
      author: input.author,
      summary: input.summary,
      operations: input.operations,
    };
    return {
      ...document,
      history: {
        revisions: [...document.history.revisions, revision],
      },
    };
  }

  private refreshUpdatedAt(document: AxcutDocument): AxcutDocument {
    return {
      ...document,
      project: {
        ...document.project,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  private assertAttachableAssetPath(filePath: string): void {
    const stats = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stats || !stats.isFile()) {
      throw new Error('Asset path must point to an existing local video file.');
    }
    const extension = path.extname(filePath).toLowerCase();
    if (!allowedAssetExtensions.has(extension)) {
      throw new Error(`Unsupported asset type ${extension || '[no extension]'}.`);
    }
  }

  private writeDocument(document: AxcutDocument, summary: string, updateProjectRow = true): void {
    const documentPath = projectDocumentPath(document.project.id);
    fs.mkdirSync(projectRoot(document.project.id), { recursive: true });
    fs.mkdirSync(projectArtifactsRoot(document.project.id), { recursive: true });
    fs.writeFileSync(documentPath, `${JSON.stringify(documentSchema.parse(document), null, 2)}\n`, 'utf-8');
    if (updateProjectRow) {
      this.db.upsertProject({
        id: document.project.id,
        title: document.project.title,
        documentPath,
        createdAt: document.project.createdAt,
        updatedAt: document.project.updatedAt,
      });
    }
    if (summary) {
      void summary;
    }
  }
}
