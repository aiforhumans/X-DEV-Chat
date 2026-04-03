import type {
  EmbeddingStatus,
  FactVectorIndexEntry,
  MemoryGraphState,
  SemanticPrefilterResult,
} from '../types/chat'
import type { LmStudioClient } from './lmStudioClient'

const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
let lmStudioEmbeddingModel = 'text-embedding-nomic-embed-text-v1.5'
const HASH_EMBEDDING_MODEL = 'local-hash-256'
const HASH_VECTOR_DIM = 256
const SHORTLIST_LIMIT = 20
const API_BATCH_SIZE = 24
const MAX_VECTOR_INDEX_ENTRIES = 1200
const MAX_VECTOR_CACHE_ENTRIES = 4000
const TRANSFORMERS_VERSION = '2.17.2'
const HUGGING_FACE_HOST = 'https://huggingface.co/'
const HUGGING_FACE_TEMPLATE = '{model}/resolve/main/'
const WASM_CDN = `https://cdn.jsdelivr.net/npm/@xenova/transformers@${TRANSFORMERS_VERSION}/dist/`

type FeatureExtractor = (text: string, options?: Record<string, unknown>) => Promise<unknown>
interface TransformersLike {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<FeatureExtractor>
  env?: {
    allowLocalModels?: boolean
    allowRemoteModels?: boolean
    useBrowserCache?: boolean
    remoteHost?: string
    remotePathTemplate?: string
    backends?: {
      onnx?: {
        wasm?: {
          numThreads?: number
          proxy?: boolean
          wasmPaths?: string
        }
      }
    }
  }
}

let embeddingStatus: EmbeddingStatus = 'idle'
let extractorPromise: Promise<FeatureExtractor> | null = null
let extractor: FeatureExtractor | null = null
let lastEmbeddingError = ''
const vectorCache = new Map<string, FactVectorIndexEntry>()

const getVectorCacheEntry = (key: string): FactVectorIndexEntry | null => {
  const hit = vectorCache.get(key)
  if (!hit) return null
  vectorCache.delete(key)
  vectorCache.set(key, hit)
  return hit
}

const setVectorCacheEntry = (key: string, entry: FactVectorIndexEntry): void => {
  if (vectorCache.has(key)) {
    vectorCache.delete(key)
  }
  vectorCache.set(key, entry)
  if (vectorCache.size <= MAX_VECTOR_CACHE_ENTRIES) return

  const overflow = vectorCache.size - MAX_VECTOR_CACHE_ENTRIES
  const keys = vectorCache.keys()
  for (let index = 0; index < overflow; index += 1) {
    const oldest = keys.next()
    if (oldest.done) break
    vectorCache.delete(oldest.value)
  }
}

const pruneVectorCacheForGraph = (graph: MemoryGraphState): void => {
  if (vectorCache.size === 0) return
  const factUpdatedAt = new Map(graph.facts.map((fact) => [fact.id, fact.updatedAt]))

  for (const [key, entry] of vectorCache.entries()) {
    const expectedUpdatedAt = factUpdatedAt.get(entry.factId)
    if (!expectedUpdatedAt || expectedUpdatedAt !== entry.updatedAt || !Array.isArray(entry.vector) || entry.vector.length === 0) {
      vectorCache.delete(key)
    }
  }
}

const toModelFileUrl = (model: string, fileName: string): string =>
  `${HUGGING_FACE_HOST}${HUGGING_FACE_TEMPLATE.replace('{model}', model).replace('{revision}', 'main')}${fileName}`

const preflightModelEndpoint = async (): Promise<void> => {
  const url = toModelFileUrl(EMBEDDING_MODEL, 'tokenizer_config.json')
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`embedding preflight failed (${response.status}) at ${url}`)
  }
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    throw new Error(`embedding preflight received HTML at ${url}`)
  }
  const text = await response.text()
  if (text.trim().startsWith('<!doctype') || text.trim().startsWith('<html')) {
    throw new Error(`embedding preflight received HTML body at ${url}`)
  }
}

