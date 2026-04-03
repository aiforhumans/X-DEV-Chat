# Engineering TODO

Last updated: April 3, 2026

## Completed in this pass

- [x] F1: Enforce full embeddings fallback chain (`browser -> api -> hash`) in semantic prefilter.
- [x] F2: Make `runMemoryExtraction` status/merge deterministic from `memoryGraphRef.current`.
- [x] F3: Reset episodic/profile metadata on clear chat (`setEpisodeCursor`, `resetProfileTurnCounter`) and clear episodes.
- [x] F4: Reconcile docs with implementation (`README.md`, `docs/LINKAGE_AUDIT.md`).
- [x] F5: Stop base URL side effects on every keystroke (draft input + explicit `Apply URL` commit).
- [x] F6: Add bounded in-memory embedding cache with LRU behavior and stale entry pruning.
- [x] F7: Guard file ingest against graph race/overwrite via ref-based `getGraph` + incremental `onGraphUpdate`.
- [x] F8: Replace naive CSV splitting with quote-aware CSV parsing.
- [x] F9: Expand coverage scope to include `src/App.tsx` and `src/db/**/*.ts`.

## Next priorities

| Priority | Item | Scope | Notes |
| --- | --- | --- | --- |
| P1 | Break `App.tsx` into feature hooks/components | `src/App.tsx` | Reduce orchestration coupling and improve targeted testability. |
| P2 | Add targeted fallback/race regression tests | `src/App.test.tsx`, `src/lib/*.test.ts` | Extend assertions for concurrent ingest + fallback telemetry paths. |
| P2 | Tune coverage thresholds by module criticality | `vitest.config.ts` | Consider per-scope thresholds once toolchain supports stable per-path gates. |
| P3 | Consolidate repeated parsing utilities | `src/lib/memoryGraph.ts`, `src/lib/memoryIntelligence.ts`, `src/lib/systemPromptOptimizer.ts` | Introduce shared parser helpers to reduce duplication. |
| P3 | Reduce embedding runtime startup/build impact | `src/lib/semanticSearch.ts`, Vite build config | Evaluate more aggressive lazy loading/provider toggles and alternative runtime strategy. |

