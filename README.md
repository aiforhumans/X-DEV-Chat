# LM Studio Local Chat (React + Vite)

A local-first chat UI for LM Studio's REST API.

## Project Overview

LM Studio Local Chat is a browser-based interface for chatting with local models through LM Studio's REST server (`http://localhost:1234`). It is designed for local-only workflows with persistent chat state, model controls, and advanced prompt/memory tooling.

Core features:
- Model list/load/unload controls from the UI.
- Streaming chat responses via SSE.
- Stateful conversation chaining with `previous_response_id`.
- Real Person Mode (toggle, intensity, custom persona).
- System prompt and custom persona optimizers (preview + accept/reject).
- Persistent Brain memory graph (facts, evidence, aliases, conflicts, vector index).
- NL-first memory extraction for user facts (bullets/summary style) with JSON fallback.
- 3-tier memory architecture:
  - Working memory window (recent turns),
  - Episodic summaries (chunked conversation memory),
  - Semantic fact graph (Brain v2).
- IndexedDB (Dexie) storage for memory-heavy data.
- Brain debug drawer for extraction/rerank/optimizer traces.

## Current State

As of April 3, 2026, the app is feature-complete for local single-user usage and running in a stable state.
- Build status: passing (`npm run build`).
- Test status: passing (`npm test`).
- Unit tests: `93` passing.
- Optimizer system prompts are now configured via `X_DEV_*_PROMPT_OPTIMIZER` environment variables.

## Recent Updates

- Rebuilt Brain retrieval to persist vector memories in `memoryGraph.vectorIndex` (saved in localStorage and reused across reloads).
- Added local hash-vector semantic fallback (`LocalHash/256`) so memory retrieval still works when browser embeddings fail.
- Fixed embedding status flow so successful provider usage (`browser` / `api` / `hash`) no longer keeps UI stuck at `Embeddings: failed`.
- Added embedding companion model behavior:
  - Keeps `text-embedding-nomic-embed-text-v1.5` loaded alongside the active LLM.
  - Chat model load now auto-loads embedding companion.
  - Chat model unload attempts to unload embedding companion too.
  - Chat model dropdown now excludes embedding models.
- Strengthened extraction with context-aware coreference resolution:
  - Previous user/assistant turn context is passed into extraction.
  - Ambiguous preferences like `I like the color` can resolve to concrete facts (for example `red cars`) when prior context exists.
- Added Optimizer Prompt Set v2 (reliability-first) with stricter JSON-only output rules and non-empty `optimizedPrompt` requirements.
- Moved optimizer system prompts to `.env` (multiline `X_DEV_*_PROMPT_OPTIMIZER` values) and aligned in-code defaults.
- Added custom persona optimization flow with preview + accept/reject.
- Expanded optimizer debug logging to include target (`system`/`persona`), optimizer system prompt, and chat system message snapshot.
- Improved optimizer parsing to handle LM Studio responses where `output[].content` is a string.
- Added repair/retry robustness for malformed optimizer output.
- Updated regenerate behavior to request a fresh sample (temperature/top-p) instead of replaying deterministic output.
- Fixed regenerate stream failure by removing unsupported `seed` key from `/api/v1/chat` payloads.

## Prerequisites

- LM Studio installed and running.
- Local server enabled in LM Studio.
- Node.js 20+.

Default API URL used by this app: `http://localhost:1234`.

## Run

```bash
npm install
npm run dev
```

Open the URL shown by Vite (usually `http://localhost:5173`).

## What It Supports

- `GET /api/v1/models` to list local models.
- `POST /api/v1/models/load` to load a model.
- `POST /api/v1/models/unload` to unload a model.
- `POST /api/v1/chat` with streaming enabled for live responses.
- OpenAI-compatible embeddings endpoint support:
  - `POST /v1/embeddings` (primary for API embeddings)
  - `POST /api/v1/embeddings` (fallback)
- Real Person Mode:
  - Toggle on/off roleplay behavior.
  - Intensity control (0-100).
  - Custom persona text field.
- System prompt optimizer:
  - Manual `Optimize` action using the currently selected local model.
  - Preview flow with original prompt, optimized prompt, and rationale.
  - `Accept` applies changes, `Reject` keeps current prompt.
- Custom persona optimizer:
  - Manual `Optimize persona` action in Real Person Mode section.
  - Same preview and accept/reject safety flow as system prompt optimization.
- Stateful chat chaining via `previous_response_id`.
- Reasoning stream capture in a collapsible panel.
- Local persistence:
  - UI settings in `localStorage`.
  - Messages, episodic summaries, and semantic memory in IndexedDB (Dexie).
- Persistent "Brain v2" memory:
  - Stores facts in a graph with evidence, aliases, and conflict tracking.
  - Uses the currently loaded model for extraction and relevance reranking.
  - NL-first extraction path for local-model reliability (bullet list parsing), with strict-JSON fallback.
  - Preserves contradictory facts and marks an active winner.
  - Memory management UI supports evidence view, delete, clear-all, and conflict winner override.
- Episodic memory:
  - Background chunk summarization (oldest 5 when outside working window).
  - Episode embeddings are stored and vector-searched for contextual recall.
- User profile extraction:
  - Runs in background every 5 successful user turns.
  - Pulls permanent user traits/preferences from recent history as bullet facts.
- In-browser semantic retrieval:
  - Embeddings model: `Xenova/all-MiniLM-L6-v2`.
  - LM Studio API fallback model: `text-embedding-nomic-embed-text-v1.5`.
  - Local fallback model: `LocalHash/256` (no network dependency).
  - Hybrid retrieval: semantic prefilter + lexical prefilter + model rerank.
  - Automatic fallback to LM Studio OpenAI-compatible embeddings (`POST /v1/embeddings`) when browser embeddings fail and API fallback is enabled.
  - Automatic local hash-vector fallback when browser embeddings are unavailable.
