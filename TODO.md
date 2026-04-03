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
| P1 | Break `App.tsx` into feature hooks/components | `src/App.tsx`, `src/components/*`, `src/hooks/*` | Done: extracted timeline, debug drawer, optimizer modal, and textarea auto-resize hook. |
| P2 | Add targeted fallback/race regression tests | `src/App.test.tsx`, `src/lib/*.test.ts` | Done: added lazy embedding-init test and ingest latest-graph race test. |
| P2 | Tune coverage thresholds by module criticality | `vitest.coverage.*.config.ts`, `package.json` | Done: split coverage into core-lib and app/db threshold profiles. |
| P3 | Consolidate repeated parsing utilities | `src/lib/llmResponseParsing.ts` + consumers | Done: centralized response text extraction + loose JSON parse helpers. |
| P3 | Reduce embedding runtime startup/build impact | `src/App.tsx` | Done: removed eager embedding bootstrap; initialization is now user-triggered/lazy. |

## Follow-up ideas

| Priority | Item | Scope | Notes |
| --- | --- | --- | --- |
| P2 | Extract memory panel + model/settings panel components | `src/App.tsx`, `src/components/*` | Continue shrinking `App.tsx` by moving right/left sidebar sections. |
| P2 | Add integration regression for API->hash fallback telemetry in send path | `src/App.test.tsx` | Assert debug entries and status transitions during forced fallback. |
| P3 | Evaluate optional browser-embeddings toggle to avoid transformer load entirely | `src/lib/semanticSearch.ts`, UI settings | Could further reduce runtime cost on low-resource setups. |
