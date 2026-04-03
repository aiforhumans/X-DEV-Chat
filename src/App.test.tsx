import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { ChatTurnRequest, ModelInfo } from './types/chat'
import { createLocalStorageMock } from './test/testUtils'

const mocks = vi.hoisted(() => ({
  mockListModels: vi.fn<() => Promise<ModelInfo[]>>(),
  mockLoadModel: vi.fn<(modelKey: string) => Promise<void>>(),
  mockUnloadModel: vi.fn<(modelKey: string) => Promise<void>>(),
  mockStreamChat: vi.fn<
    (
      request: ChatTurnRequest,
      handlers: {
        onEvent: (event: Record<string, unknown>) => void
        onComplete: () => void
        onError: (e: Error) => void
      },
    ) => Promise<void>
  >(),
  mockChat: vi.fn<() => Promise<Record<string, unknown>>>(),
  mockEmbeddings: vi.fn<() => Promise<number[][]>>(),
  mockInitializeEmbeddings: vi.fn<(forceRetry?: boolean) => Promise<'idle' | 'loading' | 'ready' | 'failed'>>(),
  mockProbeApiEmbeddings: vi.fn<() => Promise<void>>(),
  mockSemanticPrefilterFacts: vi.fn(),
  mockGetEmbeddingStatus: vi.fn(),
  mockGetEmbeddingError: vi.fn(),
  mockExtractUserFactsNlFirst: vi.fn(),
  mockRerankFactsWithModel: vi.fn(),
  mockOptimizeSystemPrompt: vi.fn(),
  mockMigrateLocalStateToDexieOnce: vi.fn<() => Promise<void>>(),
  mockLoadMessages: vi.fn<() => Promise<unknown[]>>(),
  mockLoadMemoryGraph: vi.fn<() => Promise<Record<string, unknown>>>(),
  mockSaveMessages: vi.fn<() => Promise<void>>(),
  mockSaveMemoryGraph: vi.fn<() => Promise<void>>(),
  mockFindRelevantEpisodes: vi.fn(),
  mockEnqueueEpisodeSummary: vi.fn(),
  mockRunProfileExtractionCycle: vi.fn(),
}))

const basePersistedState = {
  baseUrl: 'http://localhost:1234',
  selectedModel: '',
  brainModel: 'liquid/lfm2.5-1.2b',
  embedModel: 'text-embedding-nomic-embed-text-v1.5',
  systemPrompt: '',
  scenarioPrompt: '',
  lastOptimizationMeta: undefined,
  personaMode: {
    enabled: true,
    intensity: 70,
    personaText: '',
    personaUpdatedAt: undefined,
  },
  lastResponseId: null,
  lastFailedPrompt: null,
}

const emptyGraph = {
  facts: [],
  evidence: [],
  aliases: [],
  conflicts: [],
  vectorIndex: [],
}

vi.mock('./lib/lmStudioClient', () => ({
  LmStudioClient: class {
    listModels = mocks.mockListModels
    loadModel = mocks.mockLoadModel
    unloadModel = mocks.mockUnloadModel
    streamChat = mocks.mockStreamChat
    chat = mocks.mockChat
    embeddings = mocks.mockEmbeddings
  },
}))

vi.mock('./lib/persistence', () => ({
  DEFAULT_BASE_URL: 'http://localhost:1234',
  loadPersistedState: vi.fn(() => ({
    ...basePersistedState,
    messages: [],
    memoryVersion: 2,
    memoryGraph: { ...emptyGraph },
  })),
  loadUiState: vi.fn(() => ({ ...basePersistedState })),
  saveUiState: vi.fn(),
}))

vi.mock('./db/database', () => ({
  DEFAULT_SESSION_ID: 'default-session',
  migrateLocalStateToDexieOnce: mocks.mockMigrateLocalStateToDexieOnce,
  loadMessages: mocks.mockLoadMessages,
  loadMemoryGraph: mocks.mockLoadMemoryGraph,
  saveMessages: mocks.mockSaveMessages,
  saveMemoryGraph: mocks.mockSaveMemoryGraph,
}))

vi.mock('./lib/episodicMemory', () => ({
  WORKING_MEMORY_LIMIT: 10,
  createMemoryQueue: () => ({
    enqueue: (job: () => Promise<unknown>) => job(),
  }),
  enqueueEpisodeSummary: mocks.mockEnqueueEpisodeSummary,
  findRelevantEpisodes: mocks.mockFindRelevantEpisodes,
  runProfileExtractionCycle: mocks.mockRunProfileExtractionCycle,
}))

