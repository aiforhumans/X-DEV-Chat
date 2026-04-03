import { MEMORY_VERSION, emptyMemoryGraph, migrateMemoryV1ToV2 } from './memoryGraph'
import { defaultPersonaMode } from './personaMode'
import type { FactVectorIndexEntry, LegacyMemoryItem, MemorySourceType, PersistedChatState } from '../types/chat'

export const DEFAULT_BASE_URL = 'http://localhost:1234'
const STORAGE_KEY = 'lmstudio-local-chat-state-v1'

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const memoryStore = new Map<string, string>()
const fallbackStorage: StorageLike = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => {
    memoryStore.set(key, value)
  },
  removeItem: (key) => {
    memoryStore.delete(key)
  },
}

const resolveStorage = (): StorageLike => {
  const maybeStorage = (globalThis as { localStorage?: Partial<StorageLike> }).localStorage
  if (
    maybeStorage &&
    typeof maybeStorage.getItem === 'function' &&
    typeof maybeStorage.setItem === 'function' &&
    typeof maybeStorage.removeItem === 'function'
  ) {
    return maybeStorage as StorageLike
  }
  return fallbackStorage
}

export interface LocalUiState {
  baseUrl: string
  selectedModel: string
  brainModel: string
  embedModel: string
  systemPrompt: string
  scenarioPrompt: string
  lastOptimizationMeta?: {
    at: string
    model: string
  }
  personaMode: PersistedChatState['personaMode']
  lastResponseId: string | null
  lastFailedPrompt: string | null
}

export const defaultPersistedState = (): PersistedChatState => ({
  baseUrl: DEFAULT_BASE_URL,
  selectedModel: '',
  brainModel: 'liquid/lfm2.5-1.2b',
  embedModel: 'text-embedding-nomic-embed-text-v1.5',
  systemPrompt: '',
  scenarioPrompt: '',
  lastOptimizationMeta: undefined,
  personaMode: defaultPersonaMode(),
  lastResponseId: null,
  messages: [],
  memoryVersion: MEMORY_VERSION,
  memoryGraph: emptyMemoryGraph(),
  lastFailedPrompt: null,
})

