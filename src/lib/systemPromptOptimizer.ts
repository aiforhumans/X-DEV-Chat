import type { ChatTurnRequest, SystemPromptOptimizationResult } from '../types/chat'
import type { LmStudioClient } from './lmStudioClient'
import { extractTextFromChatResponse, parseJsonWithPath } from './llmResponseParsing'
import {
  buildOptimizerInstruction,
  buildOptimizerRepairInstruction,
  buildOptimizerRetryInstruction,
  getOptimizerSystemPrompt,
} from './optimizerConfig'

type ParseOutcome = {
  optimizedPrompt: string
  rationale: string
  warnings: string[]
  parsePath: 'direct' | 'fenced' | 'substring'
}

const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim()

const hasAny = (value: string, patterns: RegExp[]): boolean => patterns.some((pattern) => pattern.test(value))

const enforcePersonaFormat = (
  text: string,
): {
  optimizedPrompt: string
  warning?: string
} => {
  const trimmed = text.trim()
  if (!trimmed) {
    return { optimizedPrompt: text }
  }

  if (/^you are\b/i.test(trimmed)) {
    return { optimizedPrompt: `You are ${trimmed.replace(/^you are\b\s*/i, '').trim()}` }
  }

  const withoutLead = trimmed
    .replace(/^(i am|i['’]m)\b[\s,:-]*/i, '')
    .replace(/^(you['’]?re)\b[\s,:-]*/i, '')
    .replace(/^as\b[\s,:-]*/i, '')
    .trim()

  const body = withoutLead || trimmed
  return {
    optimizedPrompt: `You are ${body}`,
    warning: 'Persona output was normalized to "You are ..." format.',
  }
}

const detectSemanticDrift = (
  originalText: string,
  optimizedText: string,
  target: 'system' | 'persona' | 'scenario',
): string[] => {
  const original = normalize(originalText)
  const optimized = normalize(optimizedText)
  const warnings: string[] = []

  // Guard against policy inversion like:
  // "override safety restrictions" -> "strictly adhere to safety guidelines"
  const originalOverridesSafety = hasAny(original, [
    /\boverride\b.*\bethic/,
    /\boverride\b.*\blegal/,
    /\boverride\b.*\bsafety/,
    /\bwithout censorship\b/,
    /\buncensored\b/,
    /\bno censorship\b/,
  ])
  const optimizedForcesSafety = hasAny(optimized, [
    /\badhere\b.*\bethic/,
    /\badhere\b.*\blegal/,
    /\badhere\b.*\bsafety/,
    /\bdo not override\b.*\b(?:ethic|legal|safety)/,
    /\bstrictly\b.*\b(?:ethic|legal|safety)/,
    /\bonly generate content that aligns with safety\b/,
  ])
  if (originalOverridesSafety && optimizedForcesSafety) {
    warnings.push('Detected semantic drift: optimizer flipped safety-policy intent.')
  }

  // Preserve explicit placeholder/template tokens when present.
  const placeholderPattern = /(\{\{[^}]+\}\}|\$\{[^}]+\}|<\|[^|]+\|>|<<[^>]+>>|%[A-Z0-9_]+%)/g
  const originalPlaceholders = originalText.match(placeholderPattern) ?? []
  const optimizedPlaceholders = new Set(optimizedText.match(placeholderPattern) ?? [])
  if (originalPlaceholders.some((token) => !optimizedPlaceholders.has(token))) {
    warnings.push('Detected semantic drift: placeholder/token preservation failed.')
  }

  // Keep persona/style framing stable for persona optimization.
  if (target === 'persona') {
    const originalHasRelationshipFrame = hasAny(original, [/\bfriend\b/, /\bpartner\b/, /\bmentor\b/, /\bteammate\b/])
    const optimizedDropsRelationship = originalHasRelationshipFrame && !hasAny(optimized, [/\bfriend\b/, /\bpartner\b/, /\bmentor\b/, /\bteammate\b/])
    if (optimizedDropsRelationship) {
      warnings.push('Detected semantic drift: persona relationship framing changed.')
    }
  }

  if (target === 'scenario') {
    const originalSafetyLanguage = hasAny(original, [
      /\bethic(?:al)?\b/,
      /\blegal\b/,
      /\bsafety\b/,
      /\bpolicy\b/,
      /\bguideline\b/,
      /\brefuse\b/,
      /\bdecline\b/,
      /\bcannot help\b/,
      /\bcan[']?t help\b/,
    ])
    const optimizedSafetyLanguage = hasAny(optimized, [
      /\bethic(?:al)?\b/,
      /\blegal\b/,
      /\bsafety\b/,
      /\bpolicy\b/,
      /\bguideline\b/,
      /\brefuse\b/,
      /\bdecline\b/,
      /\bcannot help\b/,
      /\bcan[']?t help\b/,
      /\badhere\b.*\b(?:policy|guideline|safety|ethical|legal)/,
      /\bstrictly\b.*\b(?:policy|guideline|safety|ethical|legal)/,
    ])
    if (!originalSafetyLanguage && optimizedSafetyLanguage) {
      warnings.push('Detected semantic drift: scenario optimizer injected safety-policy language.')
    }

    const restrictionPattern = /\b(must|must not|never|always|do not|don't|only|without|override|uncensored|restriction(?:s)?)\b/g
    const originalRestrictionCount = (original.match(restrictionPattern) ?? []).length
    const optimizedRestrictionCount = (optimized.match(restrictionPattern) ?? []).length
    if (originalRestrictionCount >= 2 && optimizedRestrictionCount < Math.ceil(originalRestrictionCount * 0.5)) {
      warnings.push('Detected semantic drift: scenario restrictions were weakened or removed.')
    }
  }

  return warnings
}

const detectRationaleDrift = (
  originalText: string,
  rationaleText: string,
  target: 'system' | 'persona' | 'scenario',
): string[] => {
  const original = normalize(originalText)
  const rationale = normalize(rationaleText)
  const warnings: string[] = []

  if (!rationale) return warnings

  const originalHasSafetyLanguage = hasAny(original, [
    /\bethic(?:al)?\b/,
    /\blegal\b/,
    /\bsafety\b/,
    /\bpolicy\b/,
    /\bguideline\b/,
    /\bprofessional(?:ism)?\b/,
  ])

  const rationaleInjectsSafetyNarrative = hasAny(rationale, [
    /\bremoved\b.*\b(?:explicit|inappropriate|unsafe|offensive)\b/,
    /\brejects?\b.*\b(?:unsafe|offensive|explicit)\b/,
    /\bmaintain\b.*\bprofessional(?:ism)?\b/,
    /\bboundary awareness\b/,
    /\bunsafe\/offensive\b/,
  ])

  if (!originalHasSafetyLanguage && rationaleInjectsSafetyNarrative) {
    warnings.push('Detected semantic drift: optimizer rationale indicates policy/safety rewriting.')
  }

  if (target === 'scenario' && rationaleInjectsSafetyNarrative) {
    warnings.push('Detected semantic drift: scenario rationale introduced non-requested safety framing.')
  }

  return warnings
}

const enforceIntentSafety = (
  candidate: SystemPromptOptimizationResult,
  originalText: string,
  target: 'system' | 'persona' | 'scenario',
): SystemPromptOptimizationResult => {
  const candidateWarnings = candidate.warnings ?? []
  const personaNormalized =
    target === 'persona' ? enforcePersonaFormat(candidate.optimizedPrompt) : { optimizedPrompt: candidate.optimizedPrompt }
  const normalizedCandidate: SystemPromptOptimizationResult = {
    ...candidate,
    optimizedPrompt: personaNormalized.optimizedPrompt,
    warnings: personaNormalized.warning ? [...candidateWarnings, personaNormalized.warning] : candidateWarnings,
  }

  const driftWarnings = detectSemanticDrift(originalText, normalizedCandidate.optimizedPrompt, target)
  const rationaleWarnings = detectRationaleDrift(originalText, normalizedCandidate.rationale, target)
  const allWarnings = [...driftWarnings, ...rationaleWarnings]
  if (allWarnings.length === 0) return normalizedCandidate

  const originalTrimmed = originalText.trim()
  return {
    ...normalizedCandidate,
    optimizedPrompt: originalTrimmed || normalizedCandidate.optimizedPrompt,
    rationale: 'Kept the original text because optimizer output changed core intent.',
    warnings: [...(normalizedCandidate.warnings ?? []), ...allWarnings],
  }
}

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

export const parseOptimizationOutput = (raw: string): ParseOutcome | null => {
  const parsed = parseJsonWithPath(raw)
  if (!parsed || !parsed.value || typeof parsed.value !== 'object') return null

  const body = parsed.value as Record<string, unknown>
  const optimizedPrompt =
    typeof body.optimizedPrompt === 'string'
      ? body.optimizedPrompt.trim()
      : typeof body.optimized_prompt === 'string'
        ? body.optimized_prompt.trim()
        : ''
  const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : ''
  const warnings = toStringArray(body.warnings)

  if (!optimizedPrompt) return null

  return {
    optimizedPrompt,
    rationale: rationale || 'Improved clarity and constraint structure while preserving intent.',
    warnings,
    parsePath: parsed.parsePath,
  }
}

const bestEffortExtract = (raw: string, original: string): SystemPromptOptimizationResult | null => {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const fenced = trimmed.match(/```(?:\w+)?\s*([\s\S]*?)```/)?.[1]?.trim()
  const candidate = (fenced || trimmed).trim()
  if (!candidate) return null

  const lines = candidate
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const maybePrompt = lines.length > 1 ? lines.join('\n') : candidate

  if (maybePrompt.length < 8 || maybePrompt === original.trim()) return null

  return {
    optimizedPrompt: maybePrompt,
    rationale: 'Best-effort extraction used because strict JSON parsing failed.',
    warnings: ['Output was not strict JSON; verify before applying.'],
    rawOutput: raw,
    parsePath: 'best-effort',
  }
}

export const repairOptimizationOutput = async (
  client: LmStudioClient,
  model: string,
  rawOutput: string,
): Promise<string> => {
  const response = await client.chat({
    model,
    input: buildOptimizerRepairInstruction(rawOutput),
    system_prompt: 'You are a JSON repair engine. Return strict JSON only.',
    stream: false,
    store: false,
  } satisfies ChatTurnRequest)

  return extractTextFromChatResponse(response)
}

export const optimizeSystemPrompt = async (
  client: LmStudioClient,
  model: string,
  systemPrompt: string,
): Promise<SystemPromptOptimizationResult> => {
  return optimizeWithInstruction(
    client,
    model,
    systemPrompt,
    'system',
  )
}

export const optimizeCustomPersona = async (
  client: LmStudioClient,
  model: string,
  personaText: string,
): Promise<SystemPromptOptimizationResult> => {
  return optimizeWithInstruction(
    client,
    model,
    personaText,
    'persona',
  )
}

export const optimizeScenarioPrompt = async (
  client: LmStudioClient,
  model: string,
  scenarioText: string,
): Promise<SystemPromptOptimizationResult> => {
  return optimizeWithInstruction(
    client,
    model,
    scenarioText,
    'scenario',
  )
}

const optimizeWithInstruction = async (
  client: LmStudioClient,
  model: string,
  originalText: string,
  target: 'system' | 'persona' | 'scenario',
): Promise<SystemPromptOptimizationResult> => {
  const response = await client.chat({
    model,
    input: buildOptimizerInstruction(target, originalText),
    system_prompt: getOptimizerSystemPrompt(target),
    stream: false,
    store: false,
  } satisfies ChatTurnRequest)

  const rawOutput = extractTextFromChatResponse(response)
  let bestEffortSource = rawOutput
  const parsed = parseOptimizationOutput(rawOutput)
  if (parsed) {
    return enforceIntentSafety(
      {
        ...parsed,
        rawOutput,
      },
      originalText,
      target,
    )
  }

  try {
    const repaired = await repairOptimizationOutput(client, model, rawOutput)
    const repairedParsed = parseOptimizationOutput(repaired)
    if (repairedParsed) {
      return enforceIntentSafety(
        {
        ...repairedParsed,
        rawOutput: `${rawOutput}\n\n[repaired]\n${repaired}`,
        parsePath: 'retry-repair',
        },
        originalText,
        target,
      )
    }
  } catch {
    // continue to best effort
  }

  // Retry generation once with a stricter non-empty requirement.
  try {
    const retryResponse = await client.chat({
      model,
      input: buildOptimizerRetryInstruction(target, originalText),
      system_prompt: getOptimizerSystemPrompt(target),
      stream: false,
      store: false,
    } satisfies ChatTurnRequest)
    const retryRaw = extractTextFromChatResponse(retryResponse)
    bestEffortSource = `${bestEffortSource}\n\n[retry]\n${retryRaw}`
    const retryParsed = parseOptimizationOutput(retryRaw)
    if (retryParsed) {
      return enforceIntentSafety(
        {
        ...retryParsed,
        rawOutput: `${rawOutput}\n\n[retry]\n${retryRaw}`,
        parsePath: 'retry-repair',
        },
        originalText,
        target,
      )
    }
  } catch {
    // continue to best effort
  }

  const fallback = bestEffortExtract(bestEffortSource, originalText)
  if (fallback) return enforceIntentSafety(fallback, originalText, target)

  throw new Error('Optimizer output could not be parsed')
}
