import type { MemoryGraphState } from '../types/chat'

export type VectorExportFormat = 'geojson' | 'kml' | 'shapefile'

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

interface GeoJsonFeature {
  type: 'Feature'
  geometry: {
    type: 'Point'
    coordinates: [number, number]
  }
  properties: Record<string, unknown>
}

interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
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

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

// Embeddings are projected to pseudo-geospatial coordinates for GIS export.
const vectorToLonLat = (vector: number[]): { lon: number; lat: number } => {
  const x = clamp(Number.isFinite(vector[0]) ? vector[0] : 0, -1, 1)
  const y = clamp(Number.isFinite(vector[1]) ? vector[1] : 0, -1, 1)
  return {
    lon: Number((x * 180).toFixed(6)),
    lat: Number((y * 90).toFixed(6)),
  }
}

export const buildVectorGeoJson = (payload: VectorExportPayload): GeoJsonFeatureCollection => {
  const features: GeoJsonFeature[] = payload.vectors.map((entry) => {
    const { lon, lat } = vectorToLonLat(entry.vector)
    return {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lon, lat],
      },
      properties: {
        factId: entry.factId,
        canonicalText: entry.canonicalText,
        category: entry.category,
        factStatus: entry.factStatus,
        sourceTags: entry.sourceTags,
        factUpdatedAt: entry.factUpdatedAt,
        vectorUpdatedAt: entry.vectorUpdatedAt,
        provider: entry.provider,
        model: entry.model,
        textHash: entry.textHash,
        dimension: entry.dimension,
        vector: entry.vector,
      },
    }
  })

  return {
    type: 'FeatureCollection',
    features,
  }
}

export const buildVectorKml = (payload: VectorExportPayload): string => {
  const placemarks = payload.vectors
    .map((entry, index) => {
      const { lon, lat } = vectorToLonLat(entry.vector)
      const safeName = (entry.canonicalText || entry.factId || `vector-${index + 1}`)
        .replace(/[<>&]/g, ' ')
        .slice(0, 120)
      const safeCategory = entry.category.replace(/[<>&]/g, ' ')
      const safeProvider = entry.provider.replace(/[<>&]/g, ' ')
      const safeModel = entry.model.replace(/[<>&]/g, ' ')
      return [
        '<Placemark>',
        `<name>${safeName}</name>`,
        '<ExtendedData>',
        `<Data name="factId"><value>${entry.factId}</value></Data>`,
        `<Data name="category"><value>${safeCategory}</value></Data>`,
        `<Data name="status"><value>${entry.factStatus}</value></Data>`,
        `<Data name="provider"><value>${safeProvider}</value></Data>`,
        `<Data name="model"><value>${safeModel}</value></Data>`,
        `<Data name="dimension"><value>${entry.dimension}</value></Data>`,
        '</ExtendedData>',
        '<Point>',
        `<coordinates>${lon},${lat},0</coordinates>`,
        '</Point>',
        '</Placemark>',
      ].join('')
    })
    .join('')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `<name>brain-vectors-${payload.exportedAt}</name>`,
    placemarks,
    '</Document>',
    '</kml>',
  ].join('')
}

const buildShapefileFeatureCollection = (payload: VectorExportPayload): GeoJsonFeatureCollection => ({
  type: 'FeatureCollection',
  features: payload.vectors.map((entry) => {
    const { lon, lat } = vectorToLonLat(entry.vector)
    return {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lon, lat],
      },
      properties: {
        fact_id: entry.factId.slice(0, 40),
        category: entry.category.slice(0, 20),
        status: entry.factStatus.slice(0, 20),
        provider: entry.provider.slice(0, 16),
        model: entry.model.slice(0, 40),
        dim: entry.dimension,
      },
    }
  }),
})

export const buildVectorExportBlob = async (
  payload: VectorExportPayload,
  format: VectorExportFormat,
): Promise<{ blob: Blob; extension: 'geojson' | 'kml' | 'zip'; mimeType: string }> => {
  if (format === 'geojson') {
    return {
      blob: new Blob([JSON.stringify(buildVectorGeoJson(payload), null, 2)], {
        type: 'application/geo+json',
      }),
      extension: 'geojson',
      mimeType: 'application/geo+json',
    }
  }

  if (format === 'kml') {
    return {
      blob: new Blob([buildVectorKml(payload)], {
        type: 'application/vnd.google-earth.kml+xml',
      }),
      extension: 'kml',
      mimeType: 'application/vnd.google-earth.kml+xml',
    }
  }

  const shapefileGeoJson = buildShapefileFeatureCollection(payload)
  const module = await import('@mapbox/shp-write')
  const zipped = await module.zip(shapefileGeoJson as unknown as never, {
    compression: 'DEFLATE',
    outputType: 'blob',
    folder: 'brain_vectors',
    types: { point: 'brain_vectors' },
  })

  if (zipped instanceof Blob) {
    return {
      blob: zipped,
      extension: 'zip',
      mimeType: 'application/zip',
    }
  }

  throw new Error('Shapefile export failed')
}