const asNumberArray = (value: unknown): number[] => {
  if (!value || typeof value !== 'object') return []
  const maybeTensor = value as {
    data?: ArrayLike<number>
    tolist?: () => unknown
  }

  if (maybeTensor.data && typeof maybeTensor.data.length === 'number') {
    return Array.from(maybeTensor.data)
  }

  if (typeof maybeTensor.tolist === 'function') {
    const listed = maybeTensor.tolist()
    if (Array.isArray(listed) && listed.length > 0) {
      if (Array.isArray(listed[0])) {
        return (listed[0] as unknown[]).map((item) => Number(item) || 0)
      }
      return listed.map((item) => Number(item) || 0)
    }
  }

  return []
}

const dot = (a: number[], b: number[]): number => {
  const len = Math.min(a.length, b.length)
  let sum = 0
  for (let index = 0; index < len; index += 1) {
    sum += a[index] * b[index]
  }
  return sum
}

const magnitude = (vector: number[]): number => Math.sqrt(dot(vector, vector))

const cosineSimilarity = (a: number[], b: number[]): number => {
  const denom = magnitude(a) * magnitude(b)
  if (!denom) return 0
  return dot(a, b) / denom
}

export const cosineSimilarityVectors = (a: number[], b: number[]): number => cosineSimilarity(a, b)

const makeFactText = (graph: MemoryGraphState, factId: string, canonicalText: string): string => {
  const aliases = graph.aliases
    .filter((alias) => alias.factId === factId)
    .map((alias) => alias.aliasText.trim())
    .filter(Boolean)

  if (aliases.length === 0) return canonicalText
  return `${canonicalText}\nAliases: ${aliases.join(' | ')}`
}

const hashText = (value: string): string => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `h${(hash >>> 0).toString(16)}`
}

const findVectorInGraph = (
  graph: MemoryGraphState,
  provider: 'browser' | 'api' | 'hash',
  model: string,
  factId: string,
  factUpdatedAt: string,
  textHash: string,
): FactVectorIndexEntry | null => {
  const candidates = graph.vectorIndex ?? []

  const exact = candidates.find(
    (entry) =>
      entry.factId === factId &&
      entry.updatedAt === factUpdatedAt &&
      entry.provider === provider &&
      entry.model === model &&
      entry.textHash === textHash &&
      Array.isArray(entry.vector) &&
      entry.vector.length > 0,
  )
  if (exact) return exact

  const legacy = candidates.find(
    (entry) =>
      entry.factId === factId &&
      entry.updatedAt === factUpdatedAt &&
      Array.isArray(entry.vector) &&
      entry.vector.length > 0,
  )
  if (legacy) {
    return {
      ...legacy,
      provider,
      model,
      textHash,
    }
  }

  return null
}

const upsertVectorIndex = (
  graph: MemoryGraphState,
  incoming: FactVectorIndexEntry[],
): MemoryGraphState => {
  if (incoming.length === 0) return graph
  const validFactIds = new Set(graph.facts.map((fact) => fact.id))
  const factUpdatedAtById = new Map(graph.facts.map((fact) => [fact.id, fact.updatedAt]))
  const merged = new Map<string, FactVectorIndexEntry>()
  const toKey = (entry: FactVectorIndexEntry): string =>
    `${entry.provider ?? 'browser'}:${entry.model ?? EMBEDDING_MODEL}:${entry.factId}:${entry.updatedAt}:${entry.textHash ?? ''}`

  for (const entry of graph.vectorIndex ?? []) {
    if (!validFactIds.has(entry.factId)) continue
    if (factUpdatedAtById.get(entry.factId) !== entry.updatedAt) continue
    if (!Array.isArray(entry.vector) || entry.vector.length === 0) continue
    merged.set(toKey(entry), entry)
  }
  for (const entry of incoming) {
    if (!validFactIds.has(entry.factId)) continue
    if (!Array.isArray(entry.vector) || entry.vector.length === 0) continue
    merged.set(toKey(entry), entry)
  }

  const vectorIndex = [...merged.values()].slice(-MAX_VECTOR_INDEX_ENTRIES)
  return {
    ...graph,
    vectorIndex,
  }
}

const tokenizeForHash = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)

const hashTokenToIndex = (token: string, dim: number): { index: number; sign: number } => {
  let hash = 2166136261
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const unsigned = hash >>> 0
  return {
    index: unsigned % dim,
    sign: unsigned % 2 === 0 ? 1 : -1,
  }
}

