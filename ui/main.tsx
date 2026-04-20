import { render } from 'ink';
import React from 'react';

import { createPersistedAgent } from './agent.js';
import { AxcutApp } from './app.js';

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();
  const { agent, sessionId, stateStore, initialMessages } = createPersistedAgent(workspaceRoot);

  const ink = render(
    <AxcutApp
      agent={agent}
      sessionId={sessionId}
      stateStore={stateStore}
      initialMessages={initialMessages}
    />,
    { exitOnCtrlC: false },
  );

  await ink.waitUntilExit();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Axcut UI error: ${message}\n`);
  process.exit(1);
});
