import { describe, expect, it } from 'vitest'
import {
  analyzeAndMergeVectorMemories,
  attachEvidence,
  buildMemoryContext,
  clearFileFacts,
  clearMemoryGraph,
  deleteFact,
  emptyMemoryGraph,
  extractFactsWithModel,
  MAX_EVIDENCE_PER_FACT,
  MAX_FACTS,
  MEMORY_VERSION,
  mergeHybridCandidates,
  mergeFactsWithConflicts,
  migrateMemoryV1ToV2,
  prefilterFacts,
  RECALL_LIMIT,
  rerankFactsWithModel,
  resolveConflict,
  SHORTLIST_LIMIT,
} from './memoryGraph'
import type { MemoryFact, MemoryGraphState } from '../types/chat'
import type { LmStudioClient } from './lmStudioClient'

const makeGraph = (): MemoryGraphState => ({
  facts: [],
  evidence: [],
  aliases: [],
  conflicts: [],
  vectorIndex: [],
})

describe('memoryGraph', () => {
  it('exposes expected memory constants and empty graph shape', () => {
    expect(MEMORY_VERSION).toBe(2)
    expect(SHORTLIST_LIMIT).toBeGreaterThan(RECALL_LIMIT)
    expect(emptyMemoryGraph()).toEqual({
      facts: [],
      evidence: [],
      aliases: [],
      conflicts: [],
      vectorIndex: [],
    })
  })

  it('migrates v1 memories into v2 graph', () => {
    const now = new Date().toISOString()
    const migrated = migrateMemoryV1ToV2([
      {
        id: 'm1',
        text: 'User likes tea',
        category: 'preference',
        confidence: 0.8,
        createdAt: now,
        updatedAt: now,
        sourceMessageId: 'u1',
      },
    ])

    expect(migrated.facts).toHaveLength(1)
    expect(migrated.evidence).toHaveLength(1)
    expect(migrated.aliases).toHaveLength(1)
    expect(migrated.facts[0].sourceTags).toEqual(['chat'])
    expect(migrated.evidence[0].sourceType).toBe('chat')
  })

  it('merges duplicate facts and keeps evidence', () => {
    const start = makeGraph()
    const mergedA = mergeFactsWithConflicts(
      start,
      {
        facts: [
          {
            canonicalText: 'User prefers concise answers',
            category: 'preference',
            confidence: 0.85,
            aliases: ['concise answers'],
            currentness: 0.9,
          },
        ],
      },
      'u1',
    ).graph

    const mergedB = mergeFactsWithConflicts(
      mergedA,
      {
        facts: [
          {
            canonicalText: 'User prefers concise answers',
            category: 'preference',
            confidence: 0.88,
            aliases: ['concise'],
            currentness: 0.9,
          },
        ],
      },
      'u2',
    ).graph

    expect(mergedB.facts).toHaveLength(1)
    expect(mergedB.evidence.length).toBeGreaterThanOrEqual(2)
  })

  it('creates conflicts and marks winner deterministically', () => {
    const base = mergeFactsWithConflicts(
      makeGraph(),
      {
        facts: [
          {
            canonicalText: 'User likes spicy food',
            category: 'preference',
            confidence: 0.7,
            currentness: 0.4,
          },
        ],
      },
      'u1',
    ).graph

    const merged = mergeFactsWithConflicts(
      base,
      {
        facts: [
          {
            canonicalText: "User does not like spicy food",
            category: 'preference',
            confidence: 0.9,
            currentness: 0.9,
          },
        ],
      },
      'u2',
    )

    expect(merged.conflictDetected).toBe(true)
    expect(merged.graph.conflicts.length).toBe(1)
    const winner = merged.graph.conflicts[0].winnerFactId
    const winnerFact = merged.graph.facts.find((f) => f.id === winner)
    expect(winnerFact?.status).toBe('active')
  })

  it('prefilters and builds bounded memory context', () => {
    const now = new Date().toISOString()
    const graph: MemoryGraphState = {
      facts: Array.from({ length: 15 }, (_, idx) => ({
        id: `f${idx}`,
        canonicalText: idx === 0 ? 'User prefers concise answers' : `Fact ${idx}`,
        category: 'preference',
        status: 'active',
        confidence: 0.8,
        sourceTags: ['chat'],
        createdAt: now,
        updatedAt: now,
      })),
      evidence: [],
      aliases: [],
      conflicts: [],
    }

    const shortlist = prefilterFacts(graph, 'Please keep this concise')
    const context = buildMemoryContext(shortlist.map((item) => item.fact).slice(0, RECALL_LIMIT))

    expect(shortlist.length).toBeGreaterThan(0)
    expect(context.selectedFacts.length).toBeLessThanOrEqual(RECALL_LIMIT)
    expect(context.contextBlock).toContain('Memory Context')
  })

  it('resolves conflict manually and deletes/clears graph data', () => {
    const now = new Date().toISOString()
    const graph: MemoryGraphState = {
      facts: [
        {
          id: 'a',
          canonicalText: 'A',
          category: 'other',
          status: 'superseded',
          confidence: 0.6,
          sourceTags: ['chat'],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'b',
          canonicalText: 'B',
          category: 'other',
          status: 'active',
          confidence: 0.8,
          sourceTags: ['chat'],
          createdAt: now,
          updatedAt: now,
        },
      ],
      evidence: [],
      aliases: [],
      conflicts: [
        {
          id: 'c1',
          factAId: 'a',
          factBId: 'b',
          winnerFactId: 'b',
          reason: 'test',
          createdAt: now,
          updatedAt: now,
        },
      ],
    }

    const resolved = resolveConflict(graph, 'c1', 'a')
    expect(resolved.facts.find((f) => f.id === 'a')?.status).toBe('active')

    const deleted = deleteFact(resolved, 'a')
    expect(deleted.facts.some((f) => f.id === 'a')).toBe(false)

    const cleared = clearMemoryGraph()
    expect(cleared.facts).toEqual([])
  })

  it('clears file-derived facts while keeping chat-derived facts', () => {
    const now = new Date().toISOString()
    const graph: MemoryGraphState = {
      facts: [
        {
          id: 'chat-fact',
          canonicalText: 'User likes concise responses',
          category: 'preference',
          status: 'active',
          confidence: 0.9,
          sourceTags: ['chat'],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'file-fact',
          canonicalText: 'Project deadline is Friday',
          category: 'constraint',
          status: 'active',
          confidence: 0.7,
          sourceTags: ['file'],
          createdAt: now,
          updatedAt: now,
        },
      ],
      evidence: [
        {
          id: 'e-chat',
          factId: 'chat-fact',
          sourceMessageId: 'u1',
          verbatim: 'I like concise responses',
          extractedAt: now,
          confidence: 0.9,
          sourceType: 'chat',
        },
        {
          id: 'e-file',
          factId: 'file-fact',
          sourceMessageId: 'file:1',
          verbatim: 'Deadline Friday',
          extractedAt: now,
          confidence: 0.7,
          sourceType: 'file',
        },
      ],
      aliases: [
        { factId: 'chat-fact', aliasText: 'concise responses' },
        { factId: 'file-fact', aliasText: 'deadline friday' },
      ],
      conflicts: [],
    }

    const cleaned = clearFileFacts(graph)
    expect(cleaned.facts.map((fact) => fact.id)).toEqual(['chat-fact'])
    expect(cleaned.evidence.every((item) => item.sourceType === 'chat')).toBe(true)
  })

  it('merges semantic and lexical candidates deterministically', () => {
    const now = new Date().toISOString()
    const factA: MemoryFact = {
      id: 'a',
      canonicalText: 'A',
      category: 'other' as const,
      status: 'active' as const,
      confidence: 0.9,
      sourceTags: ['chat'],
      createdAt: now,
      updatedAt: now,
    }
    const factB: MemoryFact = {
      id: 'b',
      canonicalText: 'B',
      category: 'other' as const,
      status: 'active' as const,
      confidence: 0.9,
      sourceTags: ['chat'],
      createdAt: now,
      updatedAt: now,
    }

    const merged = mergeHybridCandidates(
      [{ fact: factA, score: 0.7 }],
      [{ fact: factB, score: 0.9 }, { fact: factA, score: 0.2 }],
      10,
    )

    expect(merged[0].fact.id).toBe('a')
    expect(merged.length).toBe(2)
  })

  it('analyzes vectors and merges near-duplicate facts conservatively', () => {
    const now = new Date().toISOString()
    const graph: MemoryGraphState = {
      facts: [
        {
          id: 'f-red-a',
          canonicalText: 'User likes red cars',
          category: 'preference',
          status: 'active',
          confidence: 0.82,
          sourceTags: ['chat'],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'f-red-b',
          canonicalText: 'User likes the color red on cars',
          category: 'preference',
          status: 'active',
          confidence: 0.79,
          sourceTags: ['chat'],
          createdAt: now,
          updatedAt: now,
        },
      ],
      evidence: [
        {
          id: 'e1',
          factId: 'f-red-a',
          sourceMessageId: 'u1',
          verbatim: 'i like red cars',
          extractedAt: now,
          confidence: 0.82,
          sourceType: 'chat',
        },
        {
          id: 'e2',
          factId: 'f-red-b',
          sourceMessageId: 'u2',
          verbatim: 'i like the color red',
          extractedAt: now,
          confidence: 0.79,
          sourceType: 'chat',
        },
      ],
      aliases: [],
      conflicts: [],
      vectorIndex: [
        {
          factId: 'f-red-a',
          vector: [0.7, 0.2, 0.1],
          updatedAt: now,
          provider: 'api',
          model: 'text-embedding-nomic-embed-text-v1.5',
        },
        {
          factId: 'f-red-b',
          vector: [0.69, 0.21, 0.1],
          updatedAt: now,
          provider: 'api',
          model: 'text-embedding-nomic-embed-text-v1.5',
        },
      ],
    }

    const result = analyzeAndMergeVectorMemories(graph)
    expect(result.mergedPairs).toBe(1)
    expect(result.graph.facts).toHaveLength(1)
    expect(result.graph.evidence.filter((item) => item.factId === result.graph.facts[0].id)).toHaveLength(2)
  })

  it('caps evidence count per fact', () => {
    const now = new Date().toISOString()
    let graph: MemoryGraphState = {
      facts: [
        {
          id: 'fact-1',
          canonicalText: 'Fact one',
          category: 'other',
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
    }

    for (let index = 0; index < MAX_EVIDENCE_PER_FACT + 5; index += 1) {
      graph = attachEvidence(graph, 'fact-1', `u${index}`, `verbatim ${index}`, 0.8)
    }

    expect(graph.evidence.filter((item) => item.factId === 'fact-1')).toHaveLength(MAX_EVIDENCE_PER_FACT)
  })

  it('prunes memory graph to MAX_FACTS when merge exceeds cap', () => {
    const candidates = Array.from({ length: MAX_FACTS + 12 }, (_, index) => ({
      canonicalText: `token${index} unique${index}`,
      category: 'other' as const,
      confidence: 0.75,
      aliases: [],
      currentness: 0.7,
    }))

    const merged = mergeFactsWithConflicts(
      makeGraph(),
      {
        facts: candidates,
      },
      'bulk-source',
    ).graph

    expect(merged.facts.length).toBe(MAX_FACTS)
  })

  it('extractFactsWithModel repairs malformed model output', async () => {
    let calls = 0
    const client = {
      chat: async () => {
        calls += 1
        if (calls === 1) {
          return { output_text: 'not-json' }
        }
        return {
          output_text:
            '{"facts":[{"canonicalText":"User likes black coffee","category":"preference","confidence":0.9,"aliases":["black coffee"],"contradictionWith":[],"currentness":0.9}]}',
        }
      },
    }

    const result = await extractFactsWithModel(
      client as unknown as LmStudioClient,
      'mistral/test',
      'I like black coffee',
    )

    expect(result.usedFallback).toBe(false)
    expect(result.extraction.facts[0].canonicalText).toContain('black coffee')
    expect(result.rawText).toContain('[repaired]')
  })

  it('extractFactsWithModel retries and falls back when no facts are returned', async () => {
    const client = {
      chat: async () => ({
        output_text: '{"facts":[]}',
      }),
    }

    const result = await extractFactsWithModel(
      client as unknown as LmStudioClient,
      'mistral/test',
      'I prefer green tea',
    )

    expect(result.usedFallback).toBe(true)
    expect(result.extraction.facts.length).toBeGreaterThan(0)
    expect(result.rawText).toContain('[retry]')
  })

  it('extractFactsWithModel resolves vague preference references using previous user context', async () => {
    const client = {
      chat: async () => ({
        output_text:
          '{"facts":[{"canonicalText":"the color","category":"preference","confidence":0.8,"aliases":[],"contradictionWith":[],"currentness":0.8}]}',
      }),
    }

    const result = await extractFactsWithModel(
      client as unknown as LmStudioClient,
      'mistral/test',
      'i like the color',
      {
        previousUserMessage: 'did you see that red car?',
      },
    )

    expect(result.usedFallback).toBe(false)
    expect(result.extraction.facts[0].canonicalText).toBe('red cars')
    expect(result.extraction.facts[0].aliases).toContain('the color')
  })

  it('rerankFactsWithModel returns repaired shortlist when initial parse fails', async () => {
    let calls = 0
    const client = {
      chat: async () => {
        calls += 1
        if (calls === 1) return { output_text: 'bad json' }
        return {
          output_text:
            '{"selectedFactIds":["fact-a"],"scores":[{"factId":"fact-a","score":0.95,"rationale":"directly relevant"}]}',
        }
      },
    }

    const now = new Date().toISOString()
    const shortlist: MemoryFact[] = [
      {
        id: 'fact-a',
        canonicalText: 'User prefers concise responses',
        category: 'preference',
        status: 'active',
        confidence: 0.9,
        sourceTags: ['chat'],
        createdAt: now,
        updatedAt: now,
      },
    ]

    const result = await rerankFactsWithModel(
      client as unknown as LmStudioClient,
      'mistral/test',
      'Be concise',
      shortlist,
    )

    expect(result.result?.selectedFactIds).toEqual(['fact-a'])
    expect(result.rawText).toContain('[repaired]')
  })

  it('rerankFactsWithModel returns error when request fails', async () => {
    const client = {
      chat: async () => {
        throw new Error('chat down')
      },
    }

    const now = new Date().toISOString()
    const shortlist: MemoryFact[] = [
      {
        id: 'fact-a',
        canonicalText: 'User prefers concise responses',
        category: 'preference',
        status: 'active',
        confidence: 0.9,
        sourceTags: ['chat'],
        createdAt: now,
        updatedAt: now,
      },
    ]

    const result = await rerankFactsWithModel(
      client as unknown as LmStudioClient,
      'mistral/test',
      'Be concise',
      shortlist,
    )

    expect(result.result).toBeNull()
    expect(result.error).toContain('chat down')
  })
})
