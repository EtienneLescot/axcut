import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import type { CoreMessage } from 'ai';
import type {
  YagrAgentState,
  YagrPhaseEvent,
  YagrRunJournalEntry,
  YagrRunOptions,
  YagrRunPhase,
  YagrRunResult,
  YagrStateEvent,
} from '@yagr/agent';
import type { YagrToolEvent } from '@yagr/agent/dist/types.js';

import { AxcutStateStore } from './state-store.js';
import type { AxcutSessionState, EditPlan, EditSuggestion } from './types.js';

type ExecuteRunResult = {
  result: YagrRunResult;
  persistedMessages: CoreMessage[];
  workspaceInstructionsMayHaveChanged: boolean;
};

type AxcutRunEngineOptions = {
  workspaceRoot: string;
  sessionId: string;
  history: readonly CoreMessage[];
  stateStore: AxcutStateStore;
};

class AxcutCommandError extends Error {
  constructor(
    readonly status: string,
    readonly details: string,
  ) {
    super(details);
    this.name = 'AxcutCommandError';
  }
}

type CommandFailureSummary = {
  status: string;
  details: string;
};

type PlanReviewStatus = {
  validated: boolean;
  issues: string[];
};

export class AxcutRunEngine {
  constructor(private readonly options: AxcutRunEngineOptions) {}

