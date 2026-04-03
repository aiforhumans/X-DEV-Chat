import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../types/chat'
import {
  buildConversationTranscript,
  buildEpisodicContextBlock,
  buildWorkingMemoryInput,
  bulletsToExtractionResult,
  extractUserFactsNlFirst,
  extractUserProfileBullets,
  summarizeConversationChunk,
} from './memoryIntelligence'

const mockExtractFactsWithModel = vi.hoisted(() => vi.fn())

vi.mock('./memoryGraph', () => ({
  extractFactsWithModel: mockExtractFactsWithModel,
}))

const makeClient = (outputText: string) =>
  ({
    chat: vi.fn(async () => ({ output_text: outputText })),
  }) as unknown as {
    chat: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  }

describe('memoryIntelligence', () => {
  it('builds a working memory input from the last N messages', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'a', createdAt: new Date(1).toISOString() },
      { id: '2', role: 'assistant', content: 'b', createdAt: new Date(2).toISOString() },
      { id: '3', role: 'user', content: 'c', createdAt: new Date(3).toISOString() },
    ]

    const input = buildWorkingMemoryInput(messages, 'latest', 2)
    expect(input).toContain('Assistant: b')
    expect(input).toContain('User: c')
    expect(input).toContain('User: latest')
    expect(input).not.toContain('User: a')
  })

  it('summarizes chunk using plain text output', async () => {
    const client = makeClient('Conversation discussed red cars and tool choices.')
    const summary = await summarizeConversationChunk(client as never, 'model-a', [
      { id: '1', role: 'user', content: 'hello', createdAt: new Date().toISOString() },
    ])
    expect(summary).toContain('red cars')
  })

  it('returns empty summary for empty conversation chunk', async () => {
    const client = makeClient('ignored')
    const summary = await summarizeConversationChunk(client as never, 'model-a', [])
    expect(summary).toBe('')
  })

  it('extractUserProfileBullets parses NO_NEW_INFO and bullet lines', async () => {
    const noInfo = await extractUserProfileBullets(
      makeClient('NO_NEW_INFO') as never,
      'model',
      [{ id: '1', role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
    )
    expect(noInfo.lines).toEqual([])

    const withBullets = await extractUserProfileBullets(
      makeClient('- User likes TypeScript\n- User works in frontend') as never,
      'model',
      [{ id: '1', role: 'user', content: 'hi', createdAt: new Date().toISOString() }],
    )
    expect(withBullets.lines).toEqual(['User likes TypeScript', 'User works in frontend'])
  })

  it('extractUserProfileBullets returns none mode for empty history', async () => {
    const result = await extractUserProfileBullets(makeClient('ignored') as never, 'model', [])
    expect(result.parseMode).toBe('none')
    expect(result.lines).toEqual([])
  })

  it('converts bullets into extraction candidates with inferred categories', () => {
    const extraction = bulletsToExtractionResult([
      'I like concise answers',
      'My name is Mark',
      'My goal is to ship faster',
      'Please always include code blocks',
    ])
    expect(extraction.facts).toHaveLength(4)
    expect(extraction.facts[0].category).toBe('preference')
    expect(extraction.facts[1].category).toBe('profile')
    expect(extraction.facts[2].category).toBe('goal')
    expect(extraction.facts[3].category).toBe('constraint')
  })

  it('extractUserFactsNlFirst uses JSON fallback when bullet parse fails', async () => {
    mockExtractFactsWithModel.mockResolvedValue({
      extraction: {
        facts: [
          {
            canonicalText: 'User likes coffee',
            category: 'preference',
            confidence: 0.8,
            aliases: ['likes coffee'],
            contradictionWith: [],
            currentness: 0.8,
          },
        ],
      },
      usedFallback: true,
      rawText: '{"facts":[...]}',
    })

    const result = await extractUserFactsNlFirst({
      client: makeClient('No bullets here') as never,
      model: 'model',
      userText: 'I like coffee',
    })

    expect(result.usedFallback).toBe(true)
    expect(result.parseMode).toBe('json-fallback')
    expect(result.extraction.facts[0].canonicalText).toBe('User likes coffee')
  })

  it('extractUserFactsNlFirst uses NL path for bullet output and handles NO_NEW_INFO', async () => {
    const nlResult = await extractUserFactsNlFirst({
      client: makeClient('- User prefers short answers\n- User uses React') as never,
      model: 'model',
      userText: 'I like short answers and use React.',
    })
    expect(nlResult.usedFallback).toBe(false)
    expect(nlResult.parseMode).toBe('nl')
    expect(nlResult.extraction.facts).toHaveLength(2)

    const noInfoResult = await extractUserFactsNlFirst({
      client: makeClient('NO_NEW_INFO') as never,
      model: 'model',
      userText: 'ok',
    })
    expect(noInfoResult.extraction.facts).toEqual([])
  })

  it('parses response text from output content parts', async () => {
    mockExtractFactsWithModel.mockResolvedValue({
      extraction: { facts: [] },
      usedFallback: true,
      rawText: '{"facts":[]}',
    })
    const client = {
      chat: vi.fn(async () => ({
        output: [
          {
            content: [
              { text: 'Chunk one. ' },
              { text: 'Chunk two.' },
            ],
          },
        ],
      })),
    }
    const result = await extractUserFactsNlFirst({
      client: client as never,
      model: 'model',
      userText: 'I like tea',
    })
    expect(result.parseMode).toBe('json-fallback')
  })

  it('builds episodic context block', () => {
    const block = buildEpisodicContextBlock([
      {
        id: 1,
        sessionId: 's',
        summary: 'They discussed model loading.',
        embedding: [0.1],
        startIndex: 0,
        endIndex: 4,
        createdAt: new Date().toISOString(),
        sourceMessageIds: ['1', '2'],
      },
    ])
    expect(block).toContain('[Previous Conversation Context]')
    expect(block).toContain('model loading')
  })

  it('buildConversationTranscript formats chat roles', () => {
    const transcript = buildConversationTranscript([
      { id: '1', role: 'user', content: 'hey', createdAt: new Date().toISOString() },
      { id: '2', role: 'assistant', content: 'hi', createdAt: new Date().toISOString() },
    ])
    expect(transcript).toContain('User: hey')
    expect(transcript).toContain('Assistant: hi')
  })
})
