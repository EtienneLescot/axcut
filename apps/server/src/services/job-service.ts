import fs from 'node:fs';
import path from 'node:path';

import type { AxcutTranscript } from '@axcut/schema';

import { createId } from '../lib/ids.js';
import { projectArtifactsRoot } from '../lib/paths.js';
import type { DatabaseService, JobRow } from './database.js';
import type { DocumentService } from './document-service.js';
import type { EventBus } from './event-bus.js';
import type { PythonWorker } from './python-worker.js';

export class JobService {
  constructor(
    private readonly db: DatabaseService,
    private readonly documents: DocumentService,
    private readonly worker: PythonWorker,
    private readonly events: EventBus,
  ) {}

  enqueueAssetIngest(projectId: string, assetId: string, options: { autoTranscribe: boolean; language?: string }): JobRow {
    const job = this.db.createJob(projectId, 'ingest_asset', { assetId, autoTranscribe: options.autoTranscribe, language: options.language ?? 'auto' });
    this.events.emit(projectId, 'job.queued', { jobId: job.id, kind: job.kind });
    queueMicrotask(() => {
      void this.runAssetIngest(job.id, projectId, assetId, options.autoTranscribe, options.language);
    });
    return job;
  }

  enqueueTranscription(projectId: string, assetId: string, options: { language?: string }): JobRow {
    const job = this.db.createJob(projectId, 'transcribe_asset', { assetId, language: options.language ?? 'auto' });
    this.events.emit(projectId, 'job.queued', { jobId: job.id, kind: job.kind });
    queueMicrotask(() => {
      void this.runAssetTranscription(job.id, projectId, assetId, options.language);
    });
    return job;
  }

  enqueueExport(projectId: string, preset: string): JobRow {
    const job = this.db.createJob(projectId, 'export', { preset });
    this.events.emit(projectId, 'job.queued', { jobId: job.id, kind: job.kind });
    queueMicrotask(() => {
      void this.runExport(job.id, projectId, preset);
    });
    return job;
  }

