import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryGraphState } from '../types/chat'

const makeGraph = (): MemoryGraphState => {
  const now = new Date().toISOString()
  return {
    facts: [
      {
        id: 'fact-1',
        canonicalText: 'User prefers concise answers',
        category: 'preference',
        status: 'active',
        confidence: 0.9,
        sourceTags: ['chat'],
        createdAt: now,
        updatedAt: now,
      },
    ],
    evidence: [],
    aliases: [{ factId: 'fact-1', aliasText: 'concise answers' }],
    conflicts: [],
  }
}

describe('semanticSearch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('initializes browser embeddings successfully', async () => {
    vi.doMock('@xenova/transformers', () => ({
      env: {
        backends: {
          onnx: {
            wasm: {},
          },
        },
      },
      pipeline: vi.fn(async () => async () => ({ tolist: () => [[0.1, 0.2, 0.3]] })),
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    )

    const semantic = await import('./semanticSearch')
    const status = await semantic.initializeEmbeddings(true)
    expect(status).toBe('ready')
    expect(semantic.getEmbeddingStatus()).toBe('ready')
  })

  it('probes LM Studio API embedding model', async () => {
    const semantic = await import('./semanticSearch')
    const embeddings = vi.fn(async () => [[0.1, 0.2]])
    const client = { embeddings }

    await semantic.probeApiEmbeddings(client as never)

    expect(embeddings).toHaveBeenCalledWith('text-embedding-nomic-embed-text-v1.5', ['embedding health check'])
    expect(semantic.getLmStudioEmbeddingModel()).toBe('text-embedding-nomic-embed-text-v1.5')
  })

  it('falls back to API embeddings when browser initialization fails and uses cache', async () => {
    vi.doMock('@xenova/transformers', () => ({
      env: {
        backends: {
          onnx: {
            wasm: {},
          },
        },
      },
      pipeline: vi.fn(async () => async () => ({ tolist: () => [[1, 0]] })),
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    )
    const semantic = await import('./semanticSearch')
    await semantic.initializeEmbeddings(true)

    const embeddings = vi.fn(async (_model: string, input: string[]) => input.map(() => [1, 0, 0]))
    const client = { embeddings }
    const graph = makeGraph()

    const first = await semantic.semanticPrefilterFacts({
      graph,
      prompt: 'Please keep it concise',
      client: client as never,
    })
    const second = await semantic.semanticPrefilterFacts({
      graph,
      prompt: 'Please keep it concise',
      client: client as never,
    })

    expect(first.provider).toBe('api')
    expect(first.usedFallback).toBe(false)
    expect(first.results.length).toBeGreaterThan(0)
    expect(second.provider).toBe('api')
    expect(embeddings).toHaveBeenCalledTimes(3)

    semantic.clearEmbeddingCache()
    await semantic.semanticPrefilterFacts({
      graph,
      prompt: 'Please keep it concise',
      client: client as never,
    })
    expect(embeddings).toHaveBeenCalledTimes(5)
  })

  it('surfaces browser embedding error and falls back when API is unavailable', async () => {
    vi.doMock('@xenova/transformers', () => ({
      env: {
        backends: {
          onnx: {
            wasm: {},
          },
        },
      },
      pipeline: vi.fn(async () => async () => ({ tolist: () => [[1, 0]] })),
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    )

    const semantic = await import('./semanticSearch')
    await semantic.initializeEmbeddings(true)

    const failed = await semantic.semanticPrefilterFacts({
      graph: makeGraph(),
      prompt: 'hello',
      client: {
        embeddings: vi.fn(async () => {
          throw new Error('api down')
        }),
      } as never,
    })

    expect(failed.usedFallback).toBe(true)
    expect(failed.error).toContain('api down')
    expect(semantic.getEmbeddingError()).toContain('HTML')
  })

  it('skips API fallback when disabled to avoid model switching during chat turns', async () => {
    vi.doMock('@xenova/transformers', () => ({
      env: {
        backends: {
          onnx: {
            wasm: {},
          },
        },
      },
      pipeline: vi.fn(async () => async () => ({ tolist: () => [[1, 0]] })),
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    )

    const semantic = await import('./semanticSearch')
    await semantic.initializeEmbeddings(true)

    const embeddings = vi.fn(async () => [[0.1, 0.2]])
    const result = await semantic.semanticPrefilterFacts({
      graph: makeGraph(),
      prompt: 'hello',
      client: { embeddings } as never,
      allowApiFallback: false,
    })

    expect(result.usedFallback).toBe(false)
    expect(result.provider).toBe('hash')
    expect(result.results.length).toBeGreaterThan(0)
    expect(embeddings).not.toHaveBeenCalled()
  })

  it('reports hash provider for empty graph when browser embeddings are failed', async () => {
    vi.doMock('@xenova/transformers', () => ({
      env: {
        backends: {
          onnx: {
            wasm: {},
          },
        },
      },
      pipeline: vi.fn(async () => async () => ({ tolist: () => [[1, 0]] })),
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    )

    const semantic = await import('./semanticSearch')
    await semantic.initializeEmbeddings(true)

    const result = await semantic.semanticPrefilterFacts({
      graph: { facts: [], evidence: [], aliases: [], conflicts: [], vectorIndex: [] },
      prompt: 'hello',
      allowApiFallback: false,
    })

    expect(result.provider).toBe('hash')
    expect(result.usedFallback).toBe(false)
  })

  it('embeds arbitrary memory text with hash provider when browser embeddings fail', async () => {
    vi.doMock('@xenova/transformers', () => ({
      env: {
        backends: {
          onnx: {
            wasm: {},
          },
        },
      },
      pipeline: vi.fn(async () => async () => ({ tolist: () => [[1, 0]] })),
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })),
    )

    const semantic = await import('./semanticSearch')
    await semantic.initializeEmbeddings(true)
    const result = await semantic.embedTextForMemory({
      text: 'User likes short answers',
      allowApiFallback: false,
    })
    expect(result.provider).toBe('hash')
    expect(result.vector.length).toBeGreaterThan(0)
  })

  it('exports cosine similarity helper for vector scoring', async () => {
    const semantic = await import('./semanticSearch')
    const score = semantic.cosineSimilarityVectors([1, 0], [1, 0])
    expect(score).toBe(1)
  })
})