const embedTextWithHash = (text: string, dim = HASH_VECTOR_DIM): number[] => {
  const vector = new Array<number>(dim).fill(0)
  const tokens = tokenizeForHash(text)
  if (tokens.length === 0) return vector

  for (const token of tokens) {
    const { index, sign } = hashTokenToIndex(token, dim)
    vector[index] += sign
  }

  const mag = magnitude(vector)
  if (!mag) return vector
  return vector.map((value) => value / mag)
}

const ensureExtractor = async (): Promise<FeatureExtractor> => {
  if (extractor) return extractor
  if (!extractorPromise) {
    embeddingStatus = 'loading'
    extractorPromise = (async () => {
      const transformers = (await import('@xenova/transformers')) as TransformersLike
      await preflightModelEndpoint()
      if (transformers.env) {
        transformers.env.allowRemoteModels = true
        transformers.env.allowLocalModels = false
        transformers.env.useBrowserCache = true
        transformers.env.remoteHost = HUGGING_FACE_HOST
        transformers.env.remotePathTemplate = HUGGING_FACE_TEMPLATE
        if (transformers.env.backends?.onnx?.wasm) {
          transformers.env.backends.onnx.wasm.numThreads = 1
          transformers.env.backends.onnx.wasm.proxy = false
          transformers.env.backends.onnx.wasm.wasmPaths = WASM_CDN
        }
      }
      const loaded = await transformers.pipeline('feature-extraction', EMBEDDING_MODEL)
      extractor = loaded
      embeddingStatus = 'ready'
      lastEmbeddingError = ''
      return loaded
    })().catch((error) => {
      embeddingStatus = 'failed'
      extractorPromise = null
      lastEmbeddingError = error instanceof Error ? error.message : 'embedding initialization failed'
      throw error
    })
  }
  return extractorPromise
}

const embedTextWithBrowser = async (text: string): Promise<number[]> => {
  const model = await ensureExtractor()
  const output = await model(text, { pooling: 'mean', normalize: true })
  return asNumberArray(output)
}

const vectorCacheKey = (
  provider: 'browser' | 'api' | 'hash',
  model: string,
  factId: string,
  factUpdatedAt: string,
  factText: string,
): string => `${provider}:${model}:${factId}:${factUpdatedAt}:${factText}`

const embedTextsWithApi = async (
  client: LmStudioClient,
  model: string,
  texts: string[],
): Promise<number[][]> => {
  if (texts.length === 0) return []
  const output: number[][] = []
  for (let index = 0; index < texts.length; index += API_BATCH_SIZE) {
    const batch = texts.slice(index, index + API_BATCH_SIZE)
    const vectors = await client.embeddings(model, batch)
    output.push(...vectors)
  }
  return output
}

export const probeApiEmbeddings = async (client: LmStudioClient): Promise<void> => {
  await embedTextsWithApi(client, lmStudioEmbeddingModel, ['embedding health check'])
  embeddingStatus = 'ready'
  lastEmbeddingError = ''
}

export const initializeEmbeddings = async (forceRetry = false): Promise<EmbeddingStatus> => {
  if (forceRetry) {
    extractor = null
    extractorPromise = null
    embeddingStatus = 'idle'
    lastEmbeddingError = ''
  }
  try {
    await ensureExtractor()
    return embeddingStatus
  } catch {
    return embeddingStatus
  }
}

export const getEmbeddingStatus = (): EmbeddingStatus => embeddingStatus
export const getEmbeddingError = (): string => lastEmbeddingError
export const getLmStudioEmbeddingModel = (): string => lmStudioEmbeddingModel
export const setLmStudioEmbeddingModel = (model: string): void => {
  const trimmed = model.trim()
  if (trimmed) {
    lmStudioEmbeddingModel = trimmed
  }
}

