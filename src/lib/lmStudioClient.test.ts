import { afterEach, describe, expect, it, vi } from 'vitest'
import { LmStudioClient } from './lmStudioClient'
import { createSseResponse, installFetchMockSequence, sseDoneChunk, sseEventChunk } from '../test/testUtils'

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('LmStudioClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('maps listModels response from data payload', async () => {
    installFetchMockSequence([
      jsonResponse({
        data: [
          {
            key: 'model-key',
            id: 'model-id',
            loaded_instances: [{ id: 'inst-1' }],
          },
        ],
      }),
    ])
    const client = new LmStudioClient('http://localhost:1234')

    const result = await client.listModels()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('model-id')
    expect(result[0].loaded).toBe(true)
  })

  it('tries model action payload fallbacks until one works', async () => {
    const fetchMock = installFetchMockSequence([
      jsonResponse({ error: 'bad payload' }, 400),
      jsonResponse({ ok: true }, 200),
    ])
    const client = new LmStudioClient('http://localhost:1234')

    await client.loadModel('mistral/test')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(firstBody).toEqual({ model: 'mistral/test' })
    expect(secondBody).toEqual({ model_key: 'mistral/test' })
  })

  it('throws when all model action payloads fail', async () => {
    installFetchMockSequence([
      jsonResponse({
        models: [{ key: 'mistral/test', loaded_instances: [{ id: 'mistral/test:1' }] }],
      }),
      jsonResponse({ error: 'bad payload' }, 400),
      jsonResponse({ error: 'bad payload' }, 400),
      jsonResponse({ error: 'bad payload' }, 400),
    ])
    const client = new LmStudioClient('http://localhost:1234')

    await expect(client.unloadModel('mistral/test')).rejects.toThrow('Request failed (400)')
  })

  it('unloads by instance_id when model has loaded instances', async () => {
    const fetchMock = installFetchMockSequence([
      jsonResponse({
        models: [{ key: 'mistral/test', loaded_instances: [{ id: 'mistral/test:1' }] }],
      }),
      jsonResponse({ instance_id: 'mistral/test:1' }, 200),
    ])
    const client = new LmStudioClient('http://localhost:1234')

    await client.unloadModel('mistral/test')

    const unloadBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(unloadBody).toEqual({ instance_id: 'mistral/test:1' })
  })

  it('returns early when model is already unloaded', async () => {
    const fetchMock = installFetchMockSequence([
      jsonResponse({
        models: [{ key: 'mistral/test', loaded_instances: [] }],
      }),
    ])
    const client = new LmStudioClient('http://localhost:1234')

    await client.unloadModel('mistral/test')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('streams SSE events and completes', async () => {
    installFetchMockSequence([
      createSseResponse([
        sseEventChunk('message.delta', { type: 'message.delta', content: 'Hello', response_id: 'resp_1' }),
        sseEventChunk('reasoning.delta', { type: 'reasoning.delta', content: 'Thinking...' }),
        sseDoneChunk(),
      ]),
    ])
    const client = new LmStudioClient('http://localhost:1234')
    const events: Array<Record<string, unknown>> = []
    const onComplete = vi.fn()
    const onError = vi.fn()

    await client.streamChat(
      { model: 'm', input: 'hi', stream: true, store: true },
      {
        onEvent: (event) => events.push(event as Record<string, unknown>),
        onComplete,
        onError,
      },
    )

    expect(onError).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.type)).toEqual(['message.delta', 'reasoning.delta', 'done'])
  })

  it('reports stream error when response is non-ok', async () => {
    installFetchMockSequence([new Response('bad', { status: 400 })])
    const client = new LmStudioClient('http://localhost:1234')
    const onError = vi.fn()

    await client.streamChat(
      { model: 'm', input: 'hi', stream: true, store: true },
      {
        onEvent: vi.fn(),
        onComplete: vi.fn(),
        onError,
      },
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toContain('Chat request failed (400)')
  })

  it('reports network error during stream request', async () => {
    installFetchMockSequence([new Error('network down')])
    const client = new LmStudioClient('http://localhost:1234')
    const onError = vi.fn()

    await client.streamChat(
      { model: 'm', input: 'hi', stream: true, store: true },
      {
        onEvent: vi.fn(),
        onComplete: vi.fn(),
        onError,
      },
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toContain('network down')
  })

  it('throws for non-ok non-stream chat requests', async () => {
    installFetchMockSequence([new Response('bad', { status: 500 })])
    const client = new LmStudioClient('http://localhost:1234')
    await expect(client.chat({ model: 'm', input: 'hello' })).rejects.toThrow('Chat request failed (500)')
  })

  it('falls back from /v1/embeddings to /api/v1/embeddings', async () => {
    const fetchMock = installFetchMockSequence([
      (_input: RequestInfo | URL) => new Response('not found', { status: 404 }),
      (_input: RequestInfo | URL) =>
        jsonResponse({
          data: [
            { index: 0, embedding: [0.1, 0.2] },
            { index: 1, embedding: [0.3, 0.4] },
          ],
        }),
    ])
    const client = new LmStudioClient('http://localhost:1234')

    const vectors = await client.embeddings('text-embedding-nomic-embed-text-v1.5', ['a', 'b'])
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/embeddings')
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/v1/embeddings')
  })

  it('throws clear error when embeddings response is not JSON', async () => {
    installFetchMockSequence([
      new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      new Response('<!doctype html><html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ])
    const client = new LmStudioClient('http://localhost:1234')

    await expect(client.embeddings('text-embedding-nomic-embed-text-v1.5', ['a'])).rejects.toThrow(
      'Embeddings response was not JSON',
    )
  })
})
