import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(currentDir, '../../../../');
export const dataRoot = path.join(repoRoot, '.axcut-data');
export const projectsRoot = path.join(dataRoot, 'projects');
export const agentSessionsRoot = path.join(dataRoot, 'deepagent-sessions');
export const llmConfigPath = path.join(dataRoot, 'llm-config.json');
export const databasePath = path.join(dataRoot, 'metadata.sqlite');

export function projectRoot(projectId: string): string {
  return path.join(projectsRoot, projectId);
}

export function projectArtifactsRoot(projectId: string): string {
  return path.join(projectRoot(projectId), 'artifacts');
}

export function projectDocumentPath(projectId: string): string {
  return path.join(projectRoot(projectId), 'project.axcut');
}
