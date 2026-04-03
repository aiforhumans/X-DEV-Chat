import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoadPersistedState = vi.hoisted(() =>
  vi.fn(() => ({
    baseUrl: 'http://localhost:1234',
    selectedModel: '',
    systemPrompt: '',
    scenarioPrompt: '',
    personaMode: { enabled: true, intensity: 70, personaText: '' },
    lastResponseId: null,
    lastFailedPrompt: null,
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'hello',
        createdAt: new Date().toISOString(),
      },
    ],
    memoryVersion: 2,
    memoryGraph: {
      facts: [
        {
          id: 'f1',
          canonicalText: 'User likes tea',
          category: 'preference',
          status: 'active',
          confidence: 0.8,
          sourceTags: ['chat'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      evidence: [],
      aliases: [],
      conflicts: [],
      vectorIndex: [],
    },
  })),
)

vi.mock('../lib/persistence', () => ({
  loadPersistedState: mockLoadPersistedState,
}))

describe('database fallback migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('migrates local storage state once and remains idempotent', async () => {
    const original = (globalThis as { indexedDB?: unknown }).indexedDB
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
    vi.resetModules()

    const db = await import('./database')
    await db.migrateLocalStateToDexieOnce()
    await db.migrateLocalStateToDexieOnce()

    const messages = await db.loadMessages(db.DEFAULT_SESSION_ID)
    const graph = await db.loadMemoryGraph()
    expect(messages).toHaveLength(1)
    expect(graph.facts).toHaveLength(1)
    expect(mockLoadPersistedState).toHaveBeenCalledTimes(1)

    ;(globalThis as { indexedDB?: unknown }).indexedDB = original
  })

  it('loads working window from stored messages', async () => {
    const original = (globalThis as { indexedDB?: unknown }).indexedDB
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
    vi.resetModules()
    const db = await import('./database')

    await db.saveMessages(db.DEFAULT_SESSION_ID, [
      { id: '1', role: 'user', content: 'a', createdAt: new Date(1).toISOString() },
      { id: '2', role: 'assistant', content: 'b', createdAt: new Date(2).toISOString() },
      { id: '3', role: 'user', content: 'c', createdAt: new Date(3).toISOString() },
    ])

    const window = await db.loadWorkingWindow(db.DEFAULT_SESSION_ID, 2)
    expect(window.map((item) => item.id)).toEqual(['2', '3'])

    ;(globalThis as { indexedDB?: unknown }).indexedDB = original
  })

  it('resets episodic cursor and profile counters and clears episodes', async () => {
    const original = (globalThis as { indexedDB?: unknown }).indexedDB
    ;(globalThis as { indexedDB?: unknown }).indexedDB = undefined
    vi.resetModules()
    const db = await import('./database')

    await db.addEpisode({
      sessionId: db.DEFAULT_SESSION_ID,
      summary: 'Episode summary',
      embedding: [0.1, 0.2],
      startIndex: 0,
      endIndex: 4,
      createdAt: new Date().toISOString(),
      sourceMessageIds: ['m1'],
    })
    await db.setEpisodeCursor(db.DEFAULT_SESSION_ID, 12)
    await db.incrementProfileTurnCounter(db.DEFAULT_SESSION_ID)

    await db.clearEpisodes(db.DEFAULT_SESSION_ID)
    await db.setEpisodeCursor(db.DEFAULT_SESSION_ID, 0)
    await db.resetProfileTurnCounter(db.DEFAULT_SESSION_ID)

    const cursor = await db.getEpisodeCursor(db.DEFAULT_SESSION_ID)
    const episodes = await db.listEpisodes(db.DEFAULT_SESSION_ID)
    const turnsAfterReset = await db.incrementProfileTurnCounter(db.DEFAULT_SESSION_ID)

    expect(cursor).toBe(0)
    expect(episodes).toHaveLength(0)
    expect(turnsAfterReset).toBe(1)

    ;(globalThis as { indexedDB?: unknown }).indexedDB = original
  })
})
