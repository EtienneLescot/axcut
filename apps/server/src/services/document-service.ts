import fs from 'node:fs';
import path from 'node:path';

import {
  addAssetInputSchema,
  createEmptyDocument,
  createProjectInputSchema,
  documentSchema,
  updateProjectInputSchema,
  type AxcutAsset,
  type AxcutDocument,
  type AxcutOperation,
  type AxcutSuggestion,
  type AxcutTranscript,
} from '@axcut/schema';

import { applyDocumentOperation, replaceSuggestions } from '../lib/document-operations.js';
import { appendRevision, refreshProjectUpdatedAt } from '../lib/document-history.js';
import { createId } from '../lib/ids.js';
import { buildTimelineFromIntervals, normalizeIntervals, retimeClips } from '../lib/timeline.js';
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

  updateProject(projectId: string, input: unknown): AxcutDocument {
    const payload = updateProjectInputSchema.parse(input);
    return this.mutateDocument(projectId, 'Project renamed', (current) => ({
      ...current,
      project: {
        ...current.project,
        title: payload.title,
      },
    }));
  }

  getSnapshot(projectId: string, sessionId?: string): { document: AxcutDocument; messages: ReturnType<DatabaseService['listMessages']>; jobs: ReturnType<DatabaseService['listJobs']> } {
    const document = this.readDocument(projectId);
    return {
      document,
      messages: this.db.listMessages(projectId, sessionId),
      jobs: this.db.listJobs(projectId),
    };
  }

  readDocument(projectId: string): AxcutDocument {
    const documentPath = projectDocumentPath(projectId);
    const raw = fs.readFileSync(documentPath, 'utf-8');
    return documentSchema.parse(JSON.parse(raw));
  }

  restoreDocument(projectId: string, snapshot: AxcutDocument, summary: string): AxcutDocument {
    if (snapshot.project.id !== projectId) {
      throw new Error(`Checkpoint document belongs to ${snapshot.project.id}, not ${projectId}.`);
    }
    const document = documentSchema.parse(snapshot);
    this.writeDocument(document, summary);
    return document;
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
      const normalizedTranscript = normalizeTranscriptForAsset(transcript);
      const transcripts = [
        ...current.transcripts.filter((item) => item.assetId !== normalizedTranscript.assetId),
        normalizedTranscript,
      ].sort((left, right) => assetOrder(current, left.assetId) - assetOrder(current, right.assetId));
      const mergedTranscript = mergeTranscripts(transcripts, current.project.primaryAssetId ?? current.assets[0]?.id);
      return {
        ...current,
        transcript: mergedTranscript,
        transcripts,
        timeline: {
          ...current.timeline,
          clips: retimeClips(current.timeline.clips, transcripts),
          gaps: [],
        },
      };
    });
  }

  applyOperation(projectId: string, operation: AxcutOperation, summary: string, author: 'user' | 'agent' | 'system'): { document: AxcutDocument; revisionId: string } {
    const current = this.readDocument(projectId);
    const next = refreshProjectUpdatedAt(appendRevision(applyDocumentOperation(current, operation, author), {
      author,
      summary,
      operations: [operation],
    }, () => createId('rev')));
    this.writeDocument(next, summary);
    return { document: next, revisionId: next.history.revisions.at(-1)?.id ?? '' };
  }

  setSuggestions(projectId: string, suggestions: AxcutSuggestion[], summary: string): AxcutDocument {
    return this.mutateDocument(projectId, summary, (current) => replaceSuggestions(current, suggestions, summary));
  }

  replaceTimeline(projectId: string, intervals: Array<{ startSec: number; endSec: number }>, summary: string, author: 'agent' | 'user' | 'system'): { document: AxcutDocument; revisionId: string } {
    const current = this.readDocument(projectId);
    const assetId = current.project.primaryAssetId ?? current.assets[0]?.id;
    if (!assetId) {
      throw new Error('No asset available to update the timeline.');
    }
    const asset = current.assets.find((item) => item.id === assetId);
    const normalized = normalizeIntervals(asset?.durationSec ?? 0, intervals);
    const next = refreshProjectUpdatedAt(appendRevision(
      {
        ...current,
        timeline: {
          ...current.timeline,
          clips: buildTimelineFromIntervals(assetId, normalized, {
            origin: author,
            reason: summary,
            transcript: current.transcripts.find((transcript) => transcript.assetId === assetId) ?? null,
          }),
          gaps: [],
        },
        agent: {
          ...current.agent,
          suggestions: [],
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
      () => createId('rev'),
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
    next = refreshProjectUpdatedAt(next);
    this.writeDocument(next, summary, updateProjectRow);
    return next;
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

function scopedId(assetId: string, id: string): string {
  return id.startsWith(`${assetId}:`) ? id : `${assetId}:${id}`;
}

function normalizeTranscriptForAsset(transcript: AxcutTranscript): AxcutTranscript {
  const segmentIds = new Map(transcript.segments.map((segment) => [segment.id, scopedId(transcript.assetId, segment.id)]));
  const wordIds = new Map(transcript.words.map((word) => [word.id, scopedId(transcript.assetId, word.id)]));
  return {
    ...transcript,
    segments: transcript.segments.map((segment) => ({
      ...segment,
      id: scopedId(transcript.assetId, segment.id),
      assetId: transcript.assetId,
      wordIds: segment.wordIds.map((wordId) => wordIds.get(wordId) ?? scopedId(transcript.assetId, wordId)),
    })),
    words: transcript.words.map((word) => ({
      ...word,
      id: scopedId(transcript.assetId, word.id),
      assetId: transcript.assetId,
      segmentId: segmentIds.get(word.segmentId) ?? scopedId(transcript.assetId, word.segmentId),
    })),
  };
}

function mergeTranscripts(transcripts: AxcutTranscript[], primaryAssetId?: string): AxcutTranscript | null {
  if (transcripts.length === 0) {
    return null;
  }
  const primary = transcripts.find((item) => item.assetId === primaryAssetId) ?? transcripts[0];
  const languages = [...new Set(transcripts.map((item) => item.language).filter(Boolean))];
  return {
    assetId: primary.assetId,
    language: languages.length === 1 ? languages[0] : 'multi',
    sourceDslPath: primary.sourceDslPath,
    sourceJsonPath: primary.sourceJsonPath,
    segments: transcripts.flatMap((item) => item.segments),
    words: transcripts.flatMap((item) => item.words),
  };
}

function assetOrder(document: AxcutDocument, assetId: string): number {
  const index = document.assets.findIndex((asset) => asset.id === assetId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
