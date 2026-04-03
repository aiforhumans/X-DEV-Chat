import { describe, expect, it } from 'vitest'
import type { MemoryGraphState } from '../types/chat'
import { buildVectorExportPayload } from './vectorExport'

const makeGraph = (): MemoryGraphState => ({
  facts: [
    {
      id: 'fact-1',
      canonicalText: 'User likes concise responses',
      category: 'preference',
      status: 'active',
      confidence: 0.9,
      sourceTags: ['chat'],
      createdAt: '2026-04-03T00:00:00.000Z',
      updatedAt: '2026-04-03T01:00:00.000Z',
    },
  ],
  evidence: [],
  aliases: [],
  conflicts: [],
  vectorIndex: [
    {
      factId: 'fact-1',
      vector: [0.1, 0.2, 0.3],
      updatedAt: '2026-04-03T01:00:00.000Z',
      provider: 'browser',
      model: 'Xenova/all-MiniLM-L6-v2',
      textHash: 'h123',
    },
  ],
})

describe('vectorExport', () => {
  it('builds export payload with fact metadata and vector stats', () => {
    const payload = buildVectorExportPayload(makeGraph(), '2026-04-03T02:00:00.000Z')
    expect(payload.schemaVersion).toBe(1)
    expect(payload.exportedAt).toBe('2026-04-03T02:00:00.000Z')
    expect(payload.factCount).toBe(1)
    expect(payload.vectorCount).toBe(1)
    expect(payload.vectors[0]).toMatchObject({
      factId: 'fact-1',
      canonicalText: 'User likes concise responses',
      provider: 'browser',
      model: 'Xenova/all-MiniLM-L6-v2',
      dimension: 3,
    })
  })

  it('handles graphs without vectors', () => {
    const graph = makeGraph()
    graph.vectorIndex = []
    const payload = buildVectorExportPayload(graph)
    expect(payload.vectorCount).toBe(0)
    expect(payload.vectors).toEqual([])
  })
})