export const embedTextForMemory = async (params: {
  text: string
  client?: LmStudioClient
  allowApiFallback?: boolean
}): Promise<{
  vector: number[]
  provider: 'browser' | 'api' | 'hash'
  usedFallback: boolean
  error?: string
}> => {
  const { text, client, allowApiFallback = true } = params
  if (!text.trim()) {
    return {
      vector: new Array<number>(HASH_VECTOR_DIM).fill(0),
      provider: embeddingStatus === 'failed' ? 'hash' : 'browser',
      usedFallback: false,
    }
  }

  if (embeddingStatus === 'failed') {
    if (allowApiFallback && client) {
      try {
        const vector = (await embedTextsWithApi(client, lmStudioEmbeddingModel, [text]))[0] ?? []
        embeddingStatus = 'ready'
        lastEmbeddingError = ''
        return { vector, provider: 'api', usedFallback: false }
      } catch (apiError) {
        const apiMessage = apiError instanceof Error ? apiError.message : 'api embeddings failed'
        const vector = embedTextWithHash(text)
        return {
          vector,
          provider: 'hash',
          usedFallback: true,
          error: `${lastEmbeddingError || 'browser embeddings failed'} | ${apiMessage}`,
        }
      }
    }
    return {
      vector: embedTextWithHash(text),
      provider: 'hash',
      usedFallback: false,
      error: lastEmbeddingError || undefined,
    }
  }

  try {
    const vector = await embedTextWithBrowser(text)
    return { vector, provider: 'browser', usedFallback: false }
  } catch (browserError) {
    embeddingStatus = 'failed'
    lastEmbeddingError =
      browserError instanceof Error ? browserError.message : 'semantic search failed'
    if (allowApiFallback && client) {
      try {
        const vector = (await embedTextsWithApi(client, lmStudioEmbeddingModel, [text]))[0] ?? []
        embeddingStatus = 'ready'
        lastEmbeddingError = ''
        return { vector, provider: 'api', usedFallback: false }
      } catch (apiError) {
        const apiMessage = apiError instanceof Error ? apiError.message : 'api embeddings failed'
        return {
          vector: embedTextWithHash(text),
          provider: 'hash',
          usedFallback: true,
          error: `${lastEmbeddingError} | ${apiMessage}`,
        }
      }
    }
    return {
      vector: embedTextWithHash(text),
      provider: 'hash',
      usedFallback: false,
      error: lastEmbeddingError,
    }
  }
}

