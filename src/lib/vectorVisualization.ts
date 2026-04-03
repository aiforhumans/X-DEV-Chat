import type { MemoryFact, MemoryGraphState } from '../types/chat'

export interface VectorVisualizationPoint {
  factId: string
  canonicalText: string
  category: MemoryFact['category'] | 'unknown'
  status: MemoryFact['status'] | 'unknown'
  confidence: number
  provider: string
  model: string
  updatedAt: string
  vector: number[]
}

export interface ProjectedVectorPoint extends VectorVisualizationPoint {
  x: number
  y: number
}

export interface NeighborRef {
  index: number
  distance: number
}

export interface VectorVisualizationEdge {
  fromId: string
  toId: string
  distance: number
}

export interface VectorVisualizationDataset {
  points: VectorVisualizationPoint[]
  totalCount: number
  sampled: boolean
}

export interface UmapProjectionOptions {
  nNeighbors: number
  minDist: number
}

const MAX_POINTS = 1000

const stableHash = (value: string): number => {
  let hash = 2166136261 >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

export const cosineDistance = (a: number[], b: number[]): number => {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < length; index += 1) {
    const av = a[index]
    const bv = b[index]
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  if (normA === 0 || normB === 0) return 1
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB))
  return 1 - clamp(similarity, -1, 1)
}

export const buildVectorVisualizationDataset = (
  graph: MemoryGraphState,
  limit = MAX_POINTS,
): VectorVisualizationDataset => {
  const factsById = new Map(graph.facts.map((fact) => [fact.id, fact]))
  const vectors = (graph.vectorIndex ?? [])
    .filter((entry) => Array.isArray(entry.vector) && entry.vector.length > 0)
    .map((entry) => {
      const fact = factsById.get(entry.factId)
      return {
        factId: entry.factId,
        canonicalText: fact?.canonicalText || entry.factId,
        category: fact?.category ?? 'unknown',
        status: fact?.status ?? 'unknown',
        confidence: fact?.confidence ?? 0,
        provider: entry.provider ?? 'unknown',
        model: entry.model ?? 'unknown',
        updatedAt: entry.updatedAt,
        vector: entry.vector,
      } satisfies VectorVisualizationPoint
    })
    .sort((a, b) => stableHash(a.factId) - stableHash(b.factId))

  const points = vectors.slice(0, limit)
  return {
    points,
    totalCount: vectors.length,
    sampled: vectors.length > points.length,
  }
}

export const computeNearestNeighborGraph = (vectors: number[][], k: number): NeighborRef[][] => {
  const safeK = Math.max(1, Math.min(k, Math.max(1, vectors.length - 1)))
  return vectors.map((source, sourceIndex) => {
    const scored = vectors
      .map((target, targetIndex) => {
        if (sourceIndex === targetIndex) return null
        return {
          index: targetIndex,
          distance: cosineDistance(source, target),
        } satisfies NeighborRef
      })
      .filter((item): item is NeighborRef => item !== null)
      .sort((left, right) => left.distance - right.distance)
    return scored.slice(0, safeK)
  })
}

export const normalizeEmbedding = (
  embedding: number[][],
  width: number,
  height: number,
  padding: number,
): Array<{ x: number; y: number }> => {
  if (embedding.length === 0) return []
  const xs = embedding.map((point) => point[0] ?? 0)
  const ys = embedding.map((point) => point[1] ?? 0)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const rangeX = maxX - minX
  const rangeY = maxY - minY

  const usableWidth = Math.max(1, width - padding * 2)
  const usableHeight = Math.max(1, height - padding * 2)

  return embedding.map((point) => {
    const xValue = point[0] ?? 0
    const yValue = point[1] ?? 0
    const normalizedX = rangeX === 0 ? 0.5 : (xValue - minX) / rangeX
    const normalizedY = rangeY === 0 ? 0.5 : (yValue - minY) / rangeY
    return {
      x: padding + normalizedX * usableWidth,
      y: padding + (1 - normalizedY) * usableHeight,
    }
  })
}

export const buildEdgesForSelection = (
  points: ProjectedVectorPoint[],
  neighbors: NeighborRef[][],
  selectedFactId: string | null,
): VectorVisualizationEdge[] => {
  if (!selectedFactId) return []
  const selectedIndex = points.findIndex((point) => point.factId === selectedFactId)
  if (selectedIndex < 0) return []
  return (neighbors[selectedIndex] ?? []).map((neighbor) => ({
    fromId: points[selectedIndex].factId,
    toId: points[neighbor.index]?.factId ?? '',
    distance: neighbor.distance,
  }))
}

export const runUmapProjection = async (
  vectors: number[][],
  options: UmapProjectionOptions,
  onEpoch?: (epoch: number) => void,
): Promise<number[][]> => {
  const { UMAP } = await import('umap-js')
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: Math.max(2, options.nNeighbors),
    minDist: clamp(options.minDist, 0, 0.99),
    distanceFn: cosineDistance,
  })

  const embedding = await umap.fitAsync(vectors, (epochNumber: number) => {
    onEpoch?.(epochNumber)
    return true
  })

  return embedding as number[][]
}
