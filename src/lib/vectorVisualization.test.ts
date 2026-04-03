import { describe, expect, it } from 'vitest'
import {
  buildEdgesForSelection,
  buildVectorVisualizationDataset,
  computeNearestNeighborGraph,
  cosineDistance,
  normalizeEmbedding,
  type ProjectedVectorPoint,
} from './vectorVisualization'
import type { MemoryGraphState } from '../types/chat'

const graphFixture = (): MemoryGraphState => ({
  facts: [
    {
      id: 'b',
      canonicalText: 'B',
      category: 'goal',
      status: 'active',
      confidence: 0.8,
      sourceTags: ['chat'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'a',
      canonicalText: 'A',
      category: 'preference',
      status: 'active',
      confidence: 0.7,
      sourceTags: ['chat'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  evidence: [],
  aliases: [],
  conflicts: [],
  vectorIndex: [
    {
      factId: 'a',
      vector: [1, 0],
      updatedAt: new Date().toISOString(),
      provider: 'browser',
      model: 'mock-model',
    },
    {
      factId: 'b',
      vector: [0, 1],
      updatedAt: new Date().toISOString(),
      provider: 'browser',
      model: 'mock-model',
    },
  ],
})

describe('vectorVisualization', () => {
  it('computes cosine distance', () => {
    expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0)
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1)
  })

  it('samples deterministically at the requested cap', () => {
    const manyGraph = graphFixture()
    manyGraph.facts = Array.from({ length: 1100 }, (_, index) => ({
      id: `fact-${index}`,
      canonicalText: `fact-${index}`,
      category: 'other',
      status: 'active',
      confidence: 0.5,
      sourceTags: ['chat'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))
    manyGraph.vectorIndex = manyGraph.facts.map((fact, index) => ({
      factId: fact.id,
      vector: [index, index + 1],
      updatedAt: new Date().toISOString(),
      provider: 'browser',
      model: 'mock-model',
    }))

    const first = buildVectorVisualizationDataset(manyGraph, 1000)
    const second = buildVectorVisualizationDataset(manyGraph, 1000)
    expect(first.points).toHaveLength(1000)
    expect(first.sampled).toBe(true)
    expect(first.points.map((point) => point.factId)).toEqual(second.points.map((point) => point.factId))
  })

  it('builds nearest-neighbor graph by distance', () => {
    const neighbors = computeNearestNeighborGraph(
      [
        [1, 0],
        [0.99, 0.01],
        [0, 1],
      ],
      1,
    )
    expect(neighbors).toHaveLength(3)
    expect(neighbors[0][0].index).toBe(1)
    expect(neighbors[2][0].index).toBe(1)
  })

  it('normalizes embedding coordinates into bounds', () => {
    const normalized = normalizeEmbedding(
      [
        [0, 0],
        [10, 10],
      ],
      200,
      100,
      10,
    )
    expect(normalized[0].x).toBeGreaterThanOrEqual(10)
    expect(normalized[0].x).toBeLessThanOrEqual(190)
    expect(normalized[1].y).toBeGreaterThanOrEqual(10)
    expect(normalized[1].y).toBeLessThanOrEqual(90)
  })

  it('builds edges for selected point only', () => {
    const points: ProjectedVectorPoint[] = [
      {
        factId: 'a',
        canonicalText: 'A',
        category: 'preference',
        status: 'active',
        confidence: 0.7,
        provider: 'browser',
        model: 'mock-model',
        updatedAt: new Date().toISOString(),
        vector: [1, 0],
        x: 10,
        y: 10,
      },
      {
        factId: 'b',
        canonicalText: 'B',
        category: 'goal',
        status: 'active',
        confidence: 0.8,
        provider: 'browser',
        model: 'mock-model',
        updatedAt: new Date().toISOString(),
        vector: [0, 1],
        x: 20,
        y: 20,
      },
    ]
    const edges = buildEdgesForSelection(
      points,
      [
        [{ index: 1, distance: 0.2 }],
        [{ index: 0, distance: 0.2 }],
      ],
      'a',
    )
    expect(edges).toEqual([
      {
        fromId: 'a',
        toId: 'b',
        distance: 0.2,
      },
    ])
  })
})