  private async runAssetIngest(jobId: string, projectId: string, assetId: string, autoTranscribe: boolean, language?: string): Promise<void> {
    try {
      this.update(jobId, projectId, { status: 'running', progress: 0.05, message: 'Preparing asset ingest' });
      const snapshot = this.documents.getSnapshot(projectId).document;
      const asset = snapshot.assets.find((item) => item.id === assetId);
      if (!asset) {
        throw new Error(`Unknown asset ${assetId}`);
      }

      this.update(jobId, projectId, { status: 'running', progress: 0.15, message: 'Probing source media' });
      const probe = await this.worker.probe(asset.originalPath);
      this.documents.updateAsset(projectId, assetId, probe.data as never, 'Asset media metadata updated');
      this.documents.ensureFullTimelineForAsset(projectId, assetId, 'Initial full-length timeline from media probe');
      this.events.emit(projectId, 'project.asset.updated', { assetId });

      const artifactsRoot = projectArtifactsRoot(projectId);
      const proxyPath = path.join(artifactsRoot, `${assetId}-proxy.mp4`);
      this.update(jobId, projectId, { status: 'running', progress: 0.4, message: 'Generating proxy media' });
      await this.worker.createProxy(asset.originalPath, proxyPath);
      this.documents.updateAsset(projectId, assetId, { proxyPath }, 'Proxy media generated');
      this.events.emit(projectId, 'preview.ready', { assetId, proxyPath });

      if (autoTranscribe) {
        await this.transcribeAsset(jobId, projectId, assetId, asset.originalPath, 0.7, language);
      }

      this.update(jobId, projectId, { status: 'completed', progress: 1, message: 'Asset ingest completed', resultJson: JSON.stringify({ assetId }) });
      this.events.emit(projectId, 'job.completed', { jobId, kind: 'ingest_asset' });
    } catch (error) {
      this.update(jobId, projectId, { status: 'failed', progress: 1, message: error instanceof Error ? error.message : String(error) });
      this.events.emit(projectId, 'job.failed', { jobId, kind: 'ingest_asset', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async runAssetTranscription(jobId: string, projectId: string, assetId: string, language?: string): Promise<void> {
    try {
      this.update(jobId, projectId, { status: 'running', progress: 0.05, message: 'Preparing transcription' });
      const document = this.documents.getSnapshot(projectId).document;
      const asset = document.assets.find((item) => item.id === assetId);
      if (!asset) {
        throw new Error(`Unknown asset ${assetId}`);
      }

      await this.transcribeAsset(jobId, projectId, assetId, asset.originalPath, 0.15, language);
      this.update(jobId, projectId, { status: 'completed', progress: 1, message: 'Transcript regenerated', resultJson: JSON.stringify({ assetId, language: language ?? 'auto' }) });
      this.events.emit(projectId, 'job.completed', { jobId, kind: 'transcribe_asset' });
    } catch (error) {
      this.update(jobId, projectId, { status: 'failed', progress: 1, message: error instanceof Error ? error.message : String(error) });
      this.events.emit(projectId, 'job.failed', { jobId, kind: 'transcribe_asset', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async transcribeAsset(jobId: string, projectId: string, assetId: string, originalPath: string, progress: number, language?: string): Promise<void> {
    const artifactsRoot = projectArtifactsRoot(projectId);
    const dslOutput = path.join(artifactsRoot, `${assetId}-transcript.axcut`);
    const jsonOutput = path.join(artifactsRoot, `${assetId}-transcript.json`);
    const languageLabel = language ? language : 'auto-detect';
    this.update(jobId, projectId, { status: 'running', progress, message: `Transcribing media (${languageLabel})` });
    const transcript = await this.worker.transcribe(originalPath, assetId, dslOutput, jsonOutput, language);
    this.documents.updateTranscript(projectId, transcript.data.transcript as AxcutTranscript, 'Transcript imported');
    this.events.emit(projectId, 'project.transcript.updated', { assetId });
  }

  private async runExport(jobId: string, projectId: string, preset: string): Promise<void> {
    try {
      const document = this.documents.getSnapshot(projectId).document;
      const asset = document.assets.find((item) => item.id === document.project.primaryAssetId) ?? document.assets[0];
      if (!asset) {
        throw new Error('No asset available for export.');
      }
      const intervals = document.timeline.clips.map((clip) => ({ start: clip.sourceStartSec, end: clip.sourceEndSec }));
      const artifactsRoot = projectArtifactsRoot(projectId);
      fs.mkdirSync(artifactsRoot, { recursive: true });
      const intervalsPath = path.join(artifactsRoot, `${createId('intervals')}.json`);
      const outputPath = path.join(artifactsRoot, `${createId('export')}.mp4`);
      fs.writeFileSync(intervalsPath, `${JSON.stringify(intervals, null, 2)}\n`, 'utf-8');

      this.documents.updateExportState(projectId, { lastJobId: jobId, preset: preset as never });
      this.update(jobId, projectId, { status: 'running', progress: 0.3, message: 'Rendering export' });
      await this.worker.exportVideo(asset.originalPath, intervalsPath, outputPath);
      this.update(jobId, projectId, { status: 'completed', progress: 1, message: 'Export completed', resultJson: JSON.stringify({ outputPath }) });
      this.events.emit(projectId, 'job.completed', { jobId, kind: 'export', outputPath });
    } catch (error) {
      this.update(jobId, projectId, { status: 'failed', progress: 1, message: error instanceof Error ? error.message : String(error) });
      this.events.emit(projectId, 'job.failed', { jobId, kind: 'export', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private update(jobId: string, projectId: string, patch: Partial<Pick<JobRow, 'status' | 'progress' | 'message' | 'resultJson'>>): void {
    const job = this.db.updateJob(jobId, patch);
    this.events.emit(projectId, 'job.progress', {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      message: job.message,
    });
  }
}
