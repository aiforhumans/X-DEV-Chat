import type {
  ChatMessage,
  EpisodeRecord,
  ExtractionV2Result,
  MemoryFact,
  ProfileExtractionResult,
} from '../types/chat'
import type { LmStudioClient } from './lmStudioClient'
import { extractFactsWithModel } from './memoryGraph'

const DEFAULT_WORKING_WINDOW = 10
const DEFAULT_PROFILE_CONFIDENCE = 0.72
const MAX_TRANSCRIPT_CHARS_SUMMARY = 1200
const MAX_TRANSCRIPT_CHARS_PROFILE = 1500
const MAX_FACT_BULLETS = 5
const MAX_PROFILE_BULLETS = 4
const MAX_MESSAGE_SNIPPET = 180

const extractTextFromChatResponse = (payload: Record<string, unknown>): string => {
  if (typeof payload.output_text === 'string') return payload.output_text
  if (typeof payload.text === 'string') return payload.text

  const output = payload.output
  if (!Array.isArray(output)) return ''

  let combined = ''
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const maybeItem = item as Record<string, unknown>
    const content = maybeItem.content
    if (typeof content === 'string') {
      combined += content
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const maybePart = part as Record<string, unknown>
      if (typeof maybePart.text === 'string') {
        combined += maybePart.text
      }
    }
  }

  return combined.trim()
}

const shortRole = (role: ChatMessage['role']): string => {
  if (role === 'assistant') return 'Assistant'
  if (role === 'system') return 'System'
  if (role === 'error') return 'Error'
  return 'User'
}

const normalizeLine = (value: string): string => value.trim().replace(/\s+/g, ' ')

const clip = (value: string, max: number): string => {
  const clean = normalizeLine(value)
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 1)).trim()}…`
}

const trimTranscript = (value: string, maxChars: number): string => {
  const normalized = value.trim()
  if (normalized.length <= maxChars) return normalized
  return `…${normalized.slice(normalized.length - maxChars)}`
}

const inferCategory = (line: string): MemoryFact['category'] => {
  const normalized = line.toLowerCase()
  if (
    /\b(i like|i prefer|favorite|prefers|likes|enjoys|dislikes|hates|wants responses to|style)\b/.test(normalized)
  ) {
    return 'preference'
  }
  if (/\b(name|profession|job|work as|role is|from|live in|age|pronouns)\b/.test(normalized)) {
    return 'profile'
  }
  if (/\b(goal|trying to|plan to|wants to|aims to|needs to)\b/.test(normalized)) {
    return 'goal'
  }
  if (/\b(?:must|always|never|do not|don't|shouldn't|rule|constraint|require)\b/.test(normalized)) {
    return 'constraint'
  }
  return 'other'
}

export const buildConversationTranscript = (messages: ChatMessage[]): string =>
  messages
    .map((message) => `${shortRole(message.role)}: ${clip(message.content, MAX_MESSAGE_SNIPPET)}`)
    .join('\n')
    .trim()

const shouldExtractFromMessage = (text: string): boolean => {
  const normalized = normalizeLine(text).toLowerCase()
  if (normalized.length < 8) return false
  if (normalized.split(' ').length <= 1) return false

  const durablePattern =
    /\b(i like|i love|i hate|i prefer|my name is|i am|i'm|i work|i live|my goal|please always|please never|always|never|must|don't|do not)\b/
  return durablePattern.test(normalized) || normalized.length >= 24
}

export const buildWorkingMemoryInput = (
  messages: ChatMessage[],
  currentPrompt: string,
  limit = DEFAULT_WORKING_WINDOW,
): string => {
  const windowMessages = messages.slice(-limit)
  const transcript = buildConversationTranscript(windowMessages)
  if (!transcript) return currentPrompt
  return `Recent conversation:\n${transcript}\nUser: ${currentPrompt}`
}

export const summarizeConversationChunk = async (
  client: LmStudioClient,
  model: string,
  chunk: ChatMessage[],
): Promise<string> => {
  const transcript = buildConversationTranscript(chunk)
  if (!transcript) return ''
  const compactTranscript = trimTranscript(transcript, MAX_TRANSCRIPT_CHARS_SUMMARY)

  const response = await client.chat({
    model,
    input: [
      "You are an AI assistant's internal memory manager.",
      'Summarize the following conversation snippet in 2 to 3 concise sentences.',
      'Focus on main topics, decisions made, and conversational flow in chronological order.',
      'Keep it under 70 words. Do not use JSON, bullets, markdown, or explanations.',
      `Conversation snippet:\n${compactTranscript}`,
    ].join('\n'),
    stream: false,
    store: false,
  })

  return clip(extractTextFromChatResponse(response).replace(/^["'`]+|["'`]+$/g, '').trim(), 420)
}

