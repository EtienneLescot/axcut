import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
};

export type CreateWorktreeOptions = {
  branchName?: string;
  baseBranch?: string;
  detach?: boolean;
};

export class WorktreeService {
  private readonly worktreesRoot: string;

  constructor(private readonly repoRoot: string, dataRoot: string) {
    this.worktreesRoot = path.join(dataRoot, 'worktrees');
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: this.repoRoot,
        maxBuffer: 1024 * 1024,
      });
      return this.parseWorktreePorcelain(stdout);
    } catch {
      return [];
    }
  }

  async createWorktree(options: CreateWorktreeOptions = {}): Promise<WorktreeInfo> {
    const branchName = this.normalizeBranchName(options.branchName || `axcut-agent-${Date.now().toString(36)}`);
    const worktreePath = path.join(this.worktreesRoot, branchName);
    fs.mkdirSync(this.worktreesRoot, { recursive: true });

    const args = ['worktree', 'add'];
    if (options.detach) {
      args.push('--detach');
    } else {
      args.push('-b', branchName);
    }
    args.push(worktreePath);
    if (options.baseBranch) {
      args.push(options.baseBranch);
    }

    await execFileAsync('git', args, {
      cwd: this.repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });

    const created = await this.findWorktreeByPath(await this.listWorktrees(), worktreePath);
    if (!created) {
      throw new Error('Worktree created but not found in git worktree list.');
    }
    return created;
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    const resolvedWorktreePath = this.resolveManagedWorktreePath(worktreePath);
    const knownWorktree = await this.findWorktreeByPath(await this.listWorktrees(), resolvedWorktreePath);
    if (!knownWorktree) {
      throw new Error('Refusing to remove unknown worktree path.');
    }
    if (knownWorktree.locked) {
      throw new Error('Cannot remove locked worktree. Unlock it with Git before deleting it.');
    }
    await execFileAsync('git', ['worktree', 'remove', resolvedWorktreePath], {
      cwd: this.repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  getWorktreesRoot(): string {
    return this.worktreesRoot;
  }

  private normalizeBranchName(value: string): string {
    const branchName = value.trim();
    if (!branchName) {
      throw new Error('Worktree branch name is required.');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(branchName)) {
      throw new Error('Worktree branch name may only contain letters, numbers, dots, underscores, and hyphens.');
    }
    if (branchName.endsWith('.') || branchName.includes('..') || branchName.endsWith('.lock')) {
      throw new Error('Worktree branch name is not a safe Git branch name.');
    }
    return branchName;
  }

  private resolveManagedWorktreePath(worktreePath: string): string {
    const resolvedRoot = path.resolve(this.worktreesRoot);
    const resolvedWorktreePath = path.resolve(worktreePath);

    try {
      const realRoot = fs.realpathSync(this.worktreesRoot);
      const realWorktreePath = fs.realpathSync(worktreePath);
      if (!isManagedChildPath(realRoot, realWorktreePath)) {
        throw new Error('Refusing to remove worktree outside the managed worktrees directory.');
      }
      return realWorktreePath;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
    }

    if (!isManagedChildPath(resolvedRoot, resolvedWorktreePath)) {
      throw new Error('Refusing to remove worktree outside the managed worktrees directory.');
    }
    return resolvedWorktreePath;
  }

  private async findWorktreeByPath(worktrees: WorktreeInfo[], worktreePath: string): Promise<WorktreeInfo | undefined> {
    const expectedPath = await canonicalPath(worktreePath);
    for (const worktree of worktrees) {
      if (await canonicalPath(worktree.path) === expectedPath) {
        return worktree;
      }
    }
    return undefined;
  }

  private parseWorktreePorcelain(output: string): WorktreeInfo[] {
    const lines = output.trim().split('\n');
    const result: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of lines) {
      if (line === '') {
        if (current.path) {
          result.push(toWorktreeInfo(current));
        }
        current = {};
        continue;
      }

      const spaceIndex = line.indexOf(' ');
      const key = spaceIndex >= 0 ? line.slice(0, spaceIndex) : line;
      const value = spaceIndex >= 0 ? line.slice(spaceIndex + 1) : '';

      if (key === 'worktree') current.path = value;
      if (key === 'HEAD') current.head = value;
      if (key === 'branch') current.branch = value;
      if (key === 'bare') current.bare = true;
      if (key === 'detached') current.detached = true;
      if (key === 'locked') current.locked = true;
    }

    if (current.path) {
      result.push(toWorktreeInfo(current));
    }
    return result;
  }
}

function toWorktreeInfo(current: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: current.path ?? '',
    head: current.head ?? '',
    branch: current.branch,
    bare: current.bare ?? false,
    detached: current.detached ?? false,
    locked: current.locked ?? false,
  };
}

function isManagedChildPath(rootPath: string, childPath: string): boolean {
  const relativePath = path.relative(rootPath, childPath);
  return Boolean(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fs.promises.realpath(value);
  } catch {
    return path.resolve(value);
  }
}
