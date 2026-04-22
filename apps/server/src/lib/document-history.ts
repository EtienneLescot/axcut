import type { AxcutDocument, AxcutRevision } from '@axcut/schema';

export function appendRevision(
  document: AxcutDocument,
  input: Omit<AxcutRevision, 'id' | 'createdAt'>,
  createRevisionId: () => string,
  createdAt = new Date().toISOString(),
): AxcutDocument {
  const revision: AxcutRevision = {
    id: createRevisionId(),
    createdAt,
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

export function refreshProjectUpdatedAt(
  document: AxcutDocument,
  updatedAt = new Date().toISOString(),
): AxcutDocument {
  return {
    ...document,
    project: {
      ...document.project,
      updatedAt,
    },
  };
}
