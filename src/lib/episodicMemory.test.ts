import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatMessage, MemoryGraphState } from '../types/chat'
import {
  createMemoryQueue,
  enqueueEpisodeSummary,
  findRelevantEpisodes,
  runProfileExtractionCycle,
} from './episodicMemory'

const mockGetEpisodeCursor = vi.hoisted(() => vi.fn())
const mockSetEpisodeCursor = vi.hoisted(() => vi.fn())
const mockAddEpisode = vi.hoisted(() => vi.fn())
const mockListEpisodes = vi.hoisted(() => vi.fn())
const mockIncrementProfileTurnCounter = vi.hoisted(() => vi.fn())

const mockSummarizeConversationChunk = vi.hoisted(() => vi.fn())
const mockExtractUserProfileBullets = vi.hoisted(() => vi.fn())
const mockBulletsToExtractionResult = vi.hoisted(() => vi.fn())
const mockBuildConversationTranscript = vi.hoisted(() => vi.fn())

const mockEmbedTextForMemory = vi.hoisted(() => vi.fn())
const mockCosineSimilarityVectors = vi.hoisted(() => vi.fn())

const mockExtractFactsWithModel = vi.hoisted(() => vi.fn())
const mockMergeFactsWithConflicts = vi.hoisted(() => vi.fn())

vi.mock('../db/database', () => ({
  getEpisodeCursor: mockGetEpisodeCursor,
  setEpisodeCursor: mockSetEpisodeCursor,
  addEpisode: mockAddEpisode,
  listEpisodes: mockListEpisodes,
  incrementProfileTurnCounter: mockIncrementProfileTurnCounter,
}))

vi.mock('./memoryIntelligence', () => ({
  summarizeConversationChunk: mockSummarizeConversationChunk,
  extractUserProfileBullets: mockExtractUserProfileBullets,
  bulletsToExtractionResult: mockBulletsToExtractionResult,
  buildConversationTranscript: mockBuildConversationTranscript,
}))

vi.mock('./semanticSearch', () => ({
  embedTextForMemory: mockEmbedTextForMemory,
  cosineSimilarityVectors: mockCosineSimilarityVectors,
}))

vi.mock('./memoryGraph', () => ({
  extractFactsWithModel: mockExtractFactsWithModel,
  mergeFactsWithConflicts: mockMergeFactsWithConflicts,
}))

const makeMessages = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `m${index + 1}`,
    createdAt: new Date(index + 1).toISOString(),
  }))

const emptyGraph = (): MemoryGraphState => ({
  facts: [],
  evidence: [],
  aliases: [],
  conflicts: [],
  vectorIndex: [],
})