vi.mock('./lib/semanticSearch', () => ({
  initializeEmbeddings: mocks.mockInitializeEmbeddings,
  probeApiEmbeddings: mocks.mockProbeApiEmbeddings,
  semanticPrefilterFacts: mocks.mockSemanticPrefilterFacts,
  getEmbeddingStatus: mocks.mockGetEmbeddingStatus,
  getEmbeddingError: mocks.mockGetEmbeddingError,
  getLmStudioEmbeddingModel: vi.fn(() => 'text-embedding-nomic-embed-text-v1.5'),
  setLmStudioEmbeddingModel: vi.fn(),
}))

vi.mock('./lib/memoryGraph', async () => {
  const actual = await vi.importActual<typeof import('./lib/memoryGraph')>('./lib/memoryGraph')
  return {
    ...actual,
    rerankFactsWithModel: mocks.mockRerankFactsWithModel,
  }
})

vi.mock('./lib/memoryIntelligence', async () => {
  const actual = await vi.importActual<typeof import('./lib/memoryIntelligence')>('./lib/memoryIntelligence')
  return {
    ...actual,
    extractUserFactsNlFirst: mocks.mockExtractUserFactsNlFirst,
  }
})

vi.mock('./lib/fileIngest', () => ({
  ingestDroppedFiles: vi.fn(async ({ graph }: { graph: typeof emptyGraph }) => ({
    graph,
    jobs: [],
    errors: [],
  })),
}))

