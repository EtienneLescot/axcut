import { spawn } from 'node:child_process';
import path from 'node:path';

import { repoRoot } from '../lib/paths.js';

type WorkerResponse<T> = {
  ok: boolean;
  data: T;
};

export class PythonWorker {
  private readonly pythonExecutable = path.join(repoRoot, '.venv', 'bin', 'python');
  private readonly pythonPath = [
    path.join(repoRoot, 'py', 'axcut-core', 'src'),
    path.join(repoRoot, 'py', 'axcut-worker', 'src'),
  ].join(path.delimiter);

  async probe(videoPath: string): Promise<WorkerResponse<Record<string, unknown>>> {
    return this.runJson(['probe', '--video', videoPath]);
  }

  async createProxy(videoPath: string, outputPath: string): Promise<WorkerResponse<Record<string, unknown>>> {
    return this.runJson(['proxy', '--video', videoPath, '--output', outputPath]);
  }

  async transcribe(videoPath: string, assetId: string, dslOutput: string, jsonOutput: string, language?: string): Promise<WorkerResponse<Record<string, unknown>>> {
    return this.runJson([
      'transcribe',
      '--video', videoPath,
      '--asset-id', assetId,
      '--dsl-output', dslOutput,
      '--json-output', jsonOutput,
      ...(language ? ['--language', language] : []),
    ]);
  }

  async exportVideo(videoPath: string, intervalsPath: string, outputPath: string): Promise<WorkerResponse<Record<string, unknown>>> {
    return this.runJson(['export', '--video', videoPath, '--intervals', intervalsPath, '--output', outputPath]);
  }

  private async runJson<T>(args: string[]): Promise<WorkerResponse<T>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonExecutable, ['-m', 'axcut_worker.cli', ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PYTHONPATH: this.pythonPath,
        },
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Python worker failed with exit code ${code}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as WorkerResponse<T>);
        } catch (error) {
          reject(new Error(`Invalid worker JSON output: ${stdout}\n${String(error)}`));
        }
      });
    });
  }
}
