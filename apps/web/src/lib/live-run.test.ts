import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyLiveRunState, reduceLiveRunState, type ProjectStreamEvent } from './live-run.js';

function event(input: Partial<ProjectStreamEvent> & Pick<ProjectStreamEvent, 'type'>): ProjectStreamEvent {
  return {
    type: input.type,
    projectId: input.projectId ?? 'proj_test',
    createdAt: input.createdAt ?? '2026-04-22T20:00:00.000Z',
    payload: input.payload ?? {},
  };
}

test('agent.message.user resets and starts a live run', () => {
  const next = reduceLiveRunState(emptyLiveRunState, event({
    type: 'agent.message.user',
    payload: { content: 'Cut pauses' },
  }));

  assert.equal(next.active, true);
  assert.equal(next.userMessage, 'Cut pauses');
  assert.equal(next.assistantDraft, '');
});

test('message and thinking deltas accumulate', () => {
  const started = reduceLiveRunState(emptyLiveRunState, event({ type: 'agent.message.user', payload: { content: 'Cut pauses' } }));
  const withThinking = reduceLiveRunState(started, event({ type: 'agent.thinking.delta', payload: { delta: 'Inspecting transcript. ' } }));
  const withText = reduceLiveRunState(withThinking, event({ type: 'agent.message.delta', payload: { delta: 'Prepared ' } }));
  const completed = reduceLiveRunState(withText, event({ type: 'agent.message.delta', payload: { delta: 'suggestions.' } }));

  assert.equal(completed.thinking, 'Inspecting transcript. ');
  assert.equal(completed.assistantDraft, 'Prepared suggestions.');
});

test('operation events are upserted by operation id', () => {
  const started = reduceLiveRunState(emptyLiveRunState, event({ type: 'agent.message.user', payload: { content: 'Cut pauses' } }));
  const running = reduceLiveRunState(started, event({
    type: 'agent.operation',
    payload: {
      operation: {
        operationId: 'op_1',
        label: 'suggest_cuts',
        category: 'tool',
        status: 'running',
        startedAt: 1,
      },
    },
  }));
  const done = reduceLiveRunState(running, event({
    type: 'agent.operation',
    payload: {
      operation: {
        operationId: 'op_1',
        label: 'suggest_cuts',
        category: 'tool',
        status: 'done',
        startedAt: 1,
        endedAt: 2,
        summary: 'Prepared 6 suggestions',
      },
    },
  }));

  assert.equal(done.operations.length, 1);
  assert.equal(done.operations[0].status, 'done');
  assert.equal(done.operations[0].summary, 'Prepared 6 suggestions');
});

test('transient thinking operations are hidden when complete', () => {
  const started = reduceLiveRunState(emptyLiveRunState, event({ type: 'agent.message.user', payload: { content: 'Say hi' } }));
  const thinking = reduceLiveRunState(started, event({
    type: 'agent.operation',
    payload: {
      operation: {
        operationId: 'thinking:1',
        label: 'Thinking',
        category: 'thinking',
        status: 'running',
        summary: 'Model is planning the next step.',
        startedAt: 1,
      },
    },
  }));
  const done = reduceLiveRunState(thinking, event({
    type: 'agent.operation',
    payload: {
      operation: {
        operationId: 'thinking:1',
        label: 'Thinking',
        category: 'thinking',
        status: 'done',
        startedAt: 1,
        endedAt: 2,
      },
    },
  }));

  assert.equal(thinking.operations.length, 1);
  assert.equal(done.operations.length, 0);
});

test('assistant final message clears live operations so the conversation ends on the answer', () => {
  const started = reduceLiveRunState(emptyLiveRunState, event({ type: 'agent.message.user', payload: { content: 'Cut silence' } }));
  const withOperation = reduceLiveRunState(started, event({
    type: 'agent.operation',
    payload: {
      operation: {
        operationId: 'op_1',
        label: 'Apply Timeline Operation',
        category: 'tool',
        status: 'done',
        summary: 'Tool completed.',
        startedAt: 1,
        endedAt: 2,
      },
    },
  }));
  const finalized = reduceLiveRunState(withOperation, event({
    type: 'agent.message.assistant',
    payload: { content: 'I cut the silent parts.' },
  }));
  const lateOperation = reduceLiveRunState(finalized, event({
    type: 'agent.operation',
    payload: {
      operation: {
        operationId: 'op_1',
        label: 'Apply Timeline Operation',
        category: 'tool',
        status: 'done',
        startedAt: 1,
        endedAt: 2,
      },
    },
  }));

  assert.equal(withOperation.operations.length, 1);
  assert.deepEqual(finalized, emptyLiveRunState);
  assert.deepEqual(lateOperation, emptyLiveRunState);
});
