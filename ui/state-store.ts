import fs from 'node:fs';
import path from 'node:path';

import type { AxcutSessionState } from './types.js';

export class AxcutStateStore {
  constructor(private readonly directory: string) {}

  get(sessionId: string): AxcutSessionState | undefined {
    const filePath = this.filePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AxcutSessionState;
    } catch {
      return undefined;
    }
  }

  save(state: AxcutSessionState): void {
    this.ensureDir();
    fs.writeFileSync(this.filePath(state.sessionId), JSON.stringify(state, null, 2), 'utf-8');
  }

  clear(sessionId: string): void {
    const filePath = this.filePath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  private filePath(sessionId: string): string {
    return path.join(this.directory, `${sessionId}.json`);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.directory)) {
      fs.mkdirSync(this.directory, { recursive: true });
    }
  }
}
