import { Box, Text, useApp, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import React, { useMemo, useState } from 'react';
import type { CoreMessage } from 'ai';
import type { YagrPhaseEvent, YagrSessionAgent } from '@yagr/agent';
import type { YagrToolEvent } from '@yagr/agent/dist/types.js';

import type { AxcutStateStore } from './state-store.js';

type FeedEntry = {
  id: number;
  lane: 'user' | 'assistant' | 'status' | 'tool';
  text: string;
};

type AxcutAppProps = {
  agent: YagrSessionAgent;
  sessionId: string;
  stateStore: AxcutStateStore;
  initialMessages: readonly CoreMessage[];
};

export function AxcutApp(props: AxcutAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [entries, setEntries] = useState<FeedEntry[]>(() => hydrateEntries(props.initialMessages));
  const [nextId, setNextId] = useState(entries.length + 1);
  const [statusLine, setStatusLine] = useState('Ready');
  const [phase, setPhase] = useState<string>('idle');
  const [isRunning, setIsRunning] = useState(false);
  const [inputVersion, setInputVersion] = useState(0);
  const [inputSeed, setInputSeed] = useState('');

  const sessionState = props.stateStore.get(props.sessionId);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      exit();
    }
  });

  const pushEntry = (lane: FeedEntry['lane'], text: string): void => {
    setEntries((current) => [...current, { id: nextId + current.length, lane, text }].slice(-80));
  };

  const remountInput = (nextValue = ''): void => {
    setInputSeed(nextValue);
    setInputVersion((current) => current + 1);
  };

  const submitPrompt = async (value: string): Promise<void> => {
    const prompt = normalizeSubmittedPrompt(value);
    if (!prompt || isRunning) {
      return;
    }

    remountInput('');
    setEntries((current) => [...current, { id: nextId, lane: 'user' as const, text: prompt }].slice(-80));
    setNextId((current) => current + 1);
    setIsRunning(true);
    setStatusLine('Running');

    try {
      const result = await props.agent.run(prompt, {
        onPhaseChange: async (event: YagrPhaseEvent) => {
          setPhase(event.phase);
          setStatusLine(compactStatus(event.message));
          pushEntry('status', `${event.phase} ${event.status}: ${compactStatus(event.message)}`);
        },
        onStateChange: async (event) => {
          setStatusLine(compactStatus(event.message));
          if (event.phase) {
            setPhase(event.phase);
          }
          pushEntry('status', `${event.state}: ${compactStatus(event.message)}`);
        },
        onToolEvent: async (event: YagrToolEvent) => {
          if (event.type === 'command-start') {
            pushEntry('tool', `$ ${event.command}`);
            return;
          }
          if (event.type === 'command-end' && event.exitCode !== 0) {
            pushEntry('tool', `Command failed with exit code ${event.exitCode}`);
          }
        },
      });

      pushEntry('assistant', result.text);
    } catch (error) {
      pushEntry('assistant', error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunning(false);
    }
  };

  const headerLines = useMemo(() => {
    const lines = [`Session: ${props.sessionId}`, `Phase: ${phase}`, `Status: ${statusLine}`];
    if (sessionState?.videoPath) {
      lines.push(`Video: ${sessionState.videoPath}`);
    }
    if (sessionState?.awaitingConfirmation) {
      lines.push(sessionState.planValidated === false
        ? 'Awaiting: user refinement or `render anyway`'
        : 'Awaiting: user refinement or `render`');
    }
    if (sessionState?.outputVideoPath) {
      lines.push(`Last render: ${sessionState.outputVideoPath}`);
    }
    return lines;
  }, [phase, props.sessionId, sessionState, statusLine]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">Axcut TUI</Text>
        {headerLines.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
        <Text dimColor>
          {sessionState?.planValidated === false
            ? 'Commands: `/reset` to clear the session, `render anyway` to generate the current draft.'
            : 'Commands: `/reset` to clear the session, `render` to generate the current cut.'}
        </Text>
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column" flexGrow={1}>
        <Text bold color="yellow">Conversation</Text>
        {entries.length === 0 ? <Text dimColor>No conversation yet.</Text> : null}
        {entries.map((entry) => renderEntry(entry))}
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor="green" paddingX={1} flexDirection="column">
        <Text bold color="green">Input</Text>
        <TextInput
          key={`axcut-input-${inputVersion}`}
          defaultValue={inputSeed}
          placeholder={isRunning ? 'Run in progress...' : 'Enter a video path, an edit prompt, or reply to the agent'}
          isDisabled={isRunning}
          onChange={(value) => {
            if (!/[\r\n\t]/.test(value)) {
              return;
            }

            remountInput(normalizePastedInput(value));
          }}
          onSubmit={(value) => {
            void submitPrompt(value);
          }}
        />
      </Box>
    </Box>
  );
}

function hydrateEntries(messages: readonly CoreMessage[]): FeedEntry[] {
  const entries: FeedEntry[] = [];
  let nextId = 1;
  for (const message of messages) {
    const text = flattenMessage(message.content);
    if (!text.trim()) {
      continue;
    }
    entries.push({
      id: nextId++,
      lane: message.role === 'user' ? 'user' : 'assistant',
      text,
    });
  }
  return entries;
}

function flattenMessage(content: CoreMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function lanePrefix(lane: FeedEntry['lane']): string {
  switch (lane) {
    case 'user':
      return 'You:';
    case 'assistant':
      return 'Axcut:';
    case 'status':
      return 'Agent:';
    case 'tool':
      return 'Cmd:';
  }
}

function laneColor(lane: FeedEntry['lane']): string {
  switch (lane) {
    case 'user':
      return 'cyan';
    case 'assistant':
      return 'white';
    case 'status':
      return 'magenta';
    case 'tool':
      return 'gray';
  }
}

function normalizePastedInput(value: string): string {
  return sanitizeUserInput(value);
}

function normalizeSubmittedPrompt(value: string): string {
  return sanitizeUserInput(value);
}

function compactStatus(value: string, maxLength = 120): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^-+\s*/, '') ?? '';

  if (firstLine.length <= maxLength) {
    return firstLine;
  }

  return `${firstLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function sanitizeUserInput(value: string): string {
  return value
    .replace(/[│╭╮╰╯]+/g, ' ')
    .replace(/[─]{2,}/g, ' ')
    .replace(/\b(?:You|Axcut|Agent|Cmd):\s*/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function renderEntry(entry: FeedEntry): React.JSX.Element {
  const lines = entry.text.split(/\r?\n/).filter((line, index, array) => line.length > 0 || index < array.length - 1);
  const prefix = lanePrefix(entry.lane);
  const color = laneColor(entry.lane);

  return (
    <Box key={entry.id} flexDirection="column">
      {lines.length === 0 ? (
        <Text color={color}>{prefix}</Text>
      ) : (
        lines.map((line, index) => (
          <Text key={`${entry.id}:${index}`} color={color}>
            {index === 0 ? `${prefix} ${line}` : `  ${line}`}
          </Text>
        ))
      )}
    </Box>
  );
}