describe('episodicMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queues jobs sequentially', async () => {
    const queue = createMemoryQueue()
    const order: number[] = []
    await Promise.all([
      queue.enqueue(async () => {
        order.push(1)
      }),
      queue.enqueue(async () => {
        order.push(2)
      }),
    ])
    expect(order).toEqual([1, 2])
  })

  it('skips episode summary when there are not enough messages outside window', async () => {
    mockGetEpisodeCursor.mockResolvedValue(0)
    const result = await enqueueEpisodeSummary({
      sessionId: 's',
      messages: makeMessages(12),
      client: {} as never,
      model: 'm',
    })
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('not-enough-messages')
  })

  it('stores episode summary and advances cursor', async () => {
    mockGetEpisodeCursor.mockResolvedValue(0)
    mockSummarizeConversationChunk.mockResolvedValue('Short summary')
    mockEmbedTextForMemory.mockResolvedValue({
      vector: [0.1, 0.2],
      provider: 'hash',
      usedFallback: false,
    })

    const result = await enqueueEpisodeSummary({
      sessionId: 's',
      messages: makeMessages(15),
      client: {} as never,
      model: 'm',
    })

    expect(result.skipped).toBe(false)
    expect(mockAddEpisode).toHaveBeenCalledTimes(1)
    expect(mockSetEpisodeCursor).toHaveBeenCalledWith('s', 5)
  })

  it('skips and advances cursor when summary is empty', async () => {
    mockGetEpisodeCursor.mockResolvedValue(0)
    mockSummarizeConversationChunk.mockResolvedValue('   ')

    const result = await enqueueEpisodeSummary({
      sessionId: 's',
      messages: makeMessages(15),
      client: {} as never,
      model: 'm',
    })

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('empty-summary')
    expect(mockSetEpisodeCursor).toHaveBeenCalledWith('s', 5)
  })

  it('finds relevant episodes by cosine rank', async () => {
    mockListEpisodes.mockResolvedValue([
      {
        id: 1,
        sessionId: 's',
        summary: 'A',
        embedding: [1, 0],
        startIndex: 0,
        endIndex: 4,
        createdAt: new Date().toISOString(),
        sourceMessageIds: [],
      },
      {
        id: 2,
        sessionId: 's',
        summary: 'B',
        embedding: [0, 1],
        startIndex: 5,
        endIndex: 9,
        createdAt: new Date().toISOString(),
        sourceMessageIds: [],
      },
    ])
    mockEmbedTextForMemory.mockResolvedValue({
      vector: [0.9, 0.1],
      provider: 'browser',
      usedFallback: false,
    })
    mockCosineSimilarityVectors.mockImplementation((a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1])

    const result = await findRelevantEpisodes({
      sessionId: 's',
      prompt: 'topic',
      client: {} as never,
      topK: 1,
    })

    expect(result.episodes).toHaveLength(1)
    expect(result.episodes[0].summary).toBe('A')
  })

  it('returns no episodic matches for blank prompt', async () => {
    mockListEpisodes.mockResolvedValue([])
    const result = await findRelevantEpisodes({
      sessionId: 's',
      prompt: '   ',
      client: {} as never,
    })
    expect(result.episodes).toEqual([])
    expect(result.provider).toBe('none')
  })

  it('runs profile extraction only on cadence and merges extracted facts', async () => {
    mockIncrementProfileTurnCounter.mockResolvedValue(5)
    mockExtractUserProfileBullets.mockResolvedValue({
      lines: ['User likes concise replies'],
      parseMode: 'nl',
      usedFallback: false,
      rawText: '- User likes concise replies',
    })
    mockBulletsToExtractionResult.mockReturnValue({
      facts: [
        {
          canonicalText: 'User likes concise replies',
          category: 'preference',
          confidence: 0.72,
          aliases: [],
          contradictionWith: [],
          currentness: 0.75,
        },
      ],
    })
    mockMergeFactsWithConflicts.mockReturnValue({
      graph: {
        ...emptyGraph(),
        facts: [
          {
            id: 'f1',
            canonicalText: 'User likes concise replies',
            category: 'preference',
            status: 'active',
            confidence: 0.72,
            sourceTags: ['chat'],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    })

    const result = await runProfileExtractionCycle({
      sessionId: 's',
      messages: makeMessages(8),
      graph: emptyGraph(),
      client: {} as never,
      model: 'm',
    })

    expect(result.ran).toBe(true)
    expect(result.factDelta).toBe(1)
    expect(result.result.parseMode).toBe('nl')
  })

  it('returns early when profile cadence is not reached', async () => {
    mockIncrementProfileTurnCounter.mockResolvedValue(3)
    const result = await runProfileExtractionCycle({
      sessionId: 's',
      messages: makeMessages(4),
      graph: emptyGraph(),
      client: {} as never,
      model: 'm',
    })
    expect(result.ran).toBe(false)
    expect(result.factDelta).toBe(0)
  })

  it('skips JSON fallback for non-JSON unusable profile output (performance guard)', async () => {
    mockIncrementProfileTurnCounter.mockResolvedValue(5)
    mockExtractUserProfileBullets.mockResolvedValue({
      lines: [],
      parseMode: 'nl',
      usedFallback: false,
      rawText: 'not parsable',
    })
    mockBulletsToExtractionResult.mockReturnValue({ facts: [] })
    mockBuildConversationTranscript.mockReturnValue('User: hi')
    mockExtractFactsWithModel.mockResolvedValue({
      extraction: { facts: [] },
      rawText: '{"facts":[]}',
      error: undefined,
    })

    const result = await runProfileExtractionCycle({
      sessionId: 's',
      messages: makeMessages(6),
      graph: emptyGraph(),
      client: {} as never,
      model: 'm',
    })

    expect(result.ran).toBe(true)
    expect(result.factDelta).toBe(0)
    expect(result.result.parseMode).toBe('nl')
    expect(result.result.usedFallback).toBe(false)
    expect(mockExtractFactsWithModel).not.toHaveBeenCalled()
  })
})
