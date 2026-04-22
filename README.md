# Axcut

Axcut is evolving from a Python proof of concept into a local agentic video-cut application with:

- a TypeScript control plane
- a React web UI
- a canonical `.axcut` project document
- a Python media worker for transcription, proxy generation, and export
- a seek-based non-destructive preview of the current cut timeline

## Current Stack

- `apps/server`: Fastify local API, project persistence, jobs, agent runtime boundary
- `apps/web`: React web UI with chat, preview, transcript selection, and export controls
- `packages/axcut-schema`: shared `.axcut` v2 schema and API contracts
- `py/axcut-core`: media core, transcript DSL, Whisper/ffmpeg logic
- `py/axcut-worker`: Python worker CLI used by the TS server

## Local Setup

### 1. Python

```bash
uv venv
source .venv/bin/activate
uv pip install -e .
```

### 2. Node

```bash
npm install
```

### 3. Environment

```bash
cp .env.example .env
```

Minimal `.env`:

```bash
OPENAI_API_KEY=sk-...
AXCUT_EDIT_PROMPT="cut filler words, stutters, and dead air aggressively"
```

## Running The Web App

Start both server and web UI:

```bash
npm run dev
```

Endpoints:

- web UI: `http://127.0.0.1:5173`
- local API: `http://127.0.0.1:4010`

## Workflow

1. Create a project in the web UI.
2. Attach a local video by absolute path.
3. Wait for probe, proxy generation, and optional transcription jobs.
4. Use the chat panel to request a cut.
5. Use the transcript editor to select word ranges and remove them manually.
6. Preview the current cut with the virtual seek-based player.
7. Export when the timeline is ready.

## Commands

```bash
npm run typecheck
npm run build
npm run test
```

## Legacy POC

The original Python-first CLI/TUI proof of concept still exists in `src/axcut/` and `ui/`, but the active product path is now the workspace-based web stack above.

## `.axcut` Direction

The long-term editing source of truth is the versioned `.axcut` JSON project document.

The legacy transcript DSL still exists as an ingest/export artifact and for the current prompt-planning fallback, but timeline edits now flow through structured operations on the project document.
