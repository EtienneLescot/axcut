# axcut

POC minimal en Python pour:

1. transcrire une video avec `faster-whisper medium` en local
2. exporter la transcription dans un DSL texte avec timings fins
3. reescrire ce DSL via un agent LangChain + LLM
4. generer un fichier nettoye valide structurellement
5. produire une video coupee a partir du cleaned `.axcut`

## Installation

```bash
uv venv
source .venv/bin/activate
uv pip install -e .
```

Au premier lancement de la transcription, le modele est telecharge localement puis reutilise depuis le disque.
Par defaut il est stocke dans `~/.cache/axcut/models/medium`.
Tu peux changer cet emplacement avec `AXCUT_MODEL_CACHE`.

Variables utiles:

```bash
cp .env.example .env
# puis edite .env
```

Contenu minimal de `.env`:

```bash
OPENAI_API_KEY=sk-...
AXCUT_EDIT_PROMPT="nettoie, supprime les silences, supprime les hesitations et les repetitions"
```

Ensuite tu peux lancer un test sans repasser le prompt en CLI:

```bash
axcut run --video "2026-03-26 13-29-25.mp4"
```

## Interface interactive

Une couche TUI Node reutilise `YagrSessionAgent` et la persistance de session de `yagr` pour piloter le pipeline Python:

```bash
npm install
npm run ui
```

Dans le TUI:

- donne d'abord un chemin `.mp4`
- donne ensuite ton intention de montage
- l'agent genere un plan avec suggestions et questions
- reponds naturellement pour affiner
- tape `render` quand le plan te convient

L'etat de session est conserve dans `.axcut-ui/`.

## Pipeline complet

```bash
axcut run \
  --video "2026-03-10 09-10-39.mp4" \
  --language en \
  --edit-prompt "nettoie, supprime les silences, supprime les hesitations, supprime les repetitions et supprime aussi le passage sur la config"
```

Tu peux aussi forcer la langue de transcription sur `axcut transcribe` et `axcut run` avec `--language en` ou `--language fr` quand l'auto-detection se trompe.

Artifacts generes dans `artifacts/<video_slug>/`:

- `01_transcript.axcut`: transcription DSL source
- `02_edit_plan.json`: manifeste resumant le cleaned transcript genere
- `03_cleaned.axcut`: transcription nettoyee
- `04_keep_intervals.json`: intervalles conserves pour le montage
- `05_cut.mp4`: video finale coupee

Le LLM reecrit directement `03_cleaned.axcut`. Un validateur verifie uniquement la structure et la coherence du DSL (IDs, ordre, timestamps, sous-ensemble du source), sans critique editoriale. Le rendu derive ensuite les clips a partir des segments conserves dans le cleaned transcript.

## DSL

Le DSL est volontairement simple et line-oriented:

```text
AXCUT_TRANSCRIPT v1
META source_video="video.mp4" duration=12.345 language="fr" kind="source"
SEGMENT id=s0001 start=0.000 end=2.100 text="Bonjour euh tout le monde"
WORD id=w000001 segment=s0001 start=0.000 end=0.320 text="Bonjour"
WORD id=w000002 segment=s0001 start=0.330 end=0.480 text="euh"
WORD id=w000003 segment=s0001 start=0.490 end=0.900 text="tout"
WORD id=w000004 segment=s0001 start=0.910 end=1.300 text="le"
WORD id=w000005 segment=s0001 start=1.310 end=2.100 text="monde"
ENDSEGMENT
```

Le fichier nettoye garde le meme format, mais seulement avec les mots conserves.
