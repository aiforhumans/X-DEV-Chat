# X-DEV-Chat

[![CI](https://github.com/aiforhumans/X-DEV-Chat/actions/workflows/ci.yml/badge.svg)](https://github.com/aiforhumans/X-DEV-Chat/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![React](https://img.shields.io/badge/react-19-blue)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/typescript-5.9-blue)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/vite-8-purple)](https://vitejs.dev/)

Local-first React + Vite chat UI for [LM Studio](https://lmstudio.ai/) with streaming responses, multi-layer persistent memory, and prompt/persona optimization.

---

## Table of Contents

- [Highlights](#highlights)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Scripts](#scripts)
- [Environment Variables](#environment-variables)
- [Feature Notes](#feature-notes)
- [Project Structure](#project-structure)
- [CI / GitHub Workflow](#ci--github-workflow)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Highlights

- Local model management from the UI (list, load, unload).
- Streaming chat via LM Studio `/api/v1/chat` with response chaining.
- Real Person Mode with intensity and custom persona.
- Prompt optimization workflows with preview and accept/reject.
- Persistent multi-layer memory:
  - Working memory window
  - Episodic summaries
  - Semantic fact graph (Brain v2)
- IndexedDB-backed persistence with debug tooling.
- In-browser embeddings + LM Studio embeddings fallback + local hash fallback.
- Unit, coverage, and optional live integration tests.

## Tech Stack

| Technology | Version |
| --- | --- |
| [React](https://react.dev/) | 19 |
| [TypeScript](https://www.typescriptlang.org/) | ~5.9 |
| [Vite](https://vitejs.dev/) | 8 |
| [Vitest](https://vitest.dev/) + [Testing Library](https://testing-library.com/) | 3.x |
| [Dexie](https://dexie.org/) (IndexedDB) | 4.x |

## Prerequisites

- **Node.js 20+**
- **[LM Studio](https://lmstudio.ai/)** installed and running locally
- LM Studio local server enabled (default: `http://localhost:1234`)

## Quick Start

```bash
npm install
npm run dev
```

Open the Vite dev URL shown in terminal (default: `http://localhost:5173`).

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite dev server |
| `npm run build` | Type-check and build production assets |
| `npm run preview` | Serve the production build locally |
| `npm run test` | Run unit tests (alias for `test:unit`) |
| `npm run test:unit` | Run unit tests, excluding integration tests |
| `npm run test:coverage` | Run all coverage profiles |
| `npm run test:coverage:core` | Stricter coverage thresholds for `src/lib/**` |
| `npm run test:coverage:appdb` | Coverage thresholds for `src/App.tsx` and `src/db/**` |
| `npm run test:integration` | Run LM Studio live integration test suite |
| `npm run check` | Run tests then build — recommended before opening a PR |

## Environment Variables

Copy `.env.example` to `.env` and adjust values as needed.

### App Variables

| Variable | Purpose |
| --- | --- |
| `X_DEV_SYSTEM_PROMPT_OPTIMIZER` | System prompt optimizer instruction set |
| `X_DEV_PERSONA_PROMPT_OPTIMIZER` | Persona optimizer instruction set |
| `X_DEV_SCENARIO_PROMPT_OPTIMIZER` | Scenario optimizer instruction set |

### Integration Test Variables (Optional)

Set these only when running live LM Studio integration tests:

```bash
LMSTUDIO_TEST_INTEGRATION=1
LMSTUDIO_TEST_BASE_URL=http://localhost:1234
LMSTUDIO_TEST_CHAT_MODEL=mistralai/ministral-3-14b-reasoning
LMSTUDIO_TEST_EMBED_MODEL=text-embedding-nomic-embed-text-v1.5
```

## Feature Notes

### Chat + Model Runtime

- Uses LM Studio REST endpoints for model lifecycle and chat streaming.
- Editable URL field with explicit **Apply URL** commit avoids per-keystroke reconnect churn.
- Maintains `previous_response_id` for stateful follow-up turns.
- Captures reasoning stream output in the UI.

### Memory System (Brain v2)

- Stores facts, evidence, aliases, conflicts, and a vector index.
- Preserves contradictory facts and tracks the active winner.
- Supports file-ingested facts (`.txt`, `.md`, `.csv`) with provenance.
- Exports vector index data as **GeoJSON**, **KML**, or **Shapefile (.zip)** from the Brain panel.

### Embeddings + Retrieval

| Priority | Provider |
| --- | --- |
| Primary | Browser embeddings (`Xenova/all-MiniLM-L6-v2`) |
| Fallback | LM Studio OpenAI-compatible embeddings |
| Final fallback | Local hash vector embeddings (`LocalHash/256`) |

## Project Structure

```text
.
├── .github/
│   ├── workflows/ci.yml
│   └── pull_request_template.md
├── docs/
│   └── LINKAGE_AUDIT.md
├── public/
├── src/
│   ├── components/
│   │   ├── BrainSidebar.tsx
│   │   ├── ChatTimeline.tsx
│   │   ├── ChatWorkspace.tsx
│   │   ├── DebugDrawer.tsx
│   │   ├── OptimizerPreviewModal.tsx
│   │   └── VectorVisualizationModal.tsx
│   ├── db/
│   │   └── database.ts
│   ├── hooks/
│   │   └── useAutoResizeTextarea.ts
│   ├── lib/               # Core logic: chat, memory, embeddings, optimization
│   ├── test/              # Shared test setup and utilities
│   ├── types/
│   │   └── chat.ts
│   ├── App.tsx
│   └── main.tsx
├── .env.example
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## CI / GitHub Workflow

CI runs automatically on every push to `main`/`master` and on all pull requests.

**Pipeline steps:**

1. `npm ci` — install dependencies
2. `npm run test` — run unit tests
3. `npm run build` — type-check and build

Generated artifacts (`coverage/`, `.env`) are git-ignored and must not be committed.

## Troubleshooting

**Cannot connect to LM Studio**
- Verify LM Studio is open and the local server is enabled.
- Confirm the base URL and port in the app match LM Studio's settings.

**No models listed**
- Use the **Refresh models** button in the sidebar.
- Confirm models are downloaded and available in LM Studio.

**Embedding errors**
- Retry embeddings from the UI.
- Check the Brain Debug panel logs for provider fallback status.

## Documentation

| Document | Description |
| --- | --- |
| [docs/LINKAGE_AUDIT.md](docs/LINKAGE_AUDIT.md) | Architecture and module linkage audit |
| [project_summary.md](project_summary.md) | Project snapshot |
| [TODO.md](TODO.md) | Engineering backlog and completed work |

## Contributing

1. Fork the repository and create a feature branch.
2. Make your changes with tests.
3. Run `npm run check` to verify tests pass and the build succeeds.
4. Open a pull request — the CI pipeline will run automatically.

## License

No license file is currently included.