  async execute(prompt: string, runOptions: YagrRunOptions = {}): Promise<ExecuteRunResult> {
    const runId = randomUUID();
    const journal: YagrRunJournalEntry[] = [];
    const userPrompt = prompt.trim();
    const persistedMessages: CoreMessage[] = [{ role: 'user', content: userPrompt }];
    let assistantText = '';

    const pushJournal = async (entry: YagrRunJournalEntry): Promise<void> => {
      journal.push(entry);
      await runOptions.onJournalEntry?.(entry);
    };

    const emitState = async (state: YagrAgentState, message: string, phase?: YagrRunPhase): Promise<void> => {
      const event: YagrStateEvent = { state, message, ...(phase ? { phase } : {}) };
      await runOptions.onStateChange?.(event);
      await pushJournal({
        timestamp: new Date().toISOString(),
        type: 'state',
        status: state === 'failed_terminal' ? 'failed' : 'completed',
        message,
        state,
        phase,
        runId,
      });
    };

    const emitPhase = async (phase: YagrRunPhase, status: YagrPhaseEvent['status'], message: string): Promise<void> => {
      const event: YagrPhaseEvent = { phase, status, message };
      await runOptions.onPhaseChange?.(event);
      await pushJournal({
        timestamp: new Date().toISOString(),
        type: 'phase',
        status: status === 'completed' ? 'completed' : 'started',
        message,
        phase,
        runId,
      });
    };

    const emitTool = async (event: YagrToolEvent): Promise<void> => {
      await runOptions.onToolEvent?.(event);
    };

    try {
      await emitState('running', 'Axcut session started.');

      if (userPrompt === '/reset') {
        this.options.stateStore.clear(this.options.sessionId);
        assistantText = 'Session réinitialisée. Donne-moi une vidéo `.mp4` puis ton intention de montage.';
        persistedMessages.push({ role: 'assistant', content: assistantText });
        await emitState('completed', 'Session reset completed.');
        return {
          result: buildResult(runId, assistantText, journal, 'completed'),
          persistedMessages,
          workspaceInstructionsMayHaveChanged: false,
        };
      }

      const currentState = this.options.stateStore.get(this.options.sessionId) ?? createEmptyState(this.options.sessionId);
      const nextState = { ...currentState };

      await emitPhase('inspect', 'started', 'Inspecting conversation state and input.');
      const detectedVideoPath = resolveVideoPath(userPrompt, this.options.workspaceRoot);
      if (detectedVideoPath) {
        nextState.videoPath = detectedVideoPath;
        nextState.artifactDir = artifactDirForVideo(this.options.workspaceRoot, detectedVideoPath);
      }

      if (!nextState.videoPath) {
        assistantText = 'Je n’ai pas encore de vidéo active. Donne-moi un chemin `.mp4`, par exemple `2026-03-10 09-10-39.mp4`, puis ton intention de montage.';
        persistedMessages.push({ role: 'assistant', content: assistantText });
        await emitPhase('inspect', 'completed', 'No video selected yet.');
        await emitState('waiting_for_input', 'Waiting for a video path.', 'inspect');
        return {
          result: buildResult(runId, assistantText, journal, 'waiting_for_input', 'inspect'),
          persistedMessages,
          workspaceInstructionsMayHaveChanged: false,
        };
      }
      await emitPhase('inspect', 'completed', 'Video context resolved.');

      const action = classifyPrompt(userPrompt, nextState);
      if (action === 'render' || action === 'force_render') {
        if (!nextState.transcriptPath || !nextState.planPath) {
          assistantText = 'Je n’ai pas encore de plan prêt à rendre. Donne-moi d’abord une intention de montage.';
          persistedMessages.push({ role: 'assistant', content: assistantText });
          await emitState('waiting_for_input', 'Waiting for an edit prompt.');
          return {
            result: buildResult(runId, assistantText, journal, 'waiting_for_input'),
            persistedMessages,
            workspaceInstructionsMayHaveChanged: false,
          };
        }
        if (nextState.planValidated === false && action !== 'force_render') {
          assistantText = [
            'Le plan actuel est un brouillon qui n’a pas encore passé la validation interne.',
            'Réponds pour l’affiner, ou tape `render anyway` si tu veux quand même rendre ce brouillon.',
          ].join('\n');
          persistedMessages.push({ role: 'assistant', content: assistantText });
          await emitState('waiting_for_input', 'Waiting for user refinement or explicit draft render.', 'summarize');
          return {
            result: buildResult(runId, assistantText, journal, 'waiting_for_input', 'summarize'),
            persistedMessages,
            workspaceInstructionsMayHaveChanged: false,
          };
        }

        await emitPhase('sync', 'started', 'Rendering the cut video.');
        const outputVideoPath = path.join(nextState.artifactDir!, '05_cut.mp4');
        await runAxcutCommand(
          [
            'render',
            '--video', nextState.videoPath,
            '--transcript', nextState.transcriptPath,
            '--plan', nextState.planPath,
            '--output-video', outputVideoPath,
          ],
          this.options.workspaceRoot,
          emitTool,
        );
        nextState.outputVideoPath = outputVideoPath;
        nextState.awaitingConfirmation = false;
        nextState.updatedAt = new Date().toISOString();
        this.options.stateStore.save(nextState);
        await emitPhase('sync', 'completed', 'Video render completed.');
        await emitState('completed', 'Video generated successfully.');

        assistantText = [
          `Video cut generated: ${outputVideoPath}`,
          nextState.cleanedPath ? `Cleaned transcript: ${nextState.cleanedPath}` : '',
          nextState.planPath ? `Edit plan: ${nextState.planPath}` : '',
        ].filter(Boolean).join('\n');
        persistedMessages.push({ role: 'assistant', content: assistantText });
        return {
          result: buildResult(runId, assistantText, journal, 'completed', 'summarize'),
          persistedMessages,
          workspaceInstructionsMayHaveChanged: false,
        };
      }

      const effectiveEditPrompt = deriveEffectivePrompt(userPrompt, nextState);
      if (!effectiveEditPrompt) {
        assistantText = 'J’ai la vidéo, mais pas encore la consigne de montage. Décris ce que tu veux couper ou nettoyer.';
        persistedMessages.push({ role: 'assistant', content: assistantText });
        await emitState('waiting_for_input', 'Waiting for an edit prompt.');
        return {
          result: buildResult(runId, assistantText, journal, 'waiting_for_input'),
          persistedMessages,
          workspaceInstructionsMayHaveChanged: false,
        };
      }

      await emitPhase('plan', 'started', 'Preparing transcript artifacts.');
      const transcriptPath = path.join(nextState.artifactDir!, '01_transcript.axcut');
      if (!fs.existsSync(transcriptPath)) {
        await runAxcutCommand(
          ['transcribe', '--video', nextState.videoPath],
          this.options.workspaceRoot,
          emitTool,
        );
      }
      nextState.transcriptPath = transcriptPath;
      await emitPhase('plan', 'completed', 'Transcript ready.');

      await emitPhase('edit', 'started', 'Running transcript edit analysis.');
      try {
        const editResult = await runAxcutCommand(
          ['edit', '--transcript', transcriptPath, '--edit-prompt', effectiveEditPrompt],
          this.options.workspaceRoot,
          emitTool,
        );
        const outputLines = splitOutputLines(editResult.stdout);
        nextState.planPath = outputLines[0] ?? path.join(nextState.artifactDir!, '02_edit_plan.json');
        nextState.cleanedPath = outputLines[1] ?? path.join(nextState.artifactDir!, '03_cleaned.axcut');
        nextState.baseEditPrompt = effectiveEditPrompt;
        nextState.planValidated = true;
        nextState.validationIssues = [];
        nextState.awaitingConfirmation = true;
        nextState.updatedAt = new Date().toISOString();
        this.options.stateStore.save(nextState);
        await emitPhase('edit', 'completed', 'Transcript edit plan generated.');

        const plan = JSON.parse(fs.readFileSync(nextState.planPath, 'utf-8')) as EditPlan;
        await emitPhase('summarize', 'started', 'Preparing edit review for the user.');
        assistantText = formatPlanReview(nextState.videoPath, plan, nextState);
        await emitPhase('summarize', 'completed', 'Review ready.');
        await emitState('waiting_for_input', 'Waiting for user confirmation or refinement.', 'summarize');
        persistedMessages.push({ role: 'assistant', content: assistantText });
        return {
          result: buildResult(runId, assistantText, journal, 'waiting_for_input', 'summarize'),
          persistedMessages,
          workspaceInstructionsMayHaveChanged: false,
        };
      } catch (error) {
        const review = loadDraftPlanReview(nextState.artifactDir!);
        const draftPlanPath = path.join(nextState.artifactDir!, '02_edit_plan.json');
        const draftCleanedPath = path.join(nextState.artifactDir!, '03_cleaned.axcut');
        const draftIsRecoverable =
          fs.existsSync(draftPlanPath)
          && (
            review?.validated === false
            || (error instanceof AxcutCommandError && looksLikePlanValidationFailure(error.details))
          );

        if (draftIsRecoverable) {
          nextState.planPath = draftPlanPath;
          nextState.cleanedPath = fs.existsSync(draftCleanedPath) ? draftCleanedPath : undefined;
          nextState.baseEditPrompt = effectiveEditPrompt;
          nextState.planValidated = review?.validated ?? false;
          nextState.validationIssues = review?.issues ?? (
            error instanceof AxcutCommandError ? extractIssuesFromDetails(error.details) : []
          );
          nextState.awaitingConfirmation = true;
          nextState.updatedAt = new Date().toISOString();
          this.options.stateStore.save(nextState);
          await emitPhase('edit', 'completed', 'Draft edit plan generated but still needs refinement.');

          const plan = JSON.parse(fs.readFileSync(nextState.planPath, 'utf-8')) as EditPlan;
          await emitPhase('summarize', 'started', 'Preparing draft review for the user.');
          assistantText = formatDraftPlanReview(nextState.videoPath, plan, nextState);
          await emitPhase('summarize', 'completed', 'Draft review ready.');
          await emitState('waiting_for_input', 'Waiting for user refinement on the draft plan.', 'summarize');
          persistedMessages.push({ role: 'assistant', content: assistantText });
          return {
            result: buildResult(runId, assistantText, journal, 'waiting_for_input', 'summarize'),
            persistedMessages,
            workspaceInstructionsMayHaveChanged: false,
          };
        }
        throw error;
      }
    } catch (error) {
      const failure = summarizeRuntimeError(error);
      assistantText = `Run failed.\n${failure.details}`;
      persistedMessages.push({ role: 'assistant', content: assistantText });
      await emitState('failed_terminal', failure.status);
      return {
        result: buildResult(runId, assistantText, journal, 'failed_terminal'),
        persistedMessages,
        workspaceInstructionsMayHaveChanged: false,
      };
    }
  }
}

