import { describe, expect, it } from 'vitest'
import { LmStudioClient } from './lmStudioClient'
import type { ModelInfo } from '../types/chat'

const RUN_INTEGRATION = process.env.LMSTUDIO_TEST_INTEGRATION === '1'
const describeIf = RUN_INTEGRATION ? describe : describe.skip

const BASE_URL = process.env.LMSTUDIO_TEST_BASE_URL ?? 'http://localhost:1234'
const CHAT_MODEL = process.env.LMSTUDIO_TEST_CHAT_MODEL ?? ''
const EMBEDDING_MODEL = process.env.LMSTUDIO_TEST_EMBED_MODEL ?? 'text-embedding-nomic-embed-text-v1.5'
const INTEGRATION_TIMEOUT_MS = 120_000

const getLoadedLlmInstanceIds = (models: ModelInfo[]): string[] =>
  models
    .filter((model) => model.type === 'llm')
    .flatMap((model) => model.loaded_instances ?? [])
    .map((instance) => instance?.id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)

const isConfiguredChatModelUsable = (configured: string): boolean => {
  const normalized = configured.trim().toLowerCase()
  if (!normalized) return false
  if (normalized === 'your-chat-model-id') return false
  if (normalized === '<your-chat-model-id>') return false
  return true
}

const resolveChatTarget = (models: ModelInfo[]): string | null => {
  const llmModels = models.filter((model) => model.type === 'llm')
  if (llmModels.length === 0) return null

  const configured = CHAT_MODEL.trim()
  if (isConfiguredChatModelUsable(configured)) {
    const exact = llmModels.find((model) => model.id === configured || model.key === configured)
    if (exact) return exact.id
  }

  const loaded = llmModels.find((model) => model.loaded)?.id
  if (loaded) return loaded

  const smallest = [...llmModels].sort((a, b) => {
    const sizeA = typeof a.size_bytes === 'number' ? a.size_bytes : Number.MAX_SAFE_INTEGER
    const sizeB = typeof b.size_bytes === 'number' ? b.size_bytes : Number.MAX_SAFE_INTEGER
    return sizeA - sizeB
  })[0]
  return smallest?.id ?? null
}

describeIf('LM Studio live integration', () => {
  const client = new LmStudioClient(BASE_URL)
  const baselineLoadedInstanceIds = new Set<string>()

  const unloadNonBaselineInstances = async (): Promise<void> => {
    const models = await client.listModels()
    const currentLoaded = getLoadedLlmInstanceIds(models)
    const extra = currentLoaded.filter((instanceId) => !baselineLoadedInstanceIds.has(instanceId))
    for (const instanceId of extra) {
      await client.unloadModel(instanceId)
    }
  }

  it('captures baseline loaded llm instances', async () => {
    const models = await client.listModels()
    for (const instanceId of getLoadedLlmInstanceIds(models)) {
      baselineLoadedInstanceIds.add(instanceId)
    }
    expect(true).toBe(true)
  }, INTEGRATION_TIMEOUT_MS)

  it('lists models', async () => {
    const models = await client.listModels()
    expect(Array.isArray(models)).toBe(true)
  }, INTEGRATION_TIMEOUT_MS)

  it('loads and unloads a model (smoke)', async () => {
    const models = await client.listModels()
    const target = resolveChatTarget(models)
    if (!target) {
      expect(true).toBe(true)
      return
    }
    await client.loadModel(target)
    await unloadNonBaselineInstances()
    expect(true).toBe(true)
  }, INTEGRATION_TIMEOUT_MS)

  it('runs non-stream and stream chat sanity', async () => {
    const models = await client.listModels()
    const target = resolveChatTarget(models)
    if (!target) {
      expect(true).toBe(true)
      return
    }

    await client.loadModel(target)
    const nonStream = await client.chat({
      model: target,
      input: 'Reply with "ok".',
      stream: false,
      store: false,
    })
    expect(nonStream).toBeTruthy()

    let sawDelta = false
    await client.streamChat(
      {
        model: target,
        input: 'Reply with a single short sentence.',
        stream: true,
        store: false,
      },
      {
        onEvent: (event) => {
          if (event.type === 'message.delta') {
            sawDelta = true
          }
        },
        onError: (error) => {
          throw error
        },
        onComplete: () => undefined,
      },
    )
    expect(sawDelta).toBe(true)
    await unloadNonBaselineInstances()
  }, INTEGRATION_TIMEOUT_MS)

  it('requests embeddings from configured embedding model', async () => {
    const vectors = await client.embeddings(EMBEDDING_MODEL, ['integration embedding test'])
    expect(vectors.length).toBeGreaterThan(0)
    expect(vectors[0].length).toBeGreaterThan(0)
    await unloadNonBaselineInstances()
  }, INTEGRATION_TIMEOUT_MS)
})
