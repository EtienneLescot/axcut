import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createId } from '../lib/ids.js';

export type ProjectRow = {
  id: string;
  title: string;
  documentPath: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageRow = {
  id: string;
  projectId: string;
  sessionId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  revisionId: string | null;
  createdAt: string;
};

export type JobRow = {
  id: string;
  projectId: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  payloadJson: string;
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export class DatabaseService {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        document_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        revision_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project_id, created_at);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_project_updated ON jobs(project_id, updated_at DESC);
    `);

    const messageColumns = this.db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === 'session_id')) {
      this.db.prepare(`ALTER TABLE messages ADD COLUMN session_id TEXT`).run();
      this.db.prepare(`UPDATE messages SET session_id = project_id WHERE session_id IS NULL`).run();
    }
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_project_session_created ON messages(project_id, session_id, created_at)`).run();
  }

  listProjects(): ProjectRow[] {
    const rows = this.db.prepare(`SELECT id, title, document_path AS documentPath, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC`).all();
    return rows as ProjectRow[];
  }

  getProject(projectId: string): ProjectRow | undefined {
    const row = this.db.prepare(`SELECT id, title, document_path AS documentPath, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?`).get(projectId);
    return row as ProjectRow | undefined;
  }

  upsertProject(row: ProjectRow): ProjectRow {
    this.db.prepare(`
      INSERT INTO projects (id, title, document_path, created_at, updated_at)
      VALUES (@id, @title, @documentPath, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        document_path = excluded.document_path,
        updated_at = excluded.updated_at
    `).run(row);
    return row;
  }

  insertMessage(input: Omit<MessageRow, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): MessageRow {
    const row: MessageRow = {
      id: input.id ?? createId('msg'),
      projectId: input.projectId,
      sessionId: input.sessionId ?? null,
      role: input.role,
      content: input.content,
      revisionId: input.revisionId ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO messages (id, project_id, session_id, role, content, revision_id, created_at) VALUES (@id, @projectId, @sessionId, @role, @content, @revisionId, @createdAt)`).run(row);
    return row;
  }

  listMessages(projectId: string, sessionId?: string): MessageRow[] {
    const rows = sessionId
      ? this.db.prepare(`SELECT id, project_id AS projectId, session_id AS sessionId, role, content, revision_id AS revisionId, created_at AS createdAt FROM messages WHERE project_id = ? AND session_id = ? ORDER BY created_at ASC`).all(projectId, sessionId)
      : this.db.prepare(`SELECT id, project_id AS projectId, session_id AS sessionId, role, content, revision_id AS revisionId, created_at AS createdAt FROM messages WHERE project_id = ? ORDER BY created_at ASC`).all(projectId);
    return rows as MessageRow[];
  }

  countMessagesBySession(projectId: string): Record<string, number> {
    const rows = this.db.prepare(`SELECT COALESCE(session_id, project_id) AS sessionId, COUNT(*) AS messageCount FROM messages WHERE project_id = ? GROUP BY COALESCE(session_id, project_id)`).all(projectId) as Array<{ sessionId: string; messageCount: number }>;
    return Object.fromEntries(rows.map((row) => [row.sessionId, row.messageCount]));
  }

  createJob(projectId: string, kind: string, payload: unknown): JobRow {
    const now = new Date().toISOString();
    const row: JobRow = {
      id: createId('job'),
      projectId,
      kind,
      status: 'queued',
      progress: 0,
      message: 'Queued',
      payloadJson: JSON.stringify(payload ?? {}),
      resultJson: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO jobs (id, project_id, kind, status, progress, message, payload_json, result_json, created_at, updated_at)
      VALUES (@id, @projectId, @kind, @status, @progress, @message, @payloadJson, @resultJson, @createdAt, @updatedAt)
    `).run(row);
    return row;
  }

  updateJob(jobId: string, patch: Partial<Pick<JobRow, 'status' | 'progress' | 'message' | 'resultJson'>>): JobRow {
    const current = this.getJob(jobId);
    if (!current) {
      throw new Error(`Unknown job ${jobId}`);
    }
    const next: JobRow = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(`
      UPDATE jobs
      SET status = @status,
          progress = @progress,
          message = @message,
          result_json = @resultJson,
          updated_at = @updatedAt
      WHERE id = @id
    `).run(next);
    return next;
  }

  markInterruptedJobs(message = 'Interrupted by server restart. Start the job again.'): JobRow[] {
    const rows = this.db.prepare(`
      SELECT id, project_id AS projectId, kind, status, progress, message, payload_json AS payloadJson, result_json AS resultJson, created_at AS createdAt, updated_at AS updatedAt
      FROM jobs
      WHERE status IN ('queued', 'running')
    `).all() as JobRow[];
    if (rows.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE jobs
      SET status = 'failed',
          progress = 1,
          message = @message,
          updated_at = @updatedAt
      WHERE id = @id
    `);
    const run = this.db.transaction((jobs: JobRow[]) => {
      for (const job of jobs) {
        update.run({ id: job.id, message, updatedAt: now });
      }
    });
    run(rows);

    return rows.map((row) => ({
      ...row,
      status: 'failed',
      progress: 1,
      message,
      updatedAt: now,
    }));
  }

  getJob(jobId: string): JobRow | undefined {
    const row = this.db.prepare(`SELECT id, project_id AS projectId, kind, status, progress, message, payload_json AS payloadJson, result_json AS resultJson, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE id = ?`).get(jobId);
    return row as JobRow | undefined;
  }

  listJobs(projectId: string): JobRow[] {
    const rows = this.db.prepare(`SELECT id, project_id AS projectId, kind, status, progress, message, payload_json AS payloadJson, result_json AS resultJson, created_at AS createdAt, updated_at AS updatedAt FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20`).all(projectId);
    return rows as JobRow[];
  }
}