function buildResult(
  runId: string,
  text: string,
  journal: YagrRunJournalEntry[],
  finalState: YagrAgentState,
  finalPhase: YagrRunPhase = 'summarize',
): YagrRunResult {
  return {
    runId,
    text,
    finishReason: finalState === 'failed_terminal' ? 'error' : 'stop',
    steps: 1,
    toolCalls: [],
    completionAccepted: finalState !== 'failed_terminal',
    requiredActions: [],
    compactions: [],
    finalState,
    finalPhase,
    journal,
  };
}

function createEmptyState(sessionId: string): AxcutSessionState {
  return {
    sessionId,
    awaitingConfirmation: false,
    updatedAt: new Date().toISOString(),
  };
}

function classifyPrompt(prompt: string, state: AxcutSessionState): 'analyze' | 'render' | 'force_render' {
  const normalized = prompt.trim().toLowerCase();
  const forceRenderMarkers = new Set(['render anyway', '/render anyway', 'render draft', 'render the draft']);
  if (state.awaitingConfirmation && forceRenderMarkers.has(normalized)) {
    return 'force_render';
  }
  const renderMarkers = new Set(['render', '/render', 'go', 'ok', 'okay', 'oui', 'yes', 'generate', 'cut it']);
  if (state.awaitingConfirmation && renderMarkers.has(normalized)) {
    return 'render';
  }
  return 'analyze';
}