export const loadPersistedState = (): PersistedChatState => {
  const fallback = defaultPersistedState()
  const storage = resolveStorage()

  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return fallback

    const parsed = JSON.parse(raw) as Partial<PersistedChatState> & { memories?: LegacyMemoryItem[] }
    const version = typeof parsed.memoryVersion === 'number' ? parsed.memoryVersion : 1

    const migratedGraph =
      version >= 2 && parsed.memoryGraph
        ? {
            facts: Array.isArray(parsed.memoryGraph.facts)
              ? parsed.memoryGraph.facts.map((fact) => {
                  const parsedTags =
                    Array.isArray(fact.sourceTags) &&
                    fact.sourceTags.every((tag) => tag === 'chat' || tag === 'file')
                      ? fact.sourceTags.filter(
                          (tag): tag is MemorySourceType => tag === 'chat' || tag === 'file',
                        )
                      : []
                  const sourceTags: MemorySourceType[] = parsedTags.length > 0 ? parsedTags : ['chat']
                  return {
                    ...fact,
                    sourceTags,
                  }
                })
              : [],
            evidence: Array.isArray(parsed.memoryGraph.evidence)
              ? parsed.memoryGraph.evidence.map((item) => {
                  const sourceType: MemorySourceType = item.sourceType === 'file' ? 'file' : 'chat'
                  return {
                    ...item,
                    sourceType,
                  }
                })
              : [],
            aliases: Array.isArray(parsed.memoryGraph.aliases) ? parsed.memoryGraph.aliases : [],
            conflicts: Array.isArray(parsed.memoryGraph.conflicts) ? parsed.memoryGraph.conflicts : [],
            vectorIndex: Array.isArray(parsed.memoryGraph.vectorIndex)
              ? parsed.memoryGraph.vectorIndex.reduce<FactVectorIndexEntry[]>((acc, entry) => {
                  if (!entry || typeof entry !== 'object') return acc
                  const maybeEntry = entry as {
                    factId?: unknown
                    vector?: unknown
                    updatedAt?: unknown
                    provider?: unknown
                    model?: unknown
                    textHash?: unknown
                  }
                  if (typeof maybeEntry.factId !== 'string') return acc
                  if (typeof maybeEntry.updatedAt !== 'string') return acc
                  if (!Array.isArray(maybeEntry.vector)) return acc
                  const vector = maybeEntry.vector
                    .map((value) => Number(value))
                    .filter((value) => Number.isFinite(value))
                  if (vector.length === 0) return acc
                  acc.push({
                    factId: maybeEntry.factId,
                    vector,
                    updatedAt: maybeEntry.updatedAt,
                    provider:
                      maybeEntry.provider === 'browser' || maybeEntry.provider === 'api' || maybeEntry.provider === 'hash'
                        ? maybeEntry.provider
                        : undefined,
                    model: typeof maybeEntry.model === 'string' ? maybeEntry.model : undefined,
                    textHash: typeof maybeEntry.textHash === 'string' ? maybeEntry.textHash : undefined,
                  })
                  return acc
                }, [])
              : [],
          }
        : migrateMemoryV1ToV2(Array.isArray(parsed.memories) ? parsed.memories : [])

    const personaBase = defaultPersonaMode()
    const parsedPersona = parsed.personaMode
    const personaMode = {
      enabled:
        typeof parsedPersona?.enabled === 'boolean' ? parsedPersona.enabled : personaBase.enabled,
      intensity:
        typeof parsedPersona?.intensity === 'number'
          ? Math.max(0, Math.min(100, Math.round(parsedPersona.intensity)))
          : personaBase.intensity,
      personaText:
        typeof parsedPersona?.personaText === 'string'
          ? parsedPersona.personaText
          : personaBase.personaText,
      personaUpdatedAt:
        typeof parsedPersona?.personaUpdatedAt === 'string'
          ? parsedPersona.personaUpdatedAt
          : undefined,
    }

    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : fallback.baseUrl,
      selectedModel:
        typeof parsed.selectedModel === 'string' ? parsed.selectedModel : fallback.selectedModel,
      brainModel:
        typeof parsed.brainModel === 'string' ? parsed.brainModel : fallback.brainModel,
      embedModel:
        typeof parsed.embedModel === 'string' ? parsed.embedModel : fallback.embedModel,
      systemPrompt:
        typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : fallback.systemPrompt,
      scenarioPrompt:
        typeof parsed.scenarioPrompt === 'string' ? parsed.scenarioPrompt : fallback.scenarioPrompt,
      lastOptimizationMeta:
        parsed.lastOptimizationMeta &&
        typeof parsed.lastOptimizationMeta === 'object' &&
        typeof parsed.lastOptimizationMeta.at === 'string' &&
        typeof parsed.lastOptimizationMeta.model === 'string'
          ? {
              at: parsed.lastOptimizationMeta.at,
              model: parsed.lastOptimizationMeta.model,
            }
          : undefined,
      personaMode,
      lastResponseId:
        typeof parsed.lastResponseId === 'string' || parsed.lastResponseId === null
          ? parsed.lastResponseId
          : fallback.lastResponseId,
      messages: Array.isArray(parsed.messages) ? parsed.messages : fallback.messages,
      memoryVersion: MEMORY_VERSION,
      memoryGraph: migratedGraph,
      lastFailedPrompt:
        typeof parsed.lastFailedPrompt === 'string' || parsed.lastFailedPrompt === null
          ? parsed.lastFailedPrompt
          : fallback.lastFailedPrompt,
    }
  } catch {
    return fallback
  }
}

export const savePersistedState = (state: PersistedChatState): void => {
  resolveStorage().setItem(STORAGE_KEY, JSON.stringify(state))
}

export const loadUiState = (): LocalUiState => {
  const loaded = loadPersistedState()
  return {
    baseUrl: loaded.baseUrl,
    selectedModel: loaded.selectedModel,
    brainModel: loaded.brainModel,
    embedModel: loaded.embedModel,
    systemPrompt: loaded.systemPrompt,
    scenarioPrompt: loaded.scenarioPrompt,
    lastOptimizationMeta: loaded.lastOptimizationMeta,
    personaMode: loaded.personaMode,
    lastResponseId: loaded.lastResponseId,
    lastFailedPrompt: loaded.lastFailedPrompt,
  }
}

export const saveUiState = (state: LocalUiState): void => {
  resolveStorage().setItem(
    STORAGE_KEY,
    JSON.stringify({
      baseUrl: state.baseUrl,
      selectedModel: state.selectedModel,
      brainModel: state.brainModel,
      embedModel: state.embedModel,
      systemPrompt: state.systemPrompt,
      scenarioPrompt: state.scenarioPrompt,
      lastOptimizationMeta: state.lastOptimizationMeta,
      personaMode: state.personaMode,
      lastResponseId: state.lastResponseId,
      lastFailedPrompt: state.lastFailedPrompt,
      memoryVersion: MEMORY_VERSION,
      messages: [],
      memoryGraph: emptyMemoryGraph(),
    }),
  )
}

export const clearPersistedState = (): void => {
  resolveStorage().removeItem(STORAGE_KEY)
}