export const extractUserProfileBullets = async (
  client: LmStudioClient,
  model: string,
  history: ChatMessage[],
): Promise<ProfileExtractionResult> => {
  const recent = history.slice(-12)
  const transcript = buildConversationTranscript(recent)
  if (!transcript) {
    return {
      lines: [],
      parseMode: 'none',
      usedFallback: false,
      rawText: '',
    }
  }
  const compactTranscript = trimTranscript(transcript, MAX_TRANSCRIPT_CHARS_PROFILE)

  const response = await client.chat({
    model,
    input: [
      'Analyze the following conversation.',
      'Identify only new, durable user facts (identity, preferences, goals, constraints).',
      `Return at most ${MAX_PROFILE_BULLETS} bullets. Each bullet must be short and start with '-'.`,
      "If there is nothing new, output exactly 'NO_NEW_INFO'.",
      'Do not include explanations or assistant facts.',
      `Conversation:\n${compactTranscript}`,
    ].join('\n'),
    stream: false,
    store: false,
  })

  const rawText = extractTextFromChatResponse(response)
  const normalizedRaw = rawText.trim()
  if (normalizedRaw === 'NO_NEW_INFO') {
    return {
      lines: [],
      parseMode: 'nl',
      usedFallback: false,
      rawText,
    }
  }

  const lines = normalizedRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => normalizeLine(line.replace(/^-+\s*/, '')))
    .filter(Boolean)
    .slice(0, MAX_PROFILE_BULLETS)

  return {
    lines,
    parseMode: 'nl',
    usedFallback: false,
    rawText,
  }
}

export const bulletsToExtractionResult = (
  lines: string[],
  confidence = DEFAULT_PROFILE_CONFIDENCE,
): ExtractionV2Result => ({
  facts: lines.map((line) => ({
    canonicalText: line,
    category: inferCategory(line),
    confidence,
    aliases: [line],
    contradictionWith: [],
    currentness: 0.75,
  })),
})

export const extractUserFactsNlFirst = async (params: {
  client: LmStudioClient
  model: string
  userText: string
  context?: { previousUserMessage?: string; previousAssistantMessage?: string }
}): Promise<ProfileExtractionResult & { extraction: ExtractionV2Result }> => {
  const { client, model, userText, context } = params
  if (!shouldExtractFromMessage(userText)) {
    return {
      lines: [],
      parseMode: 'none',
      usedFallback: false,
      rawText: '',
      extraction: { facts: [] },
    }
  }

  let rawText = ''
  try {
    const response = await client.chat({
      model,
      input: [
        'Analyze this latest user message and extract durable user facts.',
        `Return at most ${MAX_FACT_BULLETS} bullet points only, each starting with '-'.`,
        'Each bullet should be short, concrete, and about the user only.',
        "If there are no durable facts, output exactly 'NO_NEW_INFO'.",
        `Previous user message: ${context?.previousUserMessage?.trim() || '[none]'}`,
        `Previous assistant message: ${context?.previousAssistantMessage?.trim() || '[none]'}`,
        `Latest user message: ${clip(userText, 300)}`,
      ].join('\n'),
      stream: false,
      store: false,
    })
    rawText = extractTextFromChatResponse(response)
    const normalizedRaw = rawText.trim()
    if (normalizedRaw === 'NO_NEW_INFO') {
      return {
        lines: [],
        parseMode: 'nl',
        usedFallback: false,
        rawText,
        extraction: { facts: [] },
      }
    }

    const lines = normalizedRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => normalizeLine(line.replace(/^-+\s*/, '')))
      .filter(Boolean)
      .slice(0, MAX_FACT_BULLETS)

    if (lines.length > 0) {
      return {
        lines,
        parseMode: 'nl',
        usedFallback: false,
        rawText,
        extraction: bulletsToExtractionResult(lines),
      }
    }
  } catch {
    // fallback below
  }

  const fallback = await extractFactsWithModel(client, model, userText, context)
  return {
    lines: fallback.extraction.facts.map((fact) => fact.canonicalText),
    parseMode: 'json-fallback',
    usedFallback: true,
    rawText: fallback.rawText || rawText,
    error: fallback.error,
    extraction: fallback.extraction,
  }
}

export const buildEpisodicContextBlock = (episodes: EpisodeRecord[]): string => {
  if (episodes.length === 0) return ''
  const lines = episodes
    .slice(0, 4)
    .map((episode, index) => `- (${index + 1}) ${episode.summary}`)
  return `[Previous Conversation Context]\n${lines.join('\n')}`
}