function deriveEffectivePrompt(prompt: string, state: AxcutSessionState): string | undefined {
  const stripped = stripVideoReferences(prompt, state.videoPath).trim();
  if (!stripped && state.baseEditPrompt) {
    return state.baseEditPrompt;
  }
  if (!stripped) {
    return undefined;
  }
  if (state.awaitingConfirmation && state.baseEditPrompt) {
    const currentPlan = loadPlanForState(state);
    if (!currentPlan) {
      return `${state.baseEditPrompt}\n\nUser follow-up after analysis:\n${stripped}`;
    }

    const suggestionDecision = interpretSuggestionDecision(stripped, currentPlan.suggestions);
    return buildRefinementPrompt(
      state.baseEditPrompt,
      stripped,
      currentPlan,
      suggestionDecision,
      state.validationIssues ?? [],
    );
  }
  return stripped;
}

function stripVideoReferences(value: string, videoPath?: string): string {
  let nextValue = value;

  if (videoPath) {
    const escapedVideoPath = escapeRegExp(videoPath);
    const escapedBaseName = escapeRegExp(path.basename(videoPath));
    nextValue = nextValue
      .replace(new RegExp(escapedVideoPath, 'gi'), ' ')
      .replace(new RegExp(escapedBaseName, 'gi'), ' ');
  }

  nextValue = nextValue
    .replace(/\bedit\s*[:\-]?\s*/i, ' ')
    .replace(/\bvideo\s*[:\-]?\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/^[\s.:;,\-]+/, '')
    .trim();

  return nextValue;
}

