import type { ChatTurnRequest, ModelInfo, StreamEvent } from '../types/chat'

export interface StreamHandlers {
  onEvent: (event: StreamEvent) => void
  onError: (error: Error) => void
  onComplete: () => void
}

const buildJsonHeaders = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Authorization: 'Bearer lm-studio',
})

const parseSseChunk = (chunk: string): StreamEvent | null => {
  const lines = chunk
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  let eventType = 'unknown'
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim()
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  if (dataLines.length === 0) return null

  const dataRaw = dataLines.join('\n')
  if (dataRaw === '[DONE]') {
    return { type: 'done' }
  }

  try {
    const parsed = JSON.parse(dataRaw) as Record<string, unknown>
    return {
      type: typeof parsed.type === 'string' ? parsed.type : eventType,
      ...parsed,
    }
  } catch {
    return {
      type: eventType,
      raw: dataRaw,
    }
  }
}

export class LmStudioClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/v1/models`)
    if (!response.ok) {
      throw new Error(`Failed to list models (${response.status})`)
    }

    const body = (await response.json()) as {
      data?: Array<Record<string, unknown>>
      models?: Array<Record<string, unknown>>
    }

    const rawModels = Array.isArray(body.models)
      ? body.models
      : Array.isArray(body.data)
        ? body.data
        : []

    return rawModels
      .map((raw): ModelInfo => {
        const idCandidate =
          (typeof raw.id === 'string' && raw.id) ||
          (typeof raw.key === 'string' && raw.key) ||
          (typeof raw.model_key === 'string' && raw.model_key) ||
          (typeof raw.identifier === 'string' && raw.identifier) ||
          ''

        const loadedInstances = Array.isArray(raw.loaded_instances)
          ? (raw.loaded_instances as Array<{ id?: string }>)
          : []

        return {
          ...raw,
          id: idCandidate,
          key: typeof raw.key === 'string' ? raw.key : undefined,
          loaded_instances: loadedInstances,
          loaded:
            typeof raw.loaded === 'boolean' ? raw.loaded : loadedInstances.length > 0,
        }
      })
      .filter((model) => Boolean(model.id))
  }

  async loadModel(modelKey: string): Promise<void> {
    await this.modelAction('/api/v1/models/load', modelKey)
  }

  async unloadModel(modelKey: string): Promise<void> {
    let models: ModelInfo[] = []
    try {
      models = await this.listModels()
    } catch {
      // Fallback below: attempt direct unload with the provided identifier.
    }

    const matchedModel = models.find((model) => model.id === modelKey || model.key === modelKey)
    const loadedInstanceIds =
      matchedModel?.loaded_instances
        ?.map((instance) => instance?.id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0) ?? []

    if (matchedModel && loadedInstanceIds.length === 0) {
      return
    }

    const targets = loadedInstanceIds.length > 0 ? loadedInstanceIds : [modelKey]
    let lastError: Error | null = null
    let anySuccess = false

    for (const instanceId of targets) {
      try {
        await this.unloadInstance(instanceId)
        anySuccess = true
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unload failed')
      }
    }

    if (!anySuccess) {
      throw lastError ?? new Error(`Unload failed for ${modelKey}`)
    }
  }

  private async modelAction(path: string, modelKey: string): Promise<void> {
    const payloads: Array<Record<string, string>> = [
      { model: modelKey },
      { model_key: modelKey },
      { identifier: modelKey },
      { key: modelKey },
      { id: modelKey },
    ]

    let lastError: Error | null = null

    for (const payload of payloads) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: buildJsonHeaders(),
        body: JSON.stringify(payload),
      })

      if (response.ok) return
      lastError = new Error(`Request failed (${response.status}) with payload ${Object.keys(payload)[0]}`)
    }

    throw lastError ?? new Error('Model action failed')
  }

  private async unloadInstance(instanceId: string): Promise<void> {
    const payloads: Array<Record<string, string>> = [
      { instance_id: instanceId },
      { id: instanceId },
      { identifier: instanceId },
    ]

    let lastError: Error | null = null

    for (const payload of payloads) {
      const response = await fetch(`${this.baseUrl}/api/v1/models/unload`, {
        method: 'POST',
        headers: buildJsonHeaders(),
        body: JSON.stringify(payload),
      })
      if (response.ok) return
      const body = await response.text()
      lastError = new Error(
        `Request failed (${response.status}) with payload ${Object.keys(payload)[0]}${body ? `: ${body.slice(0, 160)}` : ''}`,
      )
    }

    throw lastError ?? new Error('Unload request failed')
  }

  async streamChat(request: ChatTurnRequest, handlers: StreamHandlers): Promise<void> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/v1/chat`, {
        method: 'POST',
        headers: buildJsonHeaders(),
        body: JSON.stringify({ ...request, stream: true, store: request.store ?? true }),
      })
    } catch (error) {
      handlers.onError(error instanceof Error ? error : new Error('Network error'))
      return
    }

    if (!response.ok || !response.body) {
      handlers.onError(new Error(`Chat request failed (${response.status})`))
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''

        for (const chunk of chunks) {
          const event = parseSseChunk(chunk)
          if (!event) continue
          handlers.onEvent(event)
        }
      }

      if (buffer.trim().length > 0) {
        const event = parseSseChunk(buffer)
        if (event) handlers.onEvent(event)
      }

      handlers.onComplete()
    } catch (error) {
      handlers.onError(error instanceof Error ? error : new Error('Stream interrupted'))
    } finally {
      reader.releaseLock()
    }
  }

  async chat(request: ChatTurnRequest): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: buildJsonHeaders(),
      body: JSON.stringify({ ...request, stream: false, store: request.store ?? false }),
    })

    if (!response.ok) {
      throw new Error(`Chat request failed (${response.status})`)
    }

    return (await response.json()) as Record<string, unknown>
  }

  async embeddings(model: string, input: string[]): Promise<number[][]> {
    const endpoints = ['/v1/embeddings', '/api/v1/embeddings']
    let lastError: Error | null = null

    for (const endpoint of endpoints) {
      try {
        const url = `${this.baseUrl}${endpoint}`
        const response = await fetch(url, {
          method: 'POST',
          headers: buildJsonHeaders(),
          body: JSON.stringify({
            model,
            input,
          }),
        })

        const text = await response.text()
        if (!response.ok) {
          throw new Error(`Embeddings request failed (${response.status}) at ${url}: ${text.slice(0, 220)}`)
        }

        let body: { data?: Array<{ embedding?: number[]; index?: number }> }
        try {
          body = JSON.parse(text) as { data?: Array<{ embedding?: number[]; index?: number }> }
        } catch {
          throw new Error(`Embeddings response was not JSON at ${url}: ${text.slice(0, 120)}`)
        }

        if (!Array.isArray(body.data) || body.data.length === 0) {
          throw new Error(`Embeddings response missing data at ${url}`)
        }

        const ordered = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        const vectors = ordered
          .map((item) => (Array.isArray(item.embedding) ? item.embedding : []))
          .filter((vector) => vector.length > 0)

        if (vectors.length === 0) {
          throw new Error(`Embeddings response missing vectors at ${url}`)
        }

        return vectors
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Embeddings request failed')
      }
    }

    throw lastError ?? new Error('Embeddings request failed')
  }
}
