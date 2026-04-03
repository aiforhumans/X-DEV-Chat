# Function Linkage Audit

This document maps runtime call chains and test ownership for the LM Studio Local Chat app.

## Runtime Call Chains

### Main Chat Turn Flow

1. `App.sendMessage` gathers user input + selected model.
2. `semanticPrefilterFacts` + `prefilterFacts` build semantic/lexical candidate pools.
3. `mergeHybridCandidates` composes a merged shortlist.
4. `rerankFactsWithModel` selects top memory facts.
5. `buildMemoryContext` composes memory context block.
6. `buildPersonaPrompt` + `composeSystemPrompt` build final system message.
7. `LmStudioClient.streamChat` streams assistant output.
8. `applyStreamEvent` + `extractResponseId` update live assistant state.
9. `runMemoryExtraction` calls `extractUserFactsNlFirst` and `mergeFactsWithConflicts`.

Primary runtime entrypoint: `src/App.tsx`.

### Episodic + Profile Flow

1. `sendMessage` enqueues post-turn memory jobs via `createMemoryQueue`.
2. `enqueueEpisodeSummary` summarizes chunks outside working window.
3. `runProfileExtractionCycle` runs cadence-based profile extraction and merges results.
4. `findRelevantEpisodes` semantically recalls prior episode summaries for prompt context.

### File Ingestion Flow

1. `handleFileList` calls `ingestDroppedFiles`.
2. `chunkText` splits file text into chunk windows.
3. Each chunk calls `extractFactsWithModel` then `mergeFactsWithConflicts` with file provenance.
4. `onGraphUpdate` applies chunk-level graph updates against latest graph ref.

### Persistence Flow

- `loadUiState` / `saveUiState`: UI settings and local app controls.
- `loadMessages` / `saveMessages`: conversation message persistence (Dexie/fallback).
- `loadMemoryGraph` / `saveMemoryGraph`: Brain graph persistence (facts, evidence, aliases, conflicts, vectorIndex).
- `setEpisodeCursor` / `resetProfileTurnCounter` / `clearEpisodes`: metadata reset paths used by clear-chat behavior.

## Module Dependency Map

- `src/App.tsx` depends on:
  - `db/database`
  - `components/ChatTimeline`
  - `components/DebugDrawer`
  - `components/OptimizerPreviewModal`
  - `hooks/useAutoResizeTextarea`
  - `lib/lmStudioClient`
  - `lib/chatStream`
  - `lib/memoryGraph`
  - `lib/semanticSearch`
  - `lib/memoryIntelligence`
  - `lib/episodicMemory`
  - `lib/fileIngest`
  - `lib/personaMode`
  - `lib/systemPromptOptimizer`
  - `lib/optimizerConfig`
  - `lib/persistence`
- `lib/fileIngest` depends on `lib/memoryGraph`.
- `lib/episodicMemory` depends on `db/database`, `lib/memoryGraph`, `lib/memoryIntelligence`, and `lib/semanticSearch`.
- `lib/semanticSearch` depends on `lib/lmStudioClient` and browser transformers runtime.
- `lib/llmResponseParsing` provides shared response text + loose JSON parse utilities used by multiple memory/optimizer modules.

## Test Ownership Matrix

- `src/App.test.tsx`
  - Covers top-level UI wiring: streaming send path, clear chat, model load/unload, embedding retry, optimizer acceptance, base URL apply behavior.
- `src/db/database.test.ts`
  - Covers fallback migration, working-window reads, and episodic/profile metadata reset utilities.
- `src/lib/chatStream.test.ts`
  - Covers stream accumulator behavior + response id handling.
- `src/lib/lmStudioClient.test.ts`
  - Covers model APIs, chat API behavior, and embeddings API handling.
- `src/lib/memoryGraph.test.ts`
  - Covers conflict merge behavior, evidence handling, migration, and rerank paths.
- `src/lib/semanticSearch.test.ts`
  - Covers browser/API/hash fallback behavior, cache behavior, and scoring helpers.
- `src/lib/fileIngest.test.ts`
  - Covers chunking, ingestion orchestration, failure handling, and CSV parsing behavior.
- `src/lib/optimizerConfig.test.ts`
  - Covers optimizer prompt config retrieval.
- `src/lib/systemPromptOptimizer.test.ts`
  - Covers optimize parse/repair/retry behavior.
- `src/lib/personaMode.test.ts`
  - Covers persona composition behavior.
- `src/lib/persistence.test.ts`
  - Covers save/load defaults and migration helpers.
- `src/lib/lmStudio.integration.test.ts`
  - Optional live integration checks against a running LM Studio instance.

## Integration Toggle

Integration tests are opt-in and skipped by default.

- `LMSTUDIO_TEST_INTEGRATION=1`
- Optional:
  - `LMSTUDIO_TEST_BASE_URL` (default `http://localhost:1234`)
  - `LMSTUDIO_TEST_CHAT_MODEL`
  - `LMSTUDIO_TEST_EMBED_MODEL` (default `text-embedding-nomic-embed-text-v1.5`)
