import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BASE_URL,
  clearPersistedState,
  defaultPersistedState,
  loadPersistedState,
  loadUiState,
  saveUiState,
  savePersistedState,
} from './persistence'
import { createLocalStorageMock } from '../test/testUtils'

describe('persistence', () => {
  it('uses expected default base URL', () => {
    expect(defaultPersistedState().baseUrl).toBe(DEFAULT_BASE_URL)
  })

  it('returns defaults for invalid JSON', () => {
    const storage = createLocalStorageMock()
    storage.setItem('lmstudio-local-chat-state-v1', 'not-json')
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
    })

    expect(loadPersistedState()).toEqual(defaultPersistedState())
  })

  it('returns defaults when no saved state exists', () => {
    const storage = createLocalStorageMock()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
    })
    expect(loadPersistedState()).toEqual(defaultPersistedState())
  })

  it('persists and restores values', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createLocalStorageMock(),
      configurable: true,
    })

    const now = new Date().toISOString()
    const state = {
      ...defaultPersistedState(),
      selectedModel: 'openai/gpt-oss-20b',
      lastResponseId: 'resp_123',
      memoryGraph: {
        facts: [
          {
            id: 'f1',
            canonicalText: 'User prefers concise answers',
            category: 'preference' as const,
            status: 'active' as const,
            confidence: 0.9,
            sourceTags: ['chat' as const],
            createdAt: now,
            updatedAt: now,
          },
        ],
        evidence: [
          {
            id: 'e1',
            factId: 'f1',
            sourceMessageId: 'u1',
            verbatim: 'I prefer concise answers',
            extractedAt: now,
            confidence: 0.9,
            sourceType: 'chat' as const,
          },
        ],
        aliases: [{ factId: 'f1', aliasText: 'concise answers' }],
        conflicts: [],
        vectorIndex: [
          {
            factId: 'f1',
            vector: [0.12, 0.34, 0.56],
            updatedAt: now,
            provider: 'browser' as const,
            model: 'Xenova/all-MiniLM-L6-v2',
            textHash: 'h123',
          },
        ],
      },
      messages: [
        {
          id: '1',
          role: 'user' as const,
          content: 'Hi',
          createdAt: now,
        },
      ],
    }

    savePersistedState(state)
    expect(loadPersistedState()).toMatchObject({
      selectedModel: 'openai/gpt-oss-20b',
      lastResponseId: 'resp_123',
      memoryGraph: { facts: [{ id: 'f1' }] },
      memoryVersion: 2,
      personaMode: { enabled: true, intensity: 70, personaText: '' },
    })

    clearPersistedState()
    expect(loadPersistedState()).toEqual(defaultPersistedState())
  })

  it('migrates legacy v1 memories into memoryGraph', () => {
    const now = new Date().toISOString()
    const storage = createLocalStorageMock()
    storage.setItem(
      'lmstudio-local-chat-state-v1',
      JSON.stringify({
        baseUrl: 'http://localhost:1234',
        selectedModel: 'x',
        systemPrompt: '',
        lastResponseId: null,
        messages: [],
        memories: [
          {
            id: 'm1',
            text: 'User likes tea',
            category: 'preference',
            confidence: 0.8,
            createdAt: now,
            updatedAt: now,
            sourceMessageId: 'u1',
          },
        ],
        lastFailedPrompt: null,
      }),
    )

    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
    })

    const loaded = loadPersistedState()
    expect(loaded.memoryVersion).toBe(2)
    expect(loaded.memoryGraph.facts.length).toBe(1)
    expect(loaded.memoryGraph.facts[0].canonicalText).toBe('User likes tea')
    expect(loaded.memoryGraph.facts[0].sourceTags).toEqual(['chat'])
    expect(loaded.personaMode.enabled).toBe(true)
    expect(loaded.personaMode.intensity).toBe(70)
  })

  it('saves and loads lightweight UI state without heavy memory payloads', () => {
    const storage = createLocalStorageMock()
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
    })

    saveUiState({
      baseUrl: 'http://localhost:1234',
      selectedModel: 'mistral/model',
      brainModel: 'liquid/lfm2.5-1.2b',
      embedModel: 'text-embedding-nomic-embed-text-v1.5',
      systemPrompt: 'Be concise',
      scenarioPrompt: 'Detective noir setup',
      personaMode: { enabled: true, intensity: 55, personaText: 'friendly' },
      lastResponseId: 'resp_9',
      lastFailedPrompt: null,
      lastOptimizationMeta: { at: new Date(0).toISOString(), model: 'mistral/model' },
    })

    const parsedRaw = JSON.parse(storage.getItem('lmstudio-local-chat-state-v1') ?? '{}') as {
      messages?: unknown[]
      memoryGraph?: { facts?: unknown[] }
    }
    expect(Array.isArray(parsedRaw.messages)).toBe(true)
    expect(parsedRaw.messages).toHaveLength(0)
    expect(Array.isArray(parsedRaw.memoryGraph?.facts)).toBe(true)
    expect(parsedRaw.memoryGraph?.facts).toHaveLength(0)

    expect(loadUiState()).toMatchObject({
      selectedModel: 'mistral/model',
      brainModel: 'liquid/lfm2.5-1.2b',
      embedModel: 'text-embedding-nomic-embed-text-v1.5',
      systemPrompt: 'Be concise',
      scenarioPrompt: 'Detective noir setup',
      personaMode: { enabled: true, intensity: 55, personaText: 'friendly' },
      lastResponseId: 'resp_9',
    })
  })
})
