<p align="center">
  <img src="assets/generated/logo_full_h_readme.png" alt="Axcut" width="720" />
</p>

# Axcut

Axcut is an AI video-editing agent.

Instead of learning a timeline full of tools, you edit by talking to Axcut the way you would talk over the shoulder of a human editor: remove silences, tighten a section, cut repeated takes, keep the strongest answer, then preview and export.

Axcut runs as a local web application. Speech-to-text is handled locally with Whisper through `faster-whisper`, while the editing agent can use the LLM provider of your choice. You can connect an API provider, an OpenAI-compatible endpoint, GitHub Copilot, or even authenticate with your ChatGPT account through the built-in provider setup.

Axcut is still early-stage software. Feedback, bug reports, workflow notes, and contributions are very welcome.

## What Axcut Does

- Imports a local video file by path.
- Probes the media and generates a lightweight preview proxy with `ffmpeg`.
- Transcribes speech locally with Whisper.
- Lets you edit by chat, transcript selection, or manual timeline operations.
- Keeps edits non-destructive in a versioned `.axcut` project document.
- Previews the current cut before export.
- Exports the final edited video from the original media.

## How It Works

Axcut is split into a TypeScript control plane and a Python media worker:

- `apps/web`: React web UI for chat, preview, transcripts, provider setup, and export controls.
- `apps/server`: local Fastify API, project persistence, job orchestration, and agent runtime boundary.
- `packages/axcut-schema`: shared `.axcut` schema and API contracts.
- `py/axcut-core`: media probing, proxy generation, Whisper transcription, transcript DSL, and export logic.
- `py/axcut-worker`: Python worker CLI called by the TypeScript server.

## Requirements

- Python `3.12` or newer.
- Node.js with npm.
- `uv` for Python environment management.
- `ffmpeg` and `ffprobe` available on your `PATH`.
- Internet access the first time Whisper downloads its model.
- An LLM provider if you want to use chat-based editing.

If you use Docker Compose, Docker provides Python, Node.js, `uv`, `ffmpeg`, and `ffprobe` for you.

## Quickstart

### Docker Compose

The easiest first-phase packaging path is Docker Compose:

```bash
docker compose up --build
```

Open the web UI at:

```text
http://127.0.0.1:5173
```

Compose persists Axcut projects, Whisper models, and provider credentials in Docker volumes. The repository is mounted read-only at `/workspace` so local media in the repo can be imported with container paths, for example:

```text
/workspace/rushs/example.mp4
```

Configure the LLM provider from the web UI after startup. Provider credentials are stored in the `yagr-config` Docker volume.

If you prefer environment variables, add them under the `axcut.environment` section in `docker-compose.yml`, or export them in your shell and mirror the variable names there. `.env.example` lists the common names.

You can stop the app with `Ctrl+C`. To remove the persisted Docker volumes as well:

```bash
docker compose down --volumes
```

### Manual Local Setup

#### 1. Install System Dependencies

Install `ffmpeg` for your platform. On Debian or Ubuntu:

```bash
sudo apt install ffmpeg
```

Check that both media tools are available:

```bash
ffmpeg -version
ffprobe -version
```

#### 2. Create The Python Environment

The server expects the local Python environment at `.venv` in the repository root.

```bash
uv venv
source .venv/bin/activate
uv pip install -e .
```

This installs the Python worker and its dependencies, including `faster-whisper` and `huggingface-hub`.

#### 3. Install The Web App Dependencies

```bash
npm install
```

#### 4. Configure Environment Variables

Create a local environment file:

```bash
cp .env.example .env
```

You can start without editing `.env` and configure the LLM provider from the web UI. If you prefer environment variables, an OpenAI setup can be as simple as:

```bash
OPENAI_API_KEY=sk-...
```

Axcut also supports provider setup through Yagr:

```bash
npm run llm:setup
```

The setup wizard can configure API-key providers and account-based providers such as ChatGPT/OpenAI OAuth where available.

#### 5. Start Axcut

```bash
npm run dev
```

Open the web UI at:

```text
http://127.0.0.1:5173
```

The local API runs at:

```text
http://127.0.0.1:4010
```

### Create Your First Edit

1. Create a project in the web UI.
2. Configure an LLM provider in the sidebar if one is not ready yet.
3. Add a local video using its absolute path.
4. Wait for media probing, proxy generation, and transcription.
5. Ask Axcut for an edit, for example: `Remove silences, hesitations, and repeated phrases.`
6. Review the transcript and preview the current cut.
7. Export the video when the timeline looks right.

## Whisper And Local STT

Axcut uses `faster-whisper` for local speech-to-text. The audio is transcribed on your machine; it is not sent to the LLM provider for transcription.

You do not need to manually download a Whisper model before starting. On the first transcription, Axcut downloads the selected `faster-whisper` model from Hugging Face and caches it locally.

The current default model is:

```text
medium
```

The default model cache is:

```text
~/.cache/axcut/models
```

To use another cache directory, set:

```bash
AXCUT_MODEL_CACHE=/path/to/axcut-model-cache
```

Supported built-in model names are:

- `tiny`
- `base`
- `small`
- `medium`
- `large-v3`

The first transcription can take a while because the model must be downloaded and initialized. Later transcriptions reuse the cached model.

## LLM Providers

The LLM is used for editing decisions and chat, not for local transcription. Axcut can be configured from the web UI or with:

```bash
npm run llm:setup
```

Supported provider options depend on the installed Yagr provider runtime, and can include OpenAI, Anthropic, Google, Mistral, OpenRouter, OpenAI-compatible endpoints, GitHub Copilot, and OpenAI account authentication.

Environment variables are also supported for common providers, for example:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
OPENAI_COMPATIBLE_API_KEY=...
```

## Common Commands

```bash
npm run dev
npm run typecheck
npm run build
npm run test
```

## Project Format

Axcut stores the editing source of truth in a versioned `.axcut` JSON document.

The transcript DSL remains an ingest/export artifact, while timeline edits flow through structured operations on the project document and the Yagr-backed agent runtime.

## Status

Axcut is an early-stage project. The core direction is in place, but the product is still evolving quickly. If you try it on real footage, practical feedback is especially useful: setup issues, transcription quality, editing prompts, export edge cases, UI friction, and missing workflows.
