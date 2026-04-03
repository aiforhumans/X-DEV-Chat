# Function Linkage Audit

This document maps runtime call chains and their test coverage for the LM Studio Local Chat app.

## Runtime Call Chains

### Main Chat Turn Flow
1. `App.sendMessage` gathers user input and model selection.
2. `semanticPrefilterFacts` + `prefilterFacts` produce memory candidates.
3. `mergeHybridCandidates` merges semantic + lexical candidates.
4. `rerankFactsWithModel` selects top facts.
5. `buildMemoryContext` builds compact memory block.
6. `buildPersonaPrompt` + `composeSystemPrompt` compose final system prompt.
7. `LmStudioClient.streamChat` streams assistant response.
8. `applyStreamEvent` + `extractResponseId` update live message state.
9. On success, `runMemoryExtraction` calls `extractFactsWithModel`.
10. `mergeFactsWithConflicts` updates graph with evidence/conflict handling.

Primary runtime entrypoint: [`src/App.tsx`](G:/cchhat/src/App.tsx)

### Brain Graph + Management Flow
- Storage load/save: `loadPersistedState` / `savePersistedState`.
- Graph render conversion: `buildKnowledgeGraphElements`.
- Manual controls: `deleteFact`, `clearFileFacts`, `clearMemoryGraph`, `resolveConflict`.

### File Ingestion Flow
1. `handleFileList` -> `ingestDroppedFiles`.
2. `chunkText` splits content.
3. Per chunk: `extractFactsWithModel` -> `mergeFactsWithConflicts` with `sourceType: file`.
4. UI progress updates via `onJobUpdate`; errors surfaced in status/debug.

### Optimizer Flow
1. `runOptimizeSystemPrompt` / `runOptimizePersona`.
2. `optimizeSystemPrompt` / `optimizeCustomPersona`.
3. `parseOptimizationOutput`; on malformed output, `repairOptimizationOutput`; retry if needed.
4. Preview modal accept/reject updates persisted config only.

## Static Module Dependency Map

- `App.tsx` depends on:
  - `lmStudioClient`
  - `chatStream`
  - `memoryGraph`
  - `semanticSearch`
  - `fileIngest`
  - `personaMode`
  - `systemPromptOptimizer`
  - `optimizerConfig`
  - `knowledgeGraph`
  - `persistence`
- `fileIngest` depends on `memoryGraph`.
- `persistence` depends on `memoryGraph` and `personaMode`.
- `semanticSearch` depends on `lmStudioClient`.
- `systemPromptOptimizer` depends on `optimizerConfig` and `lmStudioClient`.

## Test Ownership Matrix

- `chatStream`: [`src/lib/chatStream.test.ts`](G:/cchhat/src/lib/chatStream.test.ts)
  - Covers stream accumulator transitions + response ID extraction.
- `lmStudioClient`: [`src/lib/lmStudioClient.test.ts`](G:/cchhat/src/lib/lmStudioClient.test.ts)
  - Covers model APIs, stream behavior, non-stream chat errors, embeddings fallback/error.
- `memoryGraph`: [`src/lib/memoryGraph.test.ts`](G:/cchhat/src/lib/memoryGraph.test.ts)
  - Covers migration, merge/conflicts, evidence cap, prune cap, extraction/rerank fallback/repair, cleanup.
- `semanticSearch`: [`src/lib/semanticSearch.test.ts`](G:/cchhat/src/lib/semanticSearch.test.ts)
  - Covers browser init, API probe, semantic fallback, caching, error surfacing.
- `fileIngest`: [`src/lib/fileIngest.test.ts`](G:/cchhat/src/lib/fileIngest.test.ts)
  - Covers chunking, full ingest orchestration, provenance tagging, failed extraction handling.
- `optimizerConfig`: [`src/lib/optimizerConfig.test.ts`](G:/cchhat/src/lib/optimizerConfig.test.ts)
  - Covers template rendering and prompt retrieval.
- `systemPromptOptimizer`: [`src/lib/systemPromptOptimizer.test.ts`](G:/cchhat/src/lib/systemPromptOptimizer.test.ts)
  - Covers parser, repair/retry path, system + persona optimization contract.
- `personaMode`: [`src/lib/personaMode.test.ts`](G:/cchhat/src/lib/personaMode.test.ts)
  - Covers persona block generation, intensity clamp, composition order.
- `persistence`: [`src/lib/persistence.test.ts`](G:/cchhat/src/lib/persistence.test.ts)
  - Covers defaults, restore/save/clear, migration.
- `knowledgeGraph`: [`src/lib/knowledgeGraph.test.ts`](G:/cchhat/src/lib/knowledgeGraph.test.ts)
  - Covers graph node/edge generation.
- Live integration (opt-in): [`src/lib/lmStudio.integration.test.ts`](G:/cchhat/src/lib/lmStudio.integration.test.ts)
  - Covers list/load/unload/chat/embeddings against a running LM Studio server.

## Integration Toggle

Integration tests are opt-in and skipped by default.

- `LMSTUDIO_TEST_INTEGRATION=1`
- Optional:
  - `LMSTUDIO_TEST_BASE_URL` (default `http://localhost:1234`)
  - `LMSTUDIO_TEST_CHAT_MODEL`
  - `LMSTUDIO_TEST_EMBED_MODEL` (default `text-embedding-nomic-embed-text-v1.5`)
