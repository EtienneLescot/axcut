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

Minimal `.env` if you want to preseed the runtime:

```bash
OPENAI_API_KEY=sk-...
AXCUT_AGENT_PROVIDER=openai
AXCUT_AGENT_MODEL=gpt-5.4
```

The web UI also exposes a provider-agnostic LLM setup panel, so `.env` is no longer the only configuration path.

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
2. Configure the LLM provider, model, API key, and optional base URL in the sidebar if the runtime is not ready yet.
3. Attach a local video by absolute path.
4. Wait for probe, proxy generation, and optional transcription jobs.
5. Use the chat panel to request a cut.
6. Use the transcript editor to select word ranges and remove them manually.
7. Preview the current cut with the virtual seek-based player.
8. Export when the timeline is ready.

## Commands

```bash
npm run typecheck
npm run build
npm run test
```

## `.axcut` Direction

The long-term editing source of truth is the versioned `.axcut` JSON project document.

The transcript DSL remains an ingest/export artifact, while timeline edits flow through structured operations on the project document and the Yagr-backed deepagents runtime.
