import { afterEach, describe, expect, it, vi } from 'vitest'
import { chunkText, ingestDroppedFiles } from './fileIngest'
import * as memoryGraph from './memoryGraph'
import { createMockLmStudioClient } from '../test/testUtils'
import type { MemoryGraphState } from '../types/chat'
import type { LmStudioClient } from './lmStudioClient'

const emptyGraph = (): MemoryGraphState => ({
  facts: [],
  evidence: [],
  aliases: [],
  conflicts: [],
})

const makeTextFile = (name: string, content: string): File =>
  ({
    name,
    size: content.length,
    type: 'text/plain',
    text: async () => content,
  }) as unknown as File

describe('fileIngest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('chunks long text with overlap', () => {
    const text = 'a'.repeat(2600)
    const chunks = chunkText(text, 1200, 150)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0].text.length).toBe(1200)
    expect(chunks[1].text.length).toBe(1200)
  })

  it('returns no chunks for empty input', () => {
    expect(chunkText('   ')).toEqual([])
  })

  it('ingests a dropped file and tags resulting memories as file-derived', async () => {
    const mockClient = createMockLmStudioClient({
      chat: vi.fn(async () => ({
        output_text:
          '{"facts":[{"canonicalText":"User likes tea","category":"preference","confidence":0.9,"aliases":["tea"],"contradictionWith":[],"currentness":0.9}]}',
      })),
    })

    const updates: string[] = []
    const result = await ingestDroppedFiles({
      files: [makeTextFile('notes.txt', 'user likes tea')],
      model: 'mistral/test',
      client: mockClient as unknown as LmStudioClient,
      graph: emptyGraph(),
      onJobUpdate: (job) => updates.push(`${job.status}:${job.processedChunks}/${job.totalChunks}`),
    })

    expect(result.errors).toEqual([])
    expect(result.jobs[0].status).toBe('done')
    expect(updates.some((line) => line.startsWith('processing'))).toBe(true)
    expect(result.graph.facts.length).toBeGreaterThan(0)
    expect(result.addedFacts).toBeGreaterThan(0)
    expect(result.graph.facts[0].sourceTags).toContain('file')
    expect(result.graph.evidence[0].sourceType).toBe('file')
    expect(result.graph.evidence[0].sourceRef?.fileName).toBe('notes.txt')
  })

  it('marks ingest job failed when chunk extraction throws', async () => {
    vi.spyOn(memoryGraph, 'extractFactsWithModel').mockRejectedValue(new Error('extract crash'))
    const mockClient = createMockLmStudioClient()

    const result = await ingestDroppedFiles({
      files: [makeTextFile('broken.txt', 'abc')],
      model: 'mistral/test',
      client: mockClient as unknown as LmStudioClient,
      graph: emptyGraph(),
    })

    expect(result.jobs[0].status).toBe('failed')
    expect(result.errors[0]).toContain('extract crash')
  })

  it('parses csv rows with quoted commas', async () => {
    const mockClient = createMockLmStudioClient({
      chat: vi.fn(async () => ({
        output_text:
          '{"facts":[{"canonicalText":"User likes tea","category":"preference","confidence":0.9,"aliases":[],"contradictionWith":[],"currentness":0.9}]}',
      })),
    })
    const extractSpy = vi.spyOn(memoryGraph, 'extractFactsWithModel')

    await ingestDroppedFiles({
      files: [makeTextFile('prefs.csv', 'name,preference\n"Alice, B.","green tea"')],
      model: 'mistral/test',
      client: mockClient as unknown as LmStudioClient,
      graph: emptyGraph(),
    })

    const firstChunk = extractSpy.mock.calls[0]?.[2] ?? ''
    expect(firstChunk).toContain('Alice, B.')
    expect(firstChunk).toContain('green tea')
  })

  it('merges ingest chunks against latest graph snapshot via getGraph', async () => {
    const now = new Date().toISOString()
    const externalFactGraph: MemoryGraphState = {
      facts: [
        {
          id: 'external-fact',
          canonicalText: 'User already prefers summaries',
          category: 'preference',
          status: 'active',
          confidence: 0.8,
          sourceTags: ['chat'],
          createdAt: now,
          updatedAt: now,
        },
      ],
      evidence: [],
      aliases: [],
      conflicts: [],
      vectorIndex: [],
    }

    const mockClient = createMockLmStudioClient({
      chat: vi.fn(async () => ({
        output_text:
          '{"facts":[{"canonicalText":"User likes tea","category":"preference","confidence":0.9,"aliases":["tea"],"contradictionWith":[],"currentness":0.9}]}',
      })),
    })

    let latestGraph = externalFactGraph
    const result = await ingestDroppedFiles({
      files: [makeTextFile('notes.txt', 'user likes tea')],
      model: 'mistral/test',
      client: mockClient as unknown as LmStudioClient,
      graph: emptyGraph(),
      getGraph: () => latestGraph,
      onGraphUpdate: (graph) => {
        latestGraph = graph
      },
    })

    expect(result.graph.facts.some((fact) => fact.id === 'external-fact')).toBe(true)
    expect(result.graph.facts.some((fact) => /likes tea/i.test(fact.canonicalText))).toBe(true)
  })
})
