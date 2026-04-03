# LM Studio Local Chat

Local-first React + Vite chat app for LM Studio with streaming responses, persistent memory, and prompt/persona optimization.

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

- React 19
- TypeScript
- Vite 8
- Vitest + Testing Library
- Dexie (IndexedDB)

## Prerequisites

- Node.js 20+
- LM Studio installed and running locally
- LM Studio local server enabled (default: `http://localhost:1234`)

## Quick Start

```bash
npm install
npm run dev
```

Open the Vite URL shown in terminal (usually `http://localhost:5173`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts Vite dev server |
| `npm run build` | Type-checks and builds production assets |
| `npm run preview` | Serves the production build locally |
| `npm run test` | Runs unit tests (default test command) |
| `npm run test:unit` | Runs unit tests excluding integration tests |
| `npm run test:coverage` | Runs unit tests with coverage |
| `npm run test:integration` | Runs LM Studio live integration test suite |
| `npm run check` | Runs tests and build (recommended before PRs) |

## Environment Variables

Create `.env` from `.env.example` and adjust values as needed.

### App Variables

| Variable | Purpose |
| --- | --- |
| `X_DEV_SYSTEM_PROMPT_OPTIMIZER` | System prompt optimizer instruction set |
| `X_DEV_PERSONA_PROMPT_OPTIMIZER` | Persona optimizer instruction set |
| `X_DEV_SCENARIO_PROMPT_OPTIMIZER` | Scenario optimizer instruction set |

### Integration Test Variables (Optional)

Only set these when running live LM Studio integration tests:

```bash
LMSTUDIO_TEST_INTEGRATION=1
LMSTUDIO_TEST_BASE_URL=http://localhost:1234
LMSTUDIO_TEST_CHAT_MODEL=mistralai/ministral-3-14b-reasoning
LMSTUDIO_TEST_EMBED_MODEL=text-embedding-nomic-embed-text-v1.5
```

## Feature Notes

### Chat + Model Runtime

- Uses LM Studio REST endpoints for model lifecycle and chat streaming.
- Uses an editable URL field with explicit `Apply URL` commit to avoid per-keystroke reconnect churn.
- Maintains `previous_response_id` for stateful follow-up turns.
- Supports reasoning stream capture in UI.

### Memory System (Brain v2)

- Stores facts, evidence, aliases, conflicts, and vector index.
- Preserves contradictory facts and tracks active winner.
- Supports file-ingested facts (`.txt`, `.md`, `.csv`) with provenance.

### Embeddings + Retrieval

- Primary: browser embeddings (`Xenova/all-MiniLM-L6-v2`).
- Fallback: LM Studio OpenAI-compatible embeddings.
- Final fallback: local hash vector embeddings (`LocalHash/256`).

## Project Structure

```text
.
|- .github/
|  |- workflows/ci.yml
|  |- pull_request_template.md
|- docs/
|  |- LINKAGE_AUDIT.md
|- public/
|- src/
|  |- db/
|  |- lib/
|  |- test/
|  |- types/
|  |- App.tsx
|  |- main.tsx
|- .env.example
|- package.json
|- README.md
```

## GitHub Workflow

- CI runs on push and pull requests using GitHub Actions.
- Pipeline executes:
  1. `npm ci`
  2. `npm run test`
  3. `npm run build`
- Generated artifacts (`coverage/`, `.env`) are ignored and should not be committed.

## Troubleshooting

- Cannot connect to LM Studio:
  - Verify LM Studio is open and local server is enabled.
  - Confirm base URL/port in the app matches LM Studio.
- No models listed:
  - Refresh models in the sidebar.
  - Confirm models are available in LM Studio.
- Embedding errors:
  - Retry embeddings in UI.
  - Check Brain Debug logs for provider fallback status.

## Documentation

- Architecture and linkage audit: [docs/LINKAGE_AUDIT.md](docs/LINKAGE_AUDIT.md)
- Project snapshot: [project_summary.md](project_summary.md)
- Engineering TODOs: [TODO.md](TODO.md)

## Contributing

1. Create a feature branch.
2. Make your changes with tests.
3. Run `npm run check`.
4. Open a pull request.

## License

No license file is currently included.

