import {
  addEpisode,
  getEpisodeCursor,
  incrementProfileTurnCounter,
  listEpisodes,
  setEpisodeCursor,
} from '../db/database'
import type { ChatMessage, EpisodeRecord, MemoryGraphState, ProfileExtractionResult } from '../types/chat'
import type { LmStudioClient } from './lmStudioClient'
import { extractFactsWithModel, mergeFactsWithConflicts } from './memoryGraph'
import {
  buildConversationTranscript,
  bulletsToExtractionResult,
  extractUserProfileBullets,
  summarizeConversationChunk,
} from './memoryIntelligence'
import { cosineSimilarityVectors, embedTextForMemory } from './semanticSearch'

export const WORKING_MEMORY_LIMIT = 10
export const EPISODE_CHUNK_SIZE = 5
export const PROFILE_CADENCE_TURNS = 5

export const createMemoryQueue = () => {
  let chain = Promise.resolve()
  return {
    enqueue: <T>(job: () => Promise<T>): Promise<T> => {
      const next = chain.then(job)
      chain = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    },
  }
}

export const enqueueEpisodeSummary = async (params: {
  sessionId: string
  messages: ChatMessage[]
  client: LmStudioClient
  model: string
}): Promise<{ episode?: EpisodeRecord; skipped: boolean; reason?: string; embeddingProvider?: string }> => {
  const { sessionId, messages, client, model } = params
  const cursor = await getEpisodeCursor(sessionId)
  const outsideWindowCount = messages.length - WORKING_MEMORY_LIMIT - cursor
  if (outsideWindowCount < EPISODE_CHUNK_SIZE) {
    return { skipped: true, reason: 'not-enough-messages' }
  }

  const startIndex = cursor
  const endIndex = cursor + EPISODE_CHUNK_SIZE - 1
  const chunk = messages.slice(startIndex, endIndex + 1)
  if (chunk.length === 0) {
    return { skipped: true, reason: 'empty-chunk' }
  }

  const summary = await summarizeConversationChunk(client, model, chunk)
  if (!summary.trim()) {
    await setEpisodeCursor(sessionId, endIndex + 1)
    return { skipped: true, reason: 'empty-summary' }
  }

  const embeddingInfo = await embedTextForMemory({
    text: summary,
    client,
    allowApiFallback: true,
  })

  const episode: EpisodeRecord = {
    sessionId,
    summary,
    embedding: embeddingInfo.vector,
    startIndex,
    endIndex,
    createdAt: new Date().toISOString(),
    sourceMessageIds: chunk.map((message) => message.id),
  }
  await addEpisode(episode)
  await setEpisodeCursor(sessionId, endIndex + 1)
  return { episode, skipped: false, embeddingProvider: embeddingInfo.provider }
}

export const findRelevantEpisodes = async (params: {
  sessionId: string
  prompt: string
  client: LmStudioClient
  topK?: number
}): Promise<{ episodes: EpisodeRecord[]; provider: string; error?: string }> => {
  const { sessionId, prompt, client, topK = 3 } = params
  const allEpisodes = await listEpisodes(sessionId)
  if (allEpisodes.length === 0 || !prompt.trim()) {
    return { episodes: [], provider: 'none' }
  }

  const promptEmbedding = await embedTextForMemory({
    text: prompt,
    client,
    allowApiFallback: true,
  })

  const ranked = allEpisodes
    .map((episode) => ({
      episode,
      score: cosineSimilarityVectors(promptEmbedding.vector, episode.embedding),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((item) => item.episode)

  return {
    episodes: ranked,
    provider: promptEmbedding.provider,
    error: promptEmbedding.error,
  }
}

export const runProfileExtractionCycle = async (params: {
  sessionId: string
  messages: ChatMessage[]
  graph: MemoryGraphState
  client: LmStudioClient
  model: string
}): Promise<{
  graph: MemoryGraphState
  ran: boolean
  result: ProfileExtractionResult
  factDelta: number
}> => {
  const { sessionId, messages, graph, client, model } = params
  const turn = await incrementProfileTurnCounter(sessionId)
  if (turn % PROFILE_CADENCE_TURNS !== 0) {
    return {
      graph,
      ran: false,
      factDelta: 0,
      result: {
        lines: [],
        parseMode: 'none',
        usedFallback: false,
        rawText: '',
      },
    }
  }

  const recent = messages.slice(-20)
  const profileResult = await extractUserProfileBullets(client, model, recent)
  let extraction = bulletsToExtractionResult(profileResult.lines)
  let parseMode: ProfileExtractionResult['parseMode'] = profileResult.parseMode
  let usedFallback = profileResult.usedFallback
  let error = profileResult.error
  let rawText = profileResult.rawText

  const trimmedRaw = profileResult.rawText.trim()
  const shouldTryJsonFallback =
    profileResult.lines.length === 0 &&
    trimmedRaw !== 'NO_NEW_INFO' &&
    (trimmedRaw.length === 0 || trimmedRaw.startsWith('{') || trimmedRaw.startsWith('```'))

  if (shouldTryJsonFallback) {
    const recentUsers = recent
      .filter((message) => message.role === 'user')
      .slice(-10)
      .map((message) => message.content)
      .join('\n')
    const fallback = await extractFactsWithModel(
      client,
      model,
      recentUsers || buildConversationTranscript(recent),
    )
    extraction = fallback.extraction
    parseMode = 'json-fallback'
    usedFallback = true
    rawText = `${profileResult.rawText}\n\n[fallback]\n${fallback.rawText}`
    error = fallback.error
  }

  if (extraction.facts.length === 0) {
    return {
      graph,
      ran: true,
      factDelta: 0,
      result: {
        lines: [],
        parseMode,
        usedFallback,
        rawText,
        error,
      },
    }
  }

  const merged = mergeFactsWithConflicts(graph, extraction, `profile:${Date.now()}`)
  return {
    graph: merged.graph,
    ran: true,
    factDelta: merged.graph.facts.length - graph.facts.length,
    result: {
      lines: extraction.facts.map((fact) => fact.canonicalText),
      parseMode,
      usedFallback,
      rawText,
      error,
    },
  }
}