const scoreFacts = (
  activeFacts: MemoryGraphState['facts'],
  vectorsByFactId: Map<string, number[]>,
  promptVector: number[],
  limit: number,
): SemanticPrefilterResult[] =>
  activeFacts
    .map((fact) => {
      const vector = vectorsByFactId.get(fact.id) ?? []
      return {
        fact,
        score: cosineSimilarity(promptVector, vector),
      }
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

const runBrowserSemanticPrefilter = async (
  graph: MemoryGraphState,
  prompt: string,
  limit: number,
): Promise<{ results: SemanticPrefilterResult[]; graph: MemoryGraphState; embeddedCount: number }> => {
  const activeFacts = graph.facts.filter((fact) => fact.status !== 'superseded')
  pruneVectorCacheForGraph(graph)
  const promptVector = await embedTextWithBrowser(prompt)
  const vectorsByFactId = new Map<string, number[]>()
  const newEntries: FactVectorIndexEntry[] = []

  await Promise.all(
    activeFacts.map(async (fact) => {
      const factText = makeFactText(graph, fact.id, fact.canonicalText)
      const textHash = hashText(factText)
      const key = vectorCacheKey('browser', EMBEDDING_MODEL, fact.id, fact.updatedAt, factText)
      let entry = getVectorCacheEntry(key)
      if (entry) {
        vectorsByFactId.set(fact.id, entry.vector)
        return
      }

      const stored = findVectorInGraph(graph, 'browser', EMBEDDING_MODEL, fact.id, fact.updatedAt, textHash)
      if (stored) {
        setVectorCacheEntry(key, stored)
        vectorsByFactId.set(fact.id, stored.vector)
        return
      }

      const vector = await embedTextWithBrowser(factText)
      entry = {
        factId: fact.id,
        vector,
        updatedAt: fact.updatedAt,
        provider: 'browser',
        model: EMBEDDING_MODEL,
        textHash,
      }
      setVectorCacheEntry(key, entry)
      vectorsByFactId.set(fact.id, vector)
      newEntries.push(entry)
    }),
  )

  const nextGraph = upsertVectorIndex(graph, newEntries)
  return {
    results: scoreFacts(activeFacts, vectorsByFactId, promptVector, limit),
    graph: nextGraph,
    embeddedCount: newEntries.length,
  }
}

const runApiSemanticPrefilter = async (
  client: LmStudioClient,
  graph: MemoryGraphState,
  prompt: string,
  limit: number,
): Promise<{ results: SemanticPrefilterResult[]; graph: MemoryGraphState; embeddedCount: number }> => {
  const activeFacts = graph.facts.filter((fact) => fact.status !== 'superseded')
  pruneVectorCacheForGraph(graph)
  const promptVector = (await embedTextsWithApi(client, lmStudioEmbeddingModel, [prompt]))[0] ?? []
  const vectorsByFactId = new Map<string, number[]>()
  const missing: Array<{ key: string; factId: string; text: string; updatedAt: string; textHash: string }> = []
  const newEntries: FactVectorIndexEntry[] = []

  for (const fact of activeFacts) {
    const factText = makeFactText(graph, fact.id, fact.canonicalText)
    const textHash = hashText(factText)
    const key = vectorCacheKey('api', lmStudioEmbeddingModel, fact.id, fact.updatedAt, factText)
    const existing = getVectorCacheEntry(key)
    if (existing) {
      vectorsByFactId.set(fact.id, existing.vector)
      continue
    }
    const stored = findVectorInGraph(graph, 'api', lmStudioEmbeddingModel, fact.id, fact.updatedAt, textHash)
    if (stored) {
      setVectorCacheEntry(key, stored)
      vectorsByFactId.set(fact.id, stored.vector)
      continue
    }
    missing.push({
      key,
      factId: fact.id,
      text: factText,
      updatedAt: fact.updatedAt,
      textHash,
    })
  }

  if (missing.length > 0) {
    const vectors = await embedTextsWithApi(
      client,
      lmStudioEmbeddingModel,
      missing.map((item) => item.text),
    )
    for (let index = 0; index < missing.length; index += 1) {
      const item = missing[index]
      const vector = vectors[index] ?? []
      setVectorCacheEntry(item.key, {
        factId: item.factId,
        vector,
        updatedAt: item.updatedAt,
        provider: 'api',
        model: lmStudioEmbeddingModel,
        textHash: item.textHash,
      })
      vectorsByFactId.set(item.factId, vector)
      newEntries.push({
        factId: item.factId,
        vector,
        updatedAt: item.updatedAt,
        provider: 'api',
        model: lmStudioEmbeddingModel,
        textHash: item.textHash,
      })
    }
  }

  const nextGraph = upsertVectorIndex(graph, newEntries)
  return {
    results: scoreFacts(activeFacts, vectorsByFactId, promptVector, limit),
    graph: nextGraph,
    embeddedCount: newEntries.length,
  }
}

const runHashSemanticPrefilter = (
  graph: MemoryGraphState,
  prompt: string,
  limit: number,
): { results: SemanticPrefilterResult[]; graph: MemoryGraphState; embeddedCount: number } => {
  const activeFacts = graph.facts.filter((fact) => fact.status !== 'superseded')
  pruneVectorCacheForGraph(graph)
  const promptVector = embedTextWithHash(prompt)
  const vectorsByFactId = new Map<string, number[]>()
  const newEntries: FactVectorIndexEntry[] = []

  for (const fact of activeFacts) {
    const factText = makeFactText(graph, fact.id, fact.canonicalText)
    const textHash = hashText(factText)
    const key = vectorCacheKey('hash', HASH_EMBEDDING_MODEL, fact.id, fact.updatedAt, factText)
    const cached = getVectorCacheEntry(key)
    if (cached) {
      vectorsByFactId.set(fact.id, cached.vector)
      continue
    }

    const stored = findVectorInGraph(graph, 'hash', HASH_EMBEDDING_MODEL, fact.id, fact.updatedAt, textHash)
    if (stored) {
      setVectorCacheEntry(key, stored)
      vectorsByFactId.set(fact.id, stored.vector)
      continue
    }

    const vector = embedTextWithHash(factText)
    const entry: FactVectorIndexEntry = {
      factId: fact.id,
      vector,
      updatedAt: fact.updatedAt,
      provider: 'hash',
      model: HASH_EMBEDDING_MODEL,
      textHash,
    }
    setVectorCacheEntry(key, entry)
    vectorsByFactId.set(fact.id, vector)
    newEntries.push(entry)
  }

  const nextGraph = upsertVectorIndex(graph, newEntries)
  return {
    results: scoreFacts(activeFacts, vectorsByFactId, promptVector, limit),
    graph: nextGraph,
    embeddedCount: newEntries.length,
  }
}

export const semanticPrefilterFacts = async (params: {
  graph: MemoryGraphState
  prompt: string
  limit?: number
  client?: LmStudioClient
  allowApiFallback?: boolean
}): Promise<{
  results: SemanticPrefilterResult[]
  usedFallback: boolean
  provider?: 'browser' | 'api' | 'hash'
  error?: string
  graph?: MemoryGraphState
  embeddedCount?: number
}> => {
  const { graph, prompt, limit = SHORTLIST_LIMIT, client, allowApiFallback = true } = params
  if (!prompt.trim()) {
    return { results: [], usedFallback: false, provider: embeddingStatus === 'failed' ? 'hash' : 'browser' }
  }

  const activeFacts = graph.facts.filter((fact) => fact.status !== 'superseded')
  if (activeFacts.length === 0) {
    if (allowApiFallback && embeddingStatus === 'failed' && client) {
      try {
        await probeApiEmbeddings(client)
        return { results: [], usedFallback: false, provider: 'api' }
      } catch (apiError) {
        const apiMessage =
          apiError instanceof Error ? apiError.message : 'api embeddings failed'
        const hashResult = runHashSemanticPrefilter(graph, prompt, limit)
        return {
          results: hashResult.results,
          usedFallback: true,
          provider: 'hash',
          graph: hashResult.graph,
          embeddedCount: hashResult.embeddedCount,
          error: `${lastEmbeddingError || 'browser embeddings failed'} | ${apiMessage}`,
        }
      }
    }
    if (embeddingStatus === 'failed') {
      return {
        results: [],
        usedFallback: false,
        provider: 'hash',
        error: lastEmbeddingError || undefined,
        graph,
        embeddedCount: 0,
      }
    }
    return { results: [], usedFallback: false, provider: 'browser' }
  }

  if (embeddingStatus === 'failed') {
    if (allowApiFallback && client) {
      try {
        const apiResult = await runApiSemanticPrefilter(client, graph, prompt, limit)
        return {
          results: apiResult.results,
          usedFallback: false,
          provider: 'api',
          graph: apiResult.graph,
          embeddedCount: apiResult.embeddedCount,
        }
      } catch (apiError) {
        const apiMessage =
          apiError instanceof Error ? apiError.message : 'api embeddings failed'
        const hashResult = runHashSemanticPrefilter(graph, prompt, limit)
        return {
          results: hashResult.results,
          usedFallback: true,
          provider: 'hash',
          graph: hashResult.graph,
          embeddedCount: hashResult.embeddedCount,
          error: `${lastEmbeddingError || 'browser embeddings failed'} | ${apiMessage}`,
        }
      }
    }
    const hashResult = runHashSemanticPrefilter(graph, prompt, limit)
    return {
      results: hashResult.results,
      usedFallback: false,
      provider: 'hash',
      graph: hashResult.graph,
      embeddedCount: hashResult.embeddedCount,
      error: lastEmbeddingError || 'browser embeddings unavailable; using local hash vectors',
    }
  }

  try {
    const browserResult = await runBrowserSemanticPrefilter(graph, prompt, limit)
    return {
      results: browserResult.results,
      usedFallback: false,
      provider: 'browser',
      graph: browserResult.graph,
      embeddedCount: browserResult.embeddedCount,
    }
  } catch (browserError) {
    embeddingStatus = 'failed'
    lastEmbeddingError =
      browserError instanceof Error ? browserError.message : 'semantic search failed'
    if (allowApiFallback && client) {
      try {
        const apiResult = await runApiSemanticPrefilter(client, graph, prompt, limit)
        return {
          results: apiResult.results,
          usedFallback: false,
          provider: 'api',
          graph: apiResult.graph,
          embeddedCount: apiResult.embeddedCount,
        }
      } catch (apiError) {
        const apiMessage =
          apiError instanceof Error ? apiError.message : 'api embeddings failed'
        const hashResult = runHashSemanticPrefilter(graph, prompt, limit)
        return {
          results: hashResult.results,
          usedFallback: true,
          provider: 'hash',
          graph: hashResult.graph,
          embeddedCount: hashResult.embeddedCount,
          error: `${lastEmbeddingError} | ${apiMessage}`,
        }
      }
    }
    const hashResult = runHashSemanticPrefilter(graph, prompt, limit)
    return {
      results: hashResult.results,
      usedFallback: false,
      provider: 'hash',
      graph: hashResult.graph,
      embeddedCount: hashResult.embeddedCount,
      error: lastEmbeddingError,
    }
  }
}

export const clearEmbeddingCache = (): void => {
  vectorCache.clear()
}