- Local file drop ingestion:
  - Drag/drop or select `.txt`, `.md`, `.csv` files near composer.
  - Chunked extraction to Brain facts with provenance tags.
  - File-derived memories are persisted and can be cleared separately.

## Stateful Chat Behavior

- First turn sends no `previous_response_id`.
- Follow-up turns include the last known response ID from LM Studio stream events.
- "New chat" clears local messages and resets the response chain.

## Brain Memory Behavior

- Memory scope is global to this browser profile (stored in local storage).
- Memory scope is global to this browser profile and persisted in IndexedDB.
- Data model: fact graph (`facts`, `evidence`, `aliases`, `conflicts`, `vectorIndex`) with `memoryVersion: 2`.
- v1 flat memories are automatically migrated into v2 graph format.
- Facts/evidence include provenance tags:
  - `chat` (normal conversation-derived)
  - `file` (file-ingested)
- Vector memory behavior:
  - Fact embeddings are cached and persisted in `vectorIndex`.
  - Stale vectors are dropped when fact content/timestamp changes.
  - Vector index is pruned with fact lifecycle operations (delete/clear/prune).
- Prompt recall uses two stages:
  - semantic prefilter shortlist (embeddings)
  - lexical prefilter shortlist
  - hybrid merge + model rerank
- Prompt composition now includes episodic context:
  - system prompt
  - persona block
  - semantic memory context
  - `[Previous Conversation Context]` episodic summaries
- File-derived facts can be removed using `Clear file facts` without deleting chat-derived memories.
- Top memories are injected as compact context (up to 8 facts per prompt).
- Coreference-aware extraction:
  - Extraction now includes previous-turn context.
  - Ambiguous references (`it`, `that`, `the color`) are normalized to concrete memory candidates when context allows.

## Embedding Companion Behavior

- The app treats embeddings as a companion runtime capability to chat:
  - If an LLM is loaded/selected for chatting, the embedding model is auto-kept loaded.
  - Companion status is shown in sidebar (`Embedding companion: loaded|missing`).
  - Normal sends do not force chat model switching for embeddings in the send path.

## Real Person Mode

- Enabled by default for new sessions.
- Prompt composition order:
  1. User system prompt
  2. Persona/roleplay prompt block
  3. Brain memory context
  4. Episodic conversation context (if available)
- Persona settings are stored separately from Brain facts in local storage.

## System Prompt Optimizer

- Uses the selected local model through `/api/v1/chat` (non-stream call).
- Expects strict JSON output with `optimizedPrompt`, `rationale`, optional `warnings`.
- Includes one automatic repair pass for malformed model output.
- Adds optimizer events to the Brain debug drawer (`kind: optimize`).

## Troubleshooting

- Connection error on startup:
  - Verify LM Studio is open and local server is enabled.
  - Confirm URL/port in sidebar matches your LM Studio server.
- No models listed:
  - Refresh model list from the sidebar.
  - Ensure models are present in LM Studio.
- Send fails with no loaded model:
  - Pick a model and click `Load` first.
- Stream interrupted:
  - Use `Retry Last Failed Prompt`.
- Embeddings fail to initialize:
  - App attempts browser embeddings first, then API embeddings (where allowed), then local hash-vector fallback.
  - `Embeddings: failed` should clear on successful provider usage; if it does not, click `Retry embeddings` and check Brain Debug logs.
  - Open Brain Debug -> Logs to inspect `embed` status/errors.
- Memory stores vague preference (for example `the color`) instead of concrete reference:
  - Recent builds add contextual extraction; send one follow-up clarifier if needed.
  - Example pattern now handled: `did you see that red car?` + `i like the color` -> preference like `red cars`.
- File ingest rejected:
  - Supported extensions: `.txt`, `.md`, `.csv`.
  - Limit: up to 5 files/drop, 2MB per file.

## Test and Build

```bash
npm test
npm run test:coverage
npm run test:integration
npm run build
```

### Test Modes

- `npm test` / `npm run test:unit`
  - Deterministic local test suite.
  - Excludes live integration tests.
- `npm run test:coverage`
  - Runs unit tests with V8 coverage and threshold enforcement.
- `npm run test:integration`
  - Runs live LM Studio integration tests (opt-in behavior).

### How To Run Tests

1. Install dependencies:

```bash
npm install
```

2. Run fast local unit tests (default):

```bash
npm test
```

3. Run unit tests with coverage report:

```bash
npm run test:coverage
```

4. Run live LM Studio integration tests (optional):

```bash
npm run test:integration
```

By default, integration tests are skipped unless explicitly enabled with environment variables.

### Integration Test Environment

Set these only when you want to run live integration checks:

```bash
LMSTUDIO_TEST_INTEGRATION=1
LMSTUDIO_TEST_BASE_URL=http://localhost:1234
LMSTUDIO_TEST_CHAT_MODEL=mistralai/ministral-3-14b-reasoning
LMSTUDIO_TEST_EMBED_MODEL=text-embedding-nomic-embed-text-v1.5
```

Notes:
- `LMSTUDIO_TEST_CHAT_MODEL` must be a real model id/key from LM Studio model list.
- If unset or left as placeholder, integration tests fall back to a loaded LLM model, then the first listed LLM model.
- Integration tests allow longer timeouts (up to 120s/test) because local model load/unload can be slow.
- Integration suite attempts cleanup by unloading any non-baseline loaded LLM instances after test execution.

### Function Linkage Audit

Architecture linkage and test ownership mapping are documented in:
- [`docs/LINKAGE_AUDIT.md`](G:/cchhat/docs/LINKAGE_AUDIT.md)