function resolveVideoPath(prompt: string, workspaceRoot: string): string | undefined {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return undefined;
  }

  const quotedMatches = Array.from(normalizedPrompt.matchAll(/["']([^"']+\.mp4)["']/gi))
    .map((match) => match[1]);
  for (const rawMatch of quotedMatches) {
    const candidate = path.resolve(workspaceRoot, rawMatch);
    if (fs.existsSync(candidate)) {
      return rawMatch;
    }
  }

  const directCandidate = path.resolve(workspaceRoot, normalizedPrompt);
  if (normalizedPrompt.toLowerCase().endsWith('.mp4') && fs.existsSync(directCandidate)) {
    return normalizedPrompt;
  }

  const workspaceVideos = fs
    .readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp4'))
    .map((entry) => entry.name)
    .sort((left, right) => right.length - left.length);

  for (const candidate of workspaceVideos) {
    if (normalizedPrompt.includes(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function artifactDirForVideo(workspaceRoot: string, videoPath: string): string {
  const stem = path.parse(videoPath).name;
  const slug = stem.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return path.join(workspaceRoot, 'artifacts', slug);
}

async function runAxcutCommand(
  args: string[],
  workspaceRoot: string,
  emitTool: (event: YagrToolEvent) => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const python = resolvePython(workspaceRoot);
  const command = [python, '-m', 'axcut.cli', ...args];
  await emitTool({
    type: 'command-start',
    toolName: 'axcut',
    command: command.join(' '),
    cwd: workspaceRoot,
  });

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      void emitTool({
        type: 'command-output',
        toolName: 'axcut',
        stream: 'stdout',
        chunk: text,
      });
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      void emitTool({
        type: 'command-output',
        toolName: 'axcut',
        stream: 'stderr',
        chunk: text,
      });
    });

    child.on('error', async (error) => {
      await emitTool({
        type: 'command-end',
        toolName: 'axcut',
        exitCode: 1,
        message: error.message,
      });
      reject(error);
    });

    child.on('close', async (code) => {
      const exitCode = code ?? 1;
      await emitTool({
        type: 'command-end',
        toolName: 'axcut',
        exitCode,
      });
      if (exitCode !== 0) {
        const failure = summarizeCommandFailure(stderr, stdout, exitCode);
        reject(new AxcutCommandError(failure.status, failure.details));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function resolvePython(workspaceRoot: string): string {
  const venvPython = path.join(workspaceRoot, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
}

function splitOutputLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function summarizeRuntimeError(error: unknown): CommandFailureSummary {
  if (error instanceof AxcutCommandError) {
    return {
      status: error.status,
      details: error.details,
    };
  }
  if (!(error instanceof Error)) {
    const details = String(error);
    return {
      status: 'Run failed.',
      details,
    };
  }
  return summarizeCommandFailure(error.message, '', 1);
}

function summarizeCommandFailure(stderr: string, stdout: string, exitCode: number): CommandFailureSummary {
  const combined = [stderr, stdout]
    .filter(Boolean)
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes('Pydantic serializer warnings'))
    .filter((line) => !line.includes('PydanticSerializationUnexpectedValue'))
    .filter((line) => !line.startsWith('return self.__pydantic_serializer__.to_python('));

  const explicitExceptionLine = [...combined]
    .reverse()
    .find((line) => /^[A-Za-z_][\w.]*?(?:Error|Exception):/.test(line));

  if (explicitExceptionLine && !explicitExceptionLine.startsWith('RuntimeError:')) {
    const message = explicitExceptionLine.replace(/^[A-Za-z_][\w.]*?(?:Error|Exception):\s*/, '').trim();
    if (looksLikePlanValidationFailure(message)) {
      const issueLines = combined
        .filter((line) => line.startsWith('- '))
        .slice(0, 3)
        .map((line) => line.replace(/^- /, '').trim());
      return {
        status: 'Edit plan validation failed.',
        details: issueLines.length > 0
          ? ['Edit plan validation failed.', 'Main blockers:', ...issueLines.map((line) => `- ${line}`)].join('\n')
          : message,
      };
    }
    return {
      status: 'Command failed.',
      details: message || explicitExceptionLine,
    };
  }

  const runtimeLine = combined.find((line) => line.startsWith('RuntimeError:'));
  if (runtimeLine) {
    const runtimeMessage = runtimeLine.replace(/^RuntimeError:\s*/, '').trim();
    const issueLines = combined
      .filter((line) => line.startsWith('- '))
      .slice(0, 3)
      .map((line) => line.replace(/^- /, '').trim());

    const runtimeHeader = runtimeMessage.replace(/\s*Last validation issues:\s*$/i, '').trim();
    if (
      /could not produce a valid edit plan/i.test(runtimeHeader)
      || (issueLines.length > 0 && /validation/i.test(runtimeMessage))
    ) {
      return {
        status: 'Edit plan validation failed.',
        details: issueLines.length > 0
          ? ['Edit plan validation failed.', 'Main blockers:', ...issueLines.map((line) => `- ${line}`)].join('\n')
          : runtimeHeader,
      };
    }

    if (issueLines.length > 0) {
      return {
        status: runtimeHeader || 'Command failed.',
        details: [runtimeHeader || 'Command failed.', ...issueLines.map((line) => `- ${line}`)].join('\n'),
      };
    }

    return {
      status: runtimeHeader || 'Command failed.',
      details: runtimeHeader || `Command failed with exit code ${exitCode}`,
    };
  }

  const tracebackIndex = combined.findIndex((line) => line.startsWith('Traceback'));
  if (tracebackIndex >= 0) {
    const tail = combined.slice(tracebackIndex + 1);
    const exceptionLine = [...tail]
      .reverse()
      .find((line) => /^[A-Za-z_][\w.]*?(?:Error|Exception):/.test(line));
    if (exceptionLine) {
      const message = exceptionLine.replace(/^[A-Za-z_][\w.]*?(?:Error|Exception):\s*/, '').trim();
      return {
        status: 'Command failed.',
        details: message || exceptionLine,
      };
    }

    const firstMeaningful = tail.find((line) =>
      !line.startsWith('File ')
      && !/^[~^]+$/.test(line)
      && !/^[A-Za-z_][\w.]*\(\)$/.test(line),
    );
    if (firstMeaningful) {
      return {
        status: 'Command failed.',
        details: firstMeaningful,
      };
    }
  }

  const lastLine = combined.at(-1);
  if (lastLine) {
    return {
      status: 'Command failed.',
      details: lastLine,
    };
  }

  return {
    status: 'Command failed.',
    details: `Command failed with exit code ${exitCode}`,
  };
}

function formatPlanReview(videoPath: string, plan: EditPlan, state: AxcutSessionState): string {
  const lines = [
    `Video: ${videoPath}`,
    '',
    'Current plan applied if you type `render`:',
    `- Summary: ${plan.summary}`,
    `- Delete ranges: ${plan.delete_ranges.length}`,
    `- Silence threshold: ${plan.drop_silence_gaps_over_ms} ms`,
  ];

  if (plan.delete_ranges.length > 0) {
    lines.push('', 'Applied cuts:');
    for (const [index, item] of plan.delete_ranges.entries()) {
      lines.push(`${index + 1}. ${item.start_word_id}..${item.end_word_id}`);
      lines.push(`   ${item.reason}`);
    }
  }

  if (plan.follow_up_questions.length > 0) {
    lines.push('', 'Questions:');
    for (const [index, item] of plan.follow_up_questions.entries()) {
      lines.push(`${index + 1}. ${item.question}`);
      lines.push(`   ${item.reason}`);
    }
  }

  if (plan.suggestions.length > 0) {
    lines.push('', 'Optional suggestions not yet applied:');
    lines.push('These suggestions are not part of the current plan until you approve them.');
    for (const [index, item] of plan.suggestions.entries()) {
      lines.push(`${index + 1}. ${item.suggestion}`);
      lines.push(`   ${item.reason}`);
    }
  }

  lines.push('');
  lines.push('Reply naturally to refine the cut.');
  lines.push('Examples: `approve suggestions 1 and 3`, `apply all suggestions except 4`, `reject suggestion 2`, `render`.');
  if (state.planPath) {
    lines.push(`Current plan: ${state.planPath}`);
  }
  return lines.join('\n');
}

function formatDraftPlanReview(videoPath: string, plan: EditPlan, state: AxcutSessionState): string {
  const lines = [
    'Draft plan available, but it did not pass internal validation yet.',
    'You can refine it in natural language, or type `render anyway` if you want to use this draft as-is.',
    '',
  ];
  if (state.validationIssues && state.validationIssues.length > 0) {
    lines.push('Main blockers:');
    for (const issue of state.validationIssues.slice(0, 5)) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }
  lines.push(formatPlanReview(videoPath, plan, state));
  return lines.join('\n');
}

function loadPlanForState(state: AxcutSessionState): EditPlan | undefined {
  if (!state.planPath || !fs.existsSync(state.planPath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(state.planPath, 'utf-8')) as EditPlan;
  } catch {
    return undefined;
  }
}

function loadDraftPlanReview(artifactDir: string): PlanReviewStatus | undefined {
  const reviewPath = path.join(artifactDir, '02_edit_plan.review.json');
  if (!fs.existsSync(reviewPath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(reviewPath, 'utf-8')) as PlanReviewStatus;
  } catch {
    return undefined;
  }
}

type SuggestionDecision = {
  approvedIndexes: number[];
  rejectedIndexes: number[];
  approvedAll: boolean;
  rejectedAll: boolean;
};

function interpretSuggestionDecision(text: string, suggestions: EditSuggestion[]): SuggestionDecision {
  const normalized = text.toLowerCase();
  const explicitIndexes = Array.from(new Set(
    Array.from(normalized.matchAll(/\b(\d+)\b/g))
      .map((match) => Number.parseInt(match[1], 10) - 1)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < suggestions.length),
  ));

  const approveAll =
    /\b(approve|accept|validate|apply|include|keep)\b/.test(normalized)
    && /\b(all|your suggestions|the suggestions|every suggestion)\b/.test(normalized);
  const rejectAll =
    /\b(reject|decline|ignore|skip|discard|do not apply)\b/.test(normalized)
    && /\b(all|all suggestions|the suggestions|your suggestions)\b/.test(normalized);

  let approvedIndexes: number[] = [];
  let rejectedIndexes: number[] = [];

  if (approveAll) {
    approvedIndexes = suggestions.map((_, index) => index);
  } else if (/\b(approve|accept|validate|apply|include|keep)\b/.test(normalized) && explicitIndexes.length > 0) {
    approvedIndexes = explicitIndexes;
  }

  if (rejectAll) {
    rejectedIndexes = suggestions.map((_, index) => index);
  } else if (/\b(reject|decline|ignore|skip|discard)\b/.test(normalized) && explicitIndexes.length > 0) {
    rejectedIndexes = explicitIndexes;
  }

  if (approvedIndexes.length === 0 && !rejectAll && /\b(validate|approve|accept)\b/.test(normalized) && /\bsuggestions?\b/.test(normalized)) {
    approvedIndexes = suggestions.map((_, index) => index);
  }

  return {
    approvedIndexes: approvedIndexes.filter((index) => !rejectedIndexes.includes(index)),
    rejectedIndexes,
    approvedAll: approveAll,
    rejectedAll: rejectAll,
  };
}

function buildRefinementPrompt(
  baseEditPrompt: string,
  userFollowUp: string,
  currentPlan: EditPlan,
  suggestionDecision: SuggestionDecision,
  validationIssues: string[],
): string {
  const lines = [
    baseEditPrompt,
    '',
    'Current plan already applied before this follow-up:',
    `- ${currentPlan.summary}`,
  ];

  if (currentPlan.suggestions.length > 0) {
    lines.push('', 'Optional suggestions proposed by the agent but not yet applied:');
    for (const [index, item] of currentPlan.suggestions.entries()) {
      lines.push(`${index + 1}. ${item.suggestion} :: ${item.reason}`);
    }
  }

  lines.push('', 'User follow-up after analysis:');
  lines.push(userFollowUp);

  if (suggestionDecision.approvedIndexes.length > 0) {
    lines.push('', 'Approved optional suggestions that must now become part of the actual plan when natural:');
    for (const index of suggestionDecision.approvedIndexes) {
      const item = currentPlan.suggestions[index];
      lines.push(`- [${index + 1}] ${item.suggestion} :: ${item.reason}`);
    }
  }

  if (suggestionDecision.rejectedIndexes.length > 0) {
    lines.push('', 'Rejected optional suggestions that must stay out of the actual plan:');
    for (const index of suggestionDecision.rejectedIndexes) {
      const item = currentPlan.suggestions[index];
      lines.push(`- [${index + 1}] ${item.suggestion} :: ${item.reason}`);
    }
  }

  if (validationIssues.length > 0) {
    lines.push('', 'Previous validation blockers that still need to be resolved:');
    for (const issue of validationIssues.slice(0, 5)) {
      lines.push(`- ${issue}`);
    }
  }

  lines.push('');
  lines.push('Important:');
  lines.push('- Distinguish clearly between edits already in the actual plan and optional suggestions not yet applied.');
  lines.push('- If the user approved a suggestion, convert it into concrete delete_ranges when appropriate instead of merely repeating it as a suggestion.');
  lines.push('- If the user rejected a suggestion, keep it out of delete_ranges and out of the remaining suggestions list.');

  return lines.join('\n');
}

function extractIssuesFromDetails(details: string): string[] {
  return details
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- /, '').trim());
}

function looksLikePlanValidationFailure(details: string): boolean {
  return /could not produce a valid edit plan/i.test(details)
    || /last validation issues/i.test(details)
    || /edit plan validation failed/i.test(details);
}
