import type { MemoryGraphState } from '../types/chat'

export interface ExportedVectorEntry {
  factId: string
  canonicalText: string
  category: string
  factStatus: string
  sourceTags: string[]
  factUpdatedAt: string
  vectorUpdatedAt: string
  provider: string
  model: string
  textHash?: string
  dimension: number
  vector: number[]
}

export interface VectorExportPayload {
  schemaVersion: 1
  exportedAt: string
  factCount: number
  vectorCount: number
  vectors: ExportedVectorEntry[]
}

export const buildVectorExportPayload = (
  graph: MemoryGraphState,
  exportedAt = new Date().toISOString(),
): VectorExportPayload => {
  const factsById = new Map(graph.facts.map((fact) => [fact.id, fact]))
  const vectors = (graph.vectorIndex ?? [])
    .filter((entry) => Array.isArray(entry.vector) && entry.vector.length > 0)
    .map((entry) => {
      const fact = factsById.get(entry.factId)
      return {
        factId: entry.factId,
        canonicalText: fact?.canonicalText ?? '',
        category: fact?.category ?? 'other',
        factStatus: fact?.status ?? 'unknown',
        sourceTags: fact?.sourceTags ?? [],
        factUpdatedAt: fact?.updatedAt ?? '',
        vectorUpdatedAt: entry.updatedAt,
        provider: entry.provider ?? 'unknown',
        model: entry.model ?? 'unknown',
        textHash: entry.textHash,
        dimension: entry.vector.length,
        vector: entry.vector,
      }
    })

  return {
    schemaVersion: 1,
    exportedAt,
    factCount: graph.facts.length,
    vectorCount: vectors.length,
    vectors,
  }
}