vi.mock('./lib/systemPromptOptimizer', () => ({
  optimizeSystemPrompt: mocks.mockOptimizeSystemPrompt,
  optimizeScenarioPrompt: mocks.mockOptimizeSystemPrompt,
  optimizeCustomPersona: vi.fn(async () => ({
    optimizedPrompt: 'persona optimized',
    rationale: 'ok',
    warnings: [],
    rawOutput: '{}',
    parsePath: 'direct',
  })),
}))

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'localStorage', {
      value: createLocalStorageMock(),
      configurable: true,
    })
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('dark'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    mocks.mockListModels.mockResolvedValue([
      {
        id: 'mistralai/ministral-3-3b',
        key: 'mistralai/ministral-3-3b',
        type: 'llm',
        loaded_instances: [],
        loaded: false,
      },
      {
        id: 'liquid/lfm2.5-1.2b',
        key: 'liquid/lfm2.5-1.2b',
        type: 'llm',
        loaded_instances: [],
        loaded: false,
      },
      {
        id: 'text-embedding-nomic-embed-text-v1.5',
        key: 'text-embedding-nomic-embed-text-v1.5',
        type: 'embedding',
        loaded_instances: [],
        loaded: false,
      },
    ])
    mocks.mockLoadModel.mockResolvedValue()
    mocks.mockUnloadModel.mockResolvedValue()
    mocks.mockStreamChat.mockImplementation(async (_request, handlers) => {
      handlers.onEvent({ type: 'message.delta', content: 'assistant reply', response_id: 'resp_1' })
      handlers.onComplete()
    })
    mocks.mockChat.mockResolvedValue({})
    mocks.mockEmbeddings.mockResolvedValue([[0.1, 0.2]])

    mocks.mockInitializeEmbeddings.mockResolvedValue('ready')
    mocks.mockProbeApiEmbeddings.mockResolvedValue()
    mocks.mockSemanticPrefilterFacts.mockResolvedValue({
      results: [],
      usedFallback: false,
      provider: 'browser',
    })
    mocks.mockGetEmbeddingStatus.mockReturnValue('ready')
    mocks.mockGetEmbeddingError.mockReturnValue('embedding failed')

    mocks.mockExtractUserFactsNlFirst.mockResolvedValue({
      lines: [],
      parseMode: 'nl',
      usedFallback: false,
      rawText: 'NO_NEW_INFO',
      extraction: { facts: [] },
    })
    mocks.mockRerankFactsWithModel.mockResolvedValue({
      result: null,
      rawText: '',
      error: undefined,
    })
    mocks.mockMigrateLocalStateToDexieOnce.mockResolvedValue()
    mocks.mockLoadMessages.mockResolvedValue([])
    mocks.mockLoadMemoryGraph.mockResolvedValue({ ...emptyGraph })
    mocks.mockSaveMessages.mockResolvedValue()
    mocks.mockSaveMemoryGraph.mockResolvedValue()
    mocks.mockFindRelevantEpisodes.mockResolvedValue({ episodes: [], provider: 'none' })
    mocks.mockEnqueueEpisodeSummary.mockResolvedValue({ skipped: true, reason: 'not-enough-messages' })
    mocks.mockRunProfileExtractionCycle.mockResolvedValue({
      graph: { ...emptyGraph },
      ran: false,
      factDelta: 0,
      result: {
        lines: [],
        parseMode: 'none',
        usedFallback: false,
        rawText: '',
      },
    })
    mocks.mockOptimizeSystemPrompt.mockResolvedValue({
      optimizedPrompt: 'System optimized output',
      rationale: 'Clearer and stricter',
      warnings: [],
      rawOutput: '{"optimizedPrompt":"System optimized output"}',
      parsePath: 'direct',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads models and sends a streamed message, then clears chat', async () => {
    render(<App />)

    await screen.findByLabelText('Main LLM model')

    const composer = screen.getByPlaceholderText('Message the local model...')
    fireEvent.change(composer, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await screen.findByText('assistant reply')
    expect(mocks.mockStreamChat).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Clear chat' }))
    await screen.findByText('Start by loading a model and sending a message.')
  })

  it('regenerates last response with fresh sampling options', async () => {
    let callCount = 0
    mocks.mockStreamChat.mockImplementation(async (_request, handlers) => {
      callCount += 1
      handlers.onEvent({
        type: 'message.delta',
        content: callCount === 1 ? 'first reply' : 'regen reply',
        response_id: `resp_${callCount}`,
      })
      handlers.onComplete()
    })

    render(<App />)
    await screen.findByLabelText('Main LLM model')

    fireEvent.change(screen.getByPlaceholderText('Message the local model...'), {
      target: { value: 'hello' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('first reply')

    fireEvent.click(screen.getByRole('button', { name: 'Regen last response' }))
    await screen.findByText('regen reply')

    expect(mocks.mockStreamChat).toHaveBeenCalledTimes(2)
    const regenRequest = mocks.mockStreamChat.mock.calls[1][0]
    expect(regenRequest.temperature).toBe(0.9)
    expect(regenRequest.top_p).toBe(0.95)
    const timeline = document.querySelector('section.timeline')
    expect(timeline).not.toBeNull()
    if (!timeline) {
      throw new Error('Expected timeline section to exist')
    }
    const timelineElement = timeline as HTMLElement
    expect(within(timelineElement).getAllByText('hello')).toHaveLength(1)
  })

  it('runs load/unload from sidebar controls', async () => {
    render(<App />)
    await screen.findByLabelText('Main LLM model')

    const loadButtons = screen.getAllByRole('button', { name: 'Load' })
    const unloadButtons = screen.getAllByRole('button', { name: 'Unload' })
    fireEvent.click(loadButtons[0])
    await waitFor(() => {
      expect(mocks.mockLoadModel).toHaveBeenCalledWith('mistralai/ministral-3-3b')
    })
    fireEvent.click(loadButtons[1])
    await waitFor(() => {
      expect(mocks.mockLoadModel).toHaveBeenCalledWith('liquid/lfm2.5-1.2b')
    })
    fireEvent.click(loadButtons[2])
    await waitFor(() => {
      expect(mocks.mockLoadModel).toHaveBeenCalledWith('text-embedding-nomic-embed-text-v1.5')
    })

    fireEvent.click(unloadButtons[0])
    await waitFor(() => {
      expect(mocks.mockUnloadModel).toHaveBeenCalledWith('mistralai/ministral-3-3b')
    })
    fireEvent.click(unloadButtons[1])
    await waitFor(() => {
      expect(mocks.mockUnloadModel).toHaveBeenCalledWith('liquid/lfm2.5-1.2b')
    })
    fireEvent.click(unloadButtons[2])
    await waitFor(() => {
      expect(mocks.mockUnloadModel).toHaveBeenCalledWith('text-embedding-nomic-embed-text-v1.5')
    })
  })

  it('shows error banner when embeddings retry fails', async () => {
    mocks.mockInitializeEmbeddings.mockResolvedValue('failed')
    mocks.mockGetEmbeddingError.mockReturnValue('Unexpected token <')
    mocks.mockProbeApiEmbeddings.mockRejectedValue(new Error('api down'))

    render(<App />)
    await screen.findByLabelText('Main LLM model')

    fireEvent.click(screen.getByRole('button', { name: 'Retry embeddings' }))

    await screen.findByText((text) => text.includes('Embeddings failed:') && text.includes('api down'))
  })

  it('optimizes system prompt and applies accepted preview', async () => {
    render(<App />)
    await screen.findByLabelText('Main LLM model')

    const systemPromptInput = screen.getByLabelText('System message')
    fireEvent.change(systemPromptInput, { target: { value: 'Be helpful.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Optimize' }))

    await screen.findByRole('heading', { name: 'Optimized System Prompt' })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() => {
      expect(screen.getByLabelText('System message')).toHaveValue('System optimized output')
    })
  })

  it('optimizes scenario block and applies accepted preview', async () => {
    render(<App />)
    await screen.findByLabelText('Main LLM model')

    const scenarioInput = screen.getByLabelText('Scenario block')
    fireEvent.change(scenarioInput, { target: { value: 'You are in a fantasy tavern.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Optimize scenario' }))

    await screen.findByRole('heading', { name: 'Optimized Scenario Block' })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Scenario block')).toHaveValue('System optimized output')
    })
  })
})
