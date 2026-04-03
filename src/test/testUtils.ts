import { vi } from 'vitest'
import type { LmStudioClient, StreamHandlers } from '../lib/lmStudioClient'
import type { ChatTurnRequest, ModelInfo } from '../types/chat'

export type MockLmStudioClient = Pick<
  LmStudioClient,
  'listModels' | 'loadModel' | 'unloadModel' | 'streamChat' | 'chat' | 'embeddings'
>

export const createMockLmStudioClient = (
  overrides: Partial<MockLmStudioClient> = {},
): MockLmStudioClient => ({
  listModels: vi.fn(async (): Promise<ModelInfo[]> => []),
  loadModel: vi.fn(async (): Promise<void> => {}),
  unloadModel: vi.fn(async (): Promise<void> => {}),
  streamChat: vi.fn(async (_request: ChatTurnRequest, handlers: StreamHandlers): Promise<void> => {
    handlers.onComplete()
  }),
  chat: vi.fn(async () => ({} as Record<string, unknown>)),
  embeddings: vi.fn(async () => [[0.1, 0.2, 0.3]]),
  ...overrides,
})

export const sseEventChunk = (eventType: string, payload: Record<string, unknown> | string): string => {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return `event: ${eventType}\ndata: ${data}\n\n`
}

export const sseDoneChunk = (): string => 'data: [DONE]\n\n'

export const createSseResponse = (chunks: string[], status = 200): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'text/event-stream',
      },
    },
  )

type MockFetchStep =
  | Response
  | Error
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response)

export const installFetchMockSequence = (steps: MockFetchStep[]) => {
  const queue = [...steps]
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (queue.length === 0) {
      throw new Error('No fetch mock step left')
    }
    const step = queue.shift()
    if (!step) {
      throw new Error('Invalid fetch mock step')
    }
    if (step instanceof Error) {
      throw step
    }
    if (typeof step === 'function') {
      return await step(input, init)
    }
    return step
  })

  vi.stubGlobal('fetch', mock as unknown as typeof fetch)
  return mock
}

export const createLocalStorageMock = () => {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}
