import type {
  ExtractionV2Candidate,
  ExtractionV2Result,
  LegacyMemoryItem,
  MemoryConflict,
  MemoryFact,
  MemoryFactStatus,
  MemoryGraphState,
  MemoryRecallContext,
  MemorySourceType,
  RerankResult,
} from '../types/chat'
import type { LmStudioClient } from './lmStudioClient'

export const MEMORY_VERSION = 2
export const MAX_FACTS = 300
export const MAX_EVIDENCE_PER_FACT = 10
export const SHORTLIST_LIMIT = 20
export const RECALL_LIMIT = 8
const MIN_CONFIDENCE = 0.45
const COLOR_WORDS = ['red', 'blue', 'green', 'black', 'white', 'yellow', 'orange', 'purple', 'pink', 'brown', 'silver', 'gold']

interface ExtractionContext {
  previousUserMessage?: string
  previousAssistantMessage?: string
}

const uid = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

export const emptyMemoryGraph = (): MemoryGraphState => ({
  facts: [],
  evidence: [],
  aliases: [],
  conflicts: [],
  vectorIndex: [],
})

const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tokenize = (value: string): string[] => normalize(value).split(' ').filter((token) => token.length > 2)

const jaccard = (a: string, b: string): number => {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (ta.size === 0 || tb.size === 0) return 0

  let intersection = 0
  for (const token of ta) {
    if (tb.has(token)) intersection += 1
  }

  const union = new Set([...ta, ...tb]).size
  return union === 0 ? 0 : intersection / union
}

const confidence = (value: number): number => {
  if (Number.isNaN(value)) return MIN_CONFIDENCE
  return Math.max(0, Math.min(1, value))
}

const dedupeSourceTags = (tags: MemorySourceType[]): MemorySourceType[] => {
  const hasChat = tags.includes('chat')
  const hasFile = tags.includes('file')
  return [hasChat ? 'chat' : null, hasFile ? 'file' : null].filter(
    (value): value is MemorySourceType => Boolean(value),
  )
}

const mergeSourceTags = (
  existing: MemorySourceType[] | undefined,
  incoming: MemorySourceType,
): MemorySourceType[] => dedupeSourceTags([...(existing ?? ['chat']), incoming])

const asCategory = (value: unknown): MemoryFact['category'] => {
  const normalized = typeof value === 'string' ? value.toLowerCase().trim() : 'other'
  if (normalized === 'preference') return 'preference'
  if (normalized === 'profile') return 'profile'
  if (normalized === 'goal') return 'goal'
  if (normalized === 'constraint') return 'constraint'
  return 'other'
}

const asStatus = (value: number): MemoryFactStatus => {
  if (value < 0.55) return 'uncertain'
  return 'active'
}

const recencyWeight = (dateValue: string): number => {
  const ts = new Date(dateValue).getTime()
  if (Number.isNaN(ts)) return 0
  const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24))
  return 1 / (1 + ageDays / 14)
}

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

const parseJsonLoose = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
    if (fenced) {
      try {
        return JSON.parse(fenced)
      } catch {
        // continue
      }
    }

    const firstBrace = raw.indexOf('{')
    const lastBrace = raw.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(raw.slice(firstBrace, lastBrace + 1))
      } catch {
        // continue
      }
    }

    return null
  }
}

const repairStructuredOutput = async (
  client: LmStudioClient,
  model: string,
  mode: 'extraction' | 'rerank',
  rawOutput: string,
): Promise<string> => {
  const schema =
    mode === 'extraction'
      ? '{"facts":[{"canonicalText":"...","category":"preference|profile|goal|constraint|other","confidence":0.0,"aliases":["..."],"contradictionWith":["..."],"currentness":0.0}]}'
      : '{"selectedFactIds":["..."],"scores":[{"factId":"...","score":0.0,"rationale":"..."}]}'

  const response = await client.chat({
    model,
    input: [
      'Convert the following output into strict valid JSON only.',
      `Target schema: ${schema}`,
      'Do not add markdown, prose, comments, or explanations.',
      `Raw output:\\n${rawOutput || '[empty]'}`,
    ].join('\n'),
    system_prompt: 'You are a JSON repair engine. Return valid JSON only.',
    stream: false,
    store: false,
  })

  return extractTextFromChatResponse(response)
}

const parseExtractionV2 = (raw: string): ExtractionV2Result => {
  const parsed = parseJsonLoose(raw) as { facts?: Array<Record<string, unknown>> } | null
  if (!parsed || !Array.isArray(parsed.facts)) return { facts: [] }

  const facts = parsed.facts
    .map((fact): ExtractionV2Candidate => ({
      canonicalText: typeof fact.canonicalText === 'string' ? fact.canonicalText.trim() : '',
      category: asCategory(fact.category),
      confidence: confidence(Number(fact.confidence)),
      aliases: Array.isArray(fact.aliases)
        ? fact.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
        : [],
      contradictionWith: Array.isArray(fact.contradictionWith)
        ? fact.contradictionWith.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [],
      currentness: confidence(Number(fact.currentness ?? 0.5)),
    }))
    .filter((fact) => fact.canonicalText.length > 0 && fact.confidence >= MIN_CONFIDENCE)
    .slice(0, 8)

  return { facts }
}

const parseRerank = (raw: string): RerankResult | null => {
  const parsed = parseJsonLoose(raw) as {
    selectedFactIds?: string[]
    scores?: Array<{ factId?: string; score?: number; rationale?: string }>
  } | null

  if (!parsed) return null
  const selectedFactIds = Array.isArray(parsed.selectedFactIds)
    ? parsed.selectedFactIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []

  const scores = Array.isArray(parsed.scores)
    ? parsed.scores
        .map((item) => ({
          factId: typeof item.factId === 'string' ? item.factId : '',
          score: confidence(Number(item.score ?? 0)),
          rationale: typeof item.rationale === 'string' ? item.rationale : undefined,
        }))
        .filter((item) => item.factId)
    : []

  if (selectedFactIds.length === 0 && scores.length === 0) return null
  return { selectedFactIds, scores }
}

const normalizePreferencePhrase = (value: string): string =>
  value
    .trim()
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/\s+/g, ' ')

const isAmbiguousPreferencePhrase = (value: string): boolean => {
  const normalized = normalize(value)
  return [
    'it',
    'that',
    'this',
    'the color',
    'color',
    'that color',
    'this color',
    'the one',
    'that one',
    'this one',
  ].includes(normalized)
}

const pluralizeSimple = (word: string): string => {
  if (word.endsWith('s')) return word
  if (word.endsWith('y') && word.length > 1 && !/[aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

const findColorObjectReference = (text: string): { color: string; object: string } | null => {
  if (!text.trim()) return null
  const pattern = new RegExp(`\\b(${COLOR_WORDS.join('|')})\\s+([a-z][a-z0-9-]{1,32})\\b`, 'i')
  const match = text.match(pattern)
  if (!match) return null
  const color = match[1].toLowerCase()
  const object = match[2].toLowerCase()
  if (object === 'color' || object === 'one') return null
  return { color, object }
}

const resolveCandidateWithContext = (
  candidate: ExtractionV2Candidate,
  userText: string,
  context?: ExtractionContext,
): ExtractionV2Candidate => {
  if (candidate.category !== 'preference') return candidate

  const rawPreference = normalizePreferencePhrase(candidate.canonicalText)
  const seemsAmbiguous =
    isAmbiguousPreferencePhrase(rawPreference) ||
    /\bi (?:really )?like\s+(?:the\s+)?color\b/i.test(userText)

  if (!seemsAmbiguous) return candidate

  const reference =
    findColorObjectReference(context?.previousUserMessage ?? '') ??
    findColorObjectReference(context?.previousAssistantMessage ?? '')
  if (!reference) return candidate

  const resolvedText = `${reference.color} ${pluralizeSimple(reference.object)}`
  if (!resolvedText.trim()) return candidate

  const mergedAliases = Array.from(
    new Set([...(candidate.aliases ?? []), rawPreference].map((alias) => alias.trim()).filter(Boolean)),
  )

  return {
    ...candidate,
    canonicalText: resolvedText,
    aliases: mergedAliases,
  }
}

const normalizeExtractionWithContext = (
  extraction: ExtractionV2Result,
  userText: string,
  context?: ExtractionContext,
): ExtractionV2Result => {
  const resolvedFacts = extraction.facts
    .map((candidate) => resolveCandidateWithContext(candidate, userText, context))
    .filter((candidate) => candidate.canonicalText.trim().length > 0)

  const unique = new Map<string, ExtractionV2Candidate>()
  for (const candidate of resolvedFacts) {
    const key = `${candidate.category}:${normalize(candidate.canonicalText)}`
    if (!unique.has(key)) {
      unique.set(key, candidate)
    }
  }

  return {
    facts: [...unique.values()].slice(0, 8),
  }
}

const fallbackExtract = (userText: string, context?: ExtractionContext): ExtractionV2Result => {
  const text = userText.trim()
  if (!text) return { facts: [] }

  const patterns: Array<{ regex: RegExp; category: MemoryFact['category']; confidence: number }> = [
    { regex: /\bmy name is\s+([a-z][a-z\s'-]{1,40})/i, category: 'profile', confidence: 0.9 },
    { regex: /\bi live in\s+([a-z][a-z\s,'-]{1,40})/i, category: 'profile', confidence: 0.8 },
    { regex: /\bi prefer\s+([a-z0-9][a-z0-9\s,'-]{1,80})/i, category: 'preference', confidence: 0.85 },
    { regex: /\bi (?:do not|don't) like\s+([a-z0-9][a-z0-9\s,'-]{1,80})/i, category: 'preference', confidence: 0.83 },
    { regex: /\bi (?:really )?like\s+([a-z0-9][a-z0-9\s,'-]{1,80})/i, category: 'preference', confidence: 0.8 },
    { regex: /\bmy goal is to\s+([a-z0-9][a-z0-9\s,'-]{3,120})/i, category: 'goal', confidence: 0.9 },
    { regex: /\bplease (?:always|only)\s+([a-z0-9][a-z0-9\s,'-]{3,120})/i, category: 'constraint', confidence: 0.78 },
  ]

  const facts: ExtractionV2Candidate[] = []
  for (const pattern of patterns) {
    const match = text.match(pattern.regex)
    if (!match) continue
    const value = match.slice(1).join(' ').trim()
    if (!value) continue
    facts.push({
      canonicalText: value,
      category: pattern.category,
      confidence: pattern.confidence,
      aliases: [value],
      currentness: 0.6,
    })
  }

  const unique = new Map<string, ExtractionV2Candidate>()
  for (const fact of facts) {
    const key = `${fact.category}:${normalize(fact.canonicalText)}`
    if (!unique.has(key)) unique.set(key, fact)
  }

  return normalizeExtractionWithContext({ facts: [...unique.values()].slice(0, 5) }, userText, context)
}

const extractionPrompt = (userText: string, context?: ExtractionContext): string =>
  [
    'Extract durable user facts from this message.',
    'Return strict JSON only with this exact shape:',
    '{"facts":[{"canonicalText":"...","category":"preference|profile|goal|constraint|other","confidence":0.0,"aliases":["..."],"contradictionWith":["..."],"currentness":0.0}]}',
    'Rules: max 8 facts, no ephemeral details, confidence 0-1, contradictionWith contains canonical fact text that conflicts if known.',
    'If the user message uses references like "it", "that", "the color", resolve them using the previous USER message when possible.',
    'Prefer concrete canonicalText over vague placeholders.',
    `Previous user message: ${context?.previousUserMessage?.trim() || '[none]'}`,
    `Previous assistant message: ${context?.previousAssistantMessage?.trim() || '[none]'}`,
    `User message: ${userText}`,
  ].join('\n')

const rerankPrompt = (userPrompt: string, shortlist: MemoryFact[]): string =>
  [
    'Given the user prompt and candidate memory facts, select the most relevant facts for response quality.',
    'Return strict JSON with:',
    '{"selectedFactIds":["..."],"scores":[{"factId":"...","score":0.0,"rationale":"..."}]}',
    `User prompt: ${userPrompt}`,
    `Candidates:\n${shortlist.map((fact) => `- ${fact.id} | ${fact.category} | ${fact.canonicalText}`).join('\n')}`,
    `Select at most ${RECALL_LIMIT} facts.`,
  ].join('\n')

export const migrateMemoryV1ToV2 = (legacy?: LegacyMemoryItem[]): MemoryGraphState => {
  if (!legacy || legacy.length === 0) return emptyMemoryGraph()

  const facts: MemoryFact[] = []
  const evidence = [] as MemoryGraphState['evidence']
  const aliases = [] as MemoryGraphState['aliases']

  for (const item of legacy) {
    const factId = item.id || uid()
    facts.push({
      id: factId,
      canonicalText: item.text,
      category: asCategory(item.category),
      status: asStatus(item.confidence),
      confidence: confidence(item.confidence),
      sourceTags: ['chat'],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })

    evidence.push({
      id: uid(),
      factId,
      sourceMessageId: item.sourceMessageId,
      verbatim: item.text,
      extractedAt: item.updatedAt,
      confidence: confidence(item.confidence),
      sourceType: 'chat',
    })

    aliases.push({ factId, aliasText: item.text })
  }

  return {
    facts: facts.slice(0, MAX_FACTS),
    evidence,
    aliases,
    conflicts: [],
    vectorIndex: [],
  }
}

export const attachEvidence = (
  graph: MemoryGraphState,
  factId: string,
  sourceMessageId: string,
  verbatim: string,
  evidenceConfidence: number,
  sourceType: MemorySourceType = 'chat',
  sourceRef?: { fileId?: string; fileName?: string },
): MemoryGraphState => {
  const nextEvidence = [
    ...graph.evidence,
    {
      id: uid(),
      factId,
      sourceMessageId,
      verbatim,
      extractedAt: new Date().toISOString(),
      confidence: confidence(evidenceConfidence),
      sourceType,
      sourceRef,
    },
  ]

  const grouped = nextEvidence.filter((entry) => entry.factId === factId)
  if (grouped.length > MAX_EVIDENCE_PER_FACT) {
    const keepIds = grouped
      .sort((a, b) => new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime())
      .slice(0, MAX_EVIDENCE_PER_FACT)
      .map((entry) => entry.id)

    return {
      ...graph,
      evidence: nextEvidence.filter((entry) => entry.factId !== factId || keepIds.includes(entry.id)),
    }
  }

  return {
    ...graph,
    evidence: nextEvidence,
  }
}

const findFactMatch = (graph: MemoryGraphState, candidate: ExtractionV2Candidate): MemoryFact | null => {
  const candidateNorm = normalize(candidate.canonicalText)
  if (!candidateNorm) return null

  const aliasFactIds = graph.aliases
    .filter((alias) => normalize(alias.aliasText) === candidateNorm)
    .map((alias) => alias.factId)

  const byAlias = graph.facts.find((fact) => aliasFactIds.includes(fact.id) && fact.category === candidate.category)
  if (byAlias) return byAlias

  return (
    graph.facts.find((fact) => {
      if (fact.category !== candidate.category) return false
      const overlap = jaccard(fact.canonicalText, candidate.canonicalText)
      const factNorm = normalize(fact.canonicalText)
      return (
        overlap >= 0.55 ||
        factNorm === candidateNorm ||
        factNorm.includes(candidateNorm) ||
        candidateNorm.includes(factNorm)
      )
    }) ?? null
  )
}

const conflictKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`)

const ensureConflict = (
  graph: MemoryGraphState,
  factAId: string,
  factBId: string,
  winnerFactId: string,
  reason: string,
): MemoryGraphState => {
  const key = conflictKey(factAId, factBId)
  const existing = graph.conflicts.find((conflict) => conflictKey(conflict.factAId, conflict.factBId) === key)
  const now = new Date().toISOString()

  const conflict: MemoryConflict = existing
    ? { ...existing, winnerFactId, reason, updatedAt: now }
    : {
        id: uid(),
        factAId,
        factBId,
        winnerFactId,
        reason,
        createdAt: now,
        updatedAt: now,
      }

  const conflicts = existing
    ? graph.conflicts.map((item) => (item.id === existing.id ? conflict : item))
    : [...graph.conflicts, conflict]

  return {
    ...graph,
    conflicts,
    facts: graph.facts.map((fact) => {
      if (fact.id === winnerFactId) return { ...fact, status: 'active', updatedAt: now }
      if (fact.id === factAId || fact.id === factBId) return { ...fact, status: 'superseded', updatedAt: now }
      return fact
    }),
  }
}

const contradictorySignals = (a: string, b: string): boolean => {
  const na = normalize(a)
  const nb = normalize(b)
  const negA = /\b(no|not|never|dont|don't)\b/.test(na)
  const negB = /\b(no|not|never|dont|don't)\b/.test(nb)
  if (negA === negB) return false

  const overlap = jaccard(na, nb)
  return overlap >= 0.3
}

const chooseWinner = (
  existing: MemoryFact,
  incoming: ExtractionV2Candidate,
  incomingCurrentness: number,
): 'existing' | 'incoming' => {
  const existingScore = existing.confidence * 0.6 + recencyWeight(existing.updatedAt) * 0.25 + 0.5 * 0.15
  const incomingScore = incoming.confidence * 0.6 + 1 * 0.25 + incomingCurrentness * 0.15
  return incomingScore >= existingScore ? 'incoming' : 'existing'
}

const addAlias = (graph: MemoryGraphState, factId: string, aliasText: string): MemoryGraphState => {
  if (!aliasText.trim()) return graph
  const aliasNorm = normalize(aliasText)
  if (!aliasNorm) return graph

  if (graph.aliases.some((alias) => alias.factId === factId && normalize(alias.aliasText) === aliasNorm)) {
    return graph
  }

  return {
    ...graph,
    aliases: [...graph.aliases, { factId, aliasText: aliasText.trim() }],
  }
}

const pruneGraph = (graph: MemoryGraphState): MemoryGraphState => {
  if (graph.facts.length <= MAX_FACTS) return graph

  const keepFacts = [...graph.facts]
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
    .slice(0, MAX_FACTS)

  const keepIds = new Set(keepFacts.map((fact) => fact.id))
  return {
    facts: keepFacts,
    evidence: graph.evidence.filter((item) => keepIds.has(item.factId)),
    aliases: graph.aliases.filter((item) => keepIds.has(item.factId)),
    conflicts: graph.conflicts.filter(
      (item) => keepIds.has(item.factAId) && keepIds.has(item.factBId) && keepIds.has(item.winnerFactId),
    ),
    vectorIndex: (graph.vectorIndex ?? []).filter((entry) => keepIds.has(entry.factId)),
  }
}

export const mergeFactsWithConflicts = (
  graph: MemoryGraphState,
  extracted: ExtractionV2Result,
  sourceMessageId: string,
  provenance?: {
    sourceType?: MemorySourceType
    sourceRef?: { fileId?: string; fileName?: string }
  },
): { graph: MemoryGraphState; conflictDetected: boolean } => {
  const sourceType = provenance?.sourceType ?? 'chat'
  const sourceRef = provenance?.sourceRef
  let next = { ...graph }
  let conflictDetected = false

  for (const candidate of extracted.facts) {
    const now = new Date().toISOString()
    const currentness = confidence(Number(candidate.currentness ?? 0.5))
    const matched = findFactMatch(next, candidate)

    if (matched) {
      const updatedFact: MemoryFact = {
        ...matched,
        canonicalText: candidate.canonicalText,
        category: candidate.category,
        confidence: Math.max(matched.confidence, candidate.confidence),
        status: asStatus(Math.max(matched.confidence, candidate.confidence)),
        sourceTags: mergeSourceTags(matched.sourceTags, sourceType),
        updatedAt: now,
      }

      next = {
        ...next,
        facts: next.facts.map((fact) => (fact.id === matched.id ? updatedFact : fact)),
      }

      next = addAlias(next, matched.id, candidate.canonicalText)
      for (const alias of candidate.aliases ?? []) {
        next = addAlias(next, matched.id, alias)
      }

      next = attachEvidence(
        next,
        matched.id,
        sourceMessageId,
        candidate.canonicalText,
        candidate.confidence,
        sourceType,
        sourceRef,
      )
      continue
    }

    const newFact: MemoryFact = {
      id: uid(),
      canonicalText: candidate.canonicalText,
      category: candidate.category,
      status: asStatus(candidate.confidence),
      confidence: candidate.confidence,
      sourceTags: [sourceType],
      createdAt: now,
      updatedAt: now,
    }

    next = {
      ...next,
      facts: [...next.facts, newFact],
    }
    next = addAlias(next, newFact.id, candidate.canonicalText)
    for (const alias of candidate.aliases ?? []) {
      next = addAlias(next, newFact.id, alias)
    }
    next = attachEvidence(
      next,
      newFact.id,
      sourceMessageId,
      candidate.canonicalText,
      candidate.confidence,
      sourceType,
      sourceRef,
    )

    const explicitConflicts = (candidate.contradictionWith ?? []).map((value) => normalize(value)).filter(Boolean)

    for (const fact of next.facts) {
      if (fact.id === newFact.id) continue
      if (fact.category !== newFact.category) continue

      const explicit = explicitConflicts.includes(normalize(fact.canonicalText))
      const heuristic = contradictorySignals(fact.canonicalText, newFact.canonicalText)
      if (!explicit && !heuristic) continue

      conflictDetected = true
      const winner = chooseWinner(fact, candidate, currentness)
      next = ensureConflict(
        next,
        fact.id,
        newFact.id,
        winner === 'incoming' ? newFact.id : fact.id,
        explicit ? 'model-specified-contradiction' : 'heuristic-contradiction',
      )
    }
  }

  return { graph: pruneGraph(next), conflictDetected }
}

export const prefilterFacts = (
  graph: MemoryGraphState,
  prompt: string,
  limit = SHORTLIST_LIMIT,
): Array<{ fact: MemoryFact; score: number }> => {
  return graph.facts
    .filter((fact) => fact.status !== 'superseded')
    .map((fact) => {
      const lexical = jaccard(fact.canonicalText, prompt)
      const recency = recencyWeight(fact.updatedAt)
      const statusWeight = fact.status === 'active' ? 1 : 0.8
      const score = lexical * 0.65 + fact.confidence * 0.22 + recency * 0.13
      return { fact, score: score * statusWeight }
    })
    .filter((item) => item.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export const mergeHybridCandidates = (
  semantic: Array<{ fact: MemoryFact; score: number }>,
  lexical: Array<{ fact: MemoryFact; score: number }>,
  limit = SHORTLIST_LIMIT,
): Array<{ fact: MemoryFact; score: number }> => {
  const scoreById = new Map<string, { fact: MemoryFact; score: number }>()
  for (const item of semantic) {
    scoreById.set(item.fact.id, {
      fact: item.fact,
      score: item.score * 0.72,
    })
  }

  for (const item of lexical) {
    const existing = scoreById.get(item.fact.id)
    if (!existing) {
      scoreById.set(item.fact.id, { fact: item.fact, score: item.score * 0.28 })
      continue
    }
    scoreById.set(item.fact.id, {
      fact: item.fact,
      score: existing.score + item.score * 0.28,
    })
  }

  return [...scoreById.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export const rerankFactsWithModel = async (
  client: LmStudioClient,
  model: string,
  prompt: string,
  shortlist: MemoryFact[],
): Promise<{ result: RerankResult | null; rawText: string; error?: string }> => {
  if (shortlist.length === 0) return { result: { selectedFactIds: [], scores: [] }, rawText: '' }

  try {
    const response = await client.chat({
      model,
      input: rerankPrompt(prompt, shortlist),
      system_prompt: 'You are a retrieval ranker. Return strict JSON only with no markdown.',
      stream: false,
      store: false,
    })

    const text = extractTextFromChatResponse(response)
    const parsed = parseRerank(text)
    if (parsed) {
      return { result: parsed, rawText: text }
    }

    // Advanced pass: ask the loaded model to repair malformed/verbose output into strict JSON.
    try {
      const repaired = await repairStructuredOutput(client, model, 'rerank', text)
      return { result: parseRerank(repaired), rawText: `${text}\n\n[repaired]\n${repaired}` }
    } catch {
      return { result: null, rawText: text, error: 'rerank parse failed' }
    }
  } catch (error) {
    return {
      result: null,
      rawText: '',
      error: error instanceof Error ? error.message : 'rerank request failed',
    }
  }
}

export const buildMemoryContext = (facts: MemoryFact[]): MemoryRecallContext => {
  if (facts.length === 0) {
    return { selectedFacts: [], contextBlock: '' }
  }

  const lines = facts.map((fact) => {
    const uncertaintySuffix = fact.status === 'uncertain' ? ' (uncertain)' : ''
    return `- ${fact.category}: ${fact.canonicalText}${uncertaintySuffix}`
  })

  return {
    selectedFacts: facts,
    contextBlock: `Memory Context:\n${lines.join('\n')}`,
  }
}

export const resolveConflict = (
  graph: MemoryGraphState,
  conflictId: string,
  winnerFactId: string,
): MemoryGraphState => {
  const conflict = graph.conflicts.find((item) => item.id === conflictId)
  if (!conflict) return graph

  const now = new Date().toISOString()
  const updatedConflict: MemoryConflict = {
    ...conflict,
    winnerFactId,
    updatedAt: now,
    resolvedManually: true,
  }

  return {
    ...graph,
    conflicts: graph.conflicts.map((item) => (item.id === conflictId ? updatedConflict : item)),
    facts: graph.facts.map((fact) => {
      if (fact.id === winnerFactId) return { ...fact, status: 'active', updatedAt: now }
      if (fact.id === conflict.factAId || fact.id === conflict.factBId) return { ...fact, status: 'superseded', updatedAt: now }
      return fact
    }),
  }
}

export const deleteFact = (graph: MemoryGraphState, factId: string): MemoryGraphState => {
  const keepIds = new Set(graph.facts.filter((fact) => fact.id !== factId).map((fact) => fact.id))

  const next = {
    facts: graph.facts.filter((fact) => fact.id !== factId),
    evidence: graph.evidence.filter((item) => item.factId !== factId),
    aliases: graph.aliases.filter((item) => item.factId !== factId),
    conflicts: graph.conflicts.filter(
      (item) => item.factAId !== factId && item.factBId !== factId && item.winnerFactId !== factId,
    ),
    vectorIndex: (graph.vectorIndex ?? []).filter((entry) => entry.factId !== factId),
  }

  const orphanSuperseded = next.facts.filter(
    (fact) => fact.status === 'superseded' && !next.conflicts.some((item) => item.factAId === fact.id || item.factBId === fact.id),
  )

  let normalizedFacts = next.facts
  if (orphanSuperseded.length > 0) {
    normalizedFacts = next.facts.map((fact) =>
      orphanSuperseded.some((item) => item.id === fact.id) ? { ...fact, status: 'uncertain' } : fact,
    )
  }

  return {
    facts: normalizedFacts.filter((fact) => keepIds.has(fact.id)),
    evidence: next.evidence,
    aliases: next.aliases,
    conflicts: next.conflicts,
    vectorIndex: next.vectorIndex,
  }
}

export const clearFileFacts = (graph: MemoryGraphState): MemoryGraphState => {
  const remainingEvidence = graph.evidence.filter((item) => item.sourceType !== 'file')
  const evidenceByFactId = new Map<string, typeof remainingEvidence>()
  for (const evidence of remainingEvidence) {
    const list = evidenceByFactId.get(evidence.factId) ?? []
    list.push(evidence)
    evidenceByFactId.set(evidence.factId, list)
  }

  const keptFacts = graph.facts.filter((fact) => {
    const sourceTags = dedupeSourceTags(fact.sourceTags ?? ['chat'])
    if (sourceTags.includes('chat')) return true
    return evidenceByFactId.has(fact.id)
  })

  const keepIds = new Set(keptFacts.map((fact) => fact.id))
  const normalizedFacts = keptFacts.map((fact) => {
    const sourceTags = dedupeSourceTags(
      (fact.sourceTags ?? ['chat']).filter((tag): tag is MemorySourceType => tag === 'chat' || tag === 'file'),
    ).filter((tag): tag is MemorySourceType => tag === 'chat')
    return {
      ...fact,
      sourceTags: sourceTags.length > 0 ? sourceTags : (['chat'] as MemorySourceType[]),
    }
  })

  return {
    facts: normalizedFacts,
    evidence: remainingEvidence.filter((item) => keepIds.has(item.factId)),
    aliases: graph.aliases.filter((item) => keepIds.has(item.factId)),
    conflicts: graph.conflicts.filter(
      (item) => keepIds.has(item.factAId) && keepIds.has(item.factBId) && keepIds.has(item.winnerFactId),
    ),
    vectorIndex: (graph.vectorIndex ?? []).filter((entry) => keepIds.has(entry.factId)),
  }
}

const dotVectors = (a: number[], b: number[]): number => {
  const len = Math.min(a.length, b.length)
  let sum = 0
  for (let index = 0; index < len; index += 1) {
    sum += a[index] * b[index]
  }
  return sum
}

const cosineSimilarityVectors = (a: number[], b: number[]): number => {
  const magA = Math.sqrt(dotVectors(a, a))
  const magB = Math.sqrt(dotVectors(b, b))
  const denom = magA * magB
  if (!denom) return 0
  return dotVectors(a, b) / denom
}

const chooseCanonicalForMerge = (a: string, b: string): string => {
  const normA = normalize(a)
  const normB = normalize(b)
  if (normA.includes(normB)) return a
  if (normB.includes(normA)) return b
  return a.length >= b.length ? a : b
}

const mergeFactPair = (graph: MemoryGraphState, winnerId: string, loserId: string): MemoryGraphState => {
  const winner = graph.facts.find((fact) => fact.id === winnerId)
  const loser = graph.facts.find((fact) => fact.id === loserId)
  if (!winner || !loser) return graph

  const now = new Date().toISOString()
  const canonicalText = chooseCanonicalForMerge(winner.canonicalText, loser.canonicalText)
  const winnerUpdatedAt = now

  const nextFacts = graph.facts
    .filter((fact) => fact.id !== loserId)
    .map((fact) => {
      if (fact.id !== winnerId) return fact
      const mergedStatus: MemoryFactStatus =
        fact.status === 'active' || loser.status === 'active' ? 'active' : 'uncertain'
      return {
        ...fact,
        canonicalText,
        confidence: Math.max(winner.confidence, loser.confidence),
        status: mergedStatus,
        sourceTags: dedupeSourceTags([...(winner.sourceTags ?? ['chat']), ...(loser.sourceTags ?? ['chat'])]),
        createdAt: new Date(Math.min(new Date(winner.createdAt).getTime(), new Date(loser.createdAt).getTime())).toISOString(),
        updatedAt: winnerUpdatedAt,
      }
    })

  const mergedEvidence = graph.evidence
    .map((item) => (item.factId === loserId ? { ...item, factId: winnerId } : item))
    .sort((a, b) => new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime())

  const winnerEvidenceIds = new Set(
    mergedEvidence
      .filter((item) => item.factId === winnerId)
      .slice(0, MAX_EVIDENCE_PER_FACT)
      .map((item) => item.id),
  )

  const nextEvidence = mergedEvidence.filter((item) => item.factId !== winnerId || winnerEvidenceIds.has(item.id))

  const aliasCandidates = [
    ...graph.aliases.map((alias) => (alias.factId === loserId ? { ...alias, factId: winnerId } : alias)),
    { factId: winnerId, aliasText: winner.canonicalText },
    { factId: winnerId, aliasText: loser.canonicalText },
  ]

  const seenAlias = new Set<string>()
  const nextAliases = aliasCandidates.filter((alias) => {
    if (!alias.aliasText.trim()) return false
    if (alias.factId !== winnerId && alias.factId !== loserId) return true
    const key = `${alias.factId}:${normalize(alias.aliasText)}`
    if (seenAlias.has(key)) return false
    seenAlias.add(key)
    return true
  })

  const nextConflicts = graph.conflicts
    .map((conflict) => ({
      ...conflict,
      factAId: conflict.factAId === loserId ? winnerId : conflict.factAId,
      factBId: conflict.factBId === loserId ? winnerId : conflict.factBId,
      winnerFactId: conflict.winnerFactId === loserId ? winnerId : conflict.winnerFactId,
      updatedAt: now,
    }))
    .filter((conflict) => conflict.factAId !== conflict.factBId)

  const seenConflict = new Set<string>()
  const dedupedConflicts = nextConflicts.filter((conflict) => {
    const key = conflictKey(conflict.factAId, conflict.factBId)
    if (seenConflict.has(key)) return false
    seenConflict.add(key)
    return true
  })

  const validFactIds = new Set(nextFacts.map((fact) => fact.id))
  const nextVectorIndex = (graph.vectorIndex ?? [])
    .map((entry) => {
      if (entry.factId !== loserId) return entry
      return {
        ...entry,
        factId: winnerId,
        updatedAt: winnerUpdatedAt,
      }
    })
    .filter((entry) => validFactIds.has(entry.factId))

  return pruneGraph({
    facts: nextFacts,
    evidence: nextEvidence.filter((item) => validFactIds.has(item.factId)),
    aliases: nextAliases.filter((item) => validFactIds.has(item.factId)),
    conflicts: dedupedConflicts.filter(
      (item) => validFactIds.has(item.factAId) && validFactIds.has(item.factBId) && validFactIds.has(item.winnerFactId),
    ),
    vectorIndex: nextVectorIndex,
  })
}

export const analyzeAndMergeVectorMemories = (
  graph: MemoryGraphState,
  options?: { similarityThreshold?: number; lexicalGuard?: number },
): { graph: MemoryGraphState; mergedPairs: number } => {
  const similarityThreshold = options?.similarityThreshold ?? 0.94
  const lexicalGuard = options?.lexicalGuard ?? 0.16
  const activeFacts = graph.facts.filter((fact) => fact.status !== 'superseded')
  if (activeFacts.length < 2) return { graph, mergedPairs: 0 }

  const vectorByFactId = new Map<string, number[]>()
  for (const fact of activeFacts) {
    const entries = (graph.vectorIndex ?? [])
      .filter((entry) => entry.factId === fact.id && Array.isArray(entry.vector) && entry.vector.length > 0)
      .sort((a, b) => {
        const aTime = new Date(a.updatedAt).getTime()
        const bTime = new Date(b.updatedAt).getTime()
        if (bTime !== aTime) return bTime - aTime
        const providerRank = (provider?: string): number => {
          if (provider === 'api') return 3
          if (provider === 'browser') return 2
          return 1
        }
        return providerRank(b.provider) - providerRank(a.provider)
      })
    if (entries[0]) {
      vectorByFactId.set(fact.id, entries[0].vector)
    }
  }

  if (vectorByFactId.size < 2) return { graph, mergedPairs: 0 }

  type CandidatePair = { a: MemoryFact; b: MemoryFact; similarity: number }
  const candidatePairs: CandidatePair[] = []

  for (let left = 0; left < activeFacts.length; left += 1) {
    for (let right = left + 1; right < activeFacts.length; right += 1) {
      const a = activeFacts[left]
      const b = activeFacts[right]
      if (a.category !== b.category) continue
      const va = vectorByFactId.get(a.id)
      const vb = vectorByFactId.get(b.id)
      if (!va || !vb) continue
      const similarity = cosineSimilarityVectors(va, vb)
      if (!Number.isFinite(similarity) || similarity < similarityThreshold) continue

      const lexical = jaccard(a.canonicalText, b.canonicalText)
      const relationByInclusion =
        normalize(a.canonicalText).includes(normalize(b.canonicalText)) ||
        normalize(b.canonicalText).includes(normalize(a.canonicalText))
      if (lexical < lexicalGuard && !relationByInclusion && similarity < 0.985) continue

      candidatePairs.push({ a, b, similarity })
    }
  }

  if (candidatePairs.length === 0) return { graph, mergedPairs: 0 }

  candidatePairs.sort((x, y) => y.similarity - x.similarity)

  let next = graph
  let mergedPairs = 0

  for (const pair of candidatePairs) {
    const currentA = next.facts.find((fact) => fact.id === pair.a.id)
    const currentB = next.facts.find((fact) => fact.id === pair.b.id)
    if (!currentA || !currentB) continue
    if (currentA.status === 'superseded' || currentB.status === 'superseded') continue

    const aUpdated = new Date(currentA.updatedAt).getTime()
    const bUpdated = new Date(currentB.updatedAt).getTime()
    const winner =
      currentA.confidence > currentB.confidence
        ? currentA
        : currentB.confidence > currentA.confidence
          ? currentB
          : aUpdated >= bUpdated
            ? currentA
            : currentB
    const loser = winner.id === currentA.id ? currentB : currentA

    next = mergeFactPair(next, winner.id, loser.id)
    mergedPairs += 1
  }

  return { graph: next, mergedPairs }
}

export const clearMemoryGraph = (): MemoryGraphState => emptyMemoryGraph()

export const extractFactsWithModel = async (
  client: LmStudioClient,
  model: string,
  userText: string,
  context?: ExtractionContext,
): Promise<{ extraction: ExtractionV2Result; usedFallback: boolean; rawText: string; error?: string }> => {
  try {
    const response = await client.chat({
      model,
      input: extractionPrompt(userText, context),
      system_prompt: 'You are a memory extraction engine. Return strict JSON only, no prose, no markdown.',
      stream: false,
      store: false,
    })

    const text = extractTextFromChatResponse(response)
    const parsed = normalizeExtractionWithContext(parseExtractionV2(text), userText, context)
    if (parsed.facts.length > 0) {
      return { extraction: parsed, usedFallback: false, rawText: text }
    }

    // Advanced pass 1: model JSON repair of the first output.
    try {
      const repaired = await repairStructuredOutput(client, model, 'extraction', text)
      const repairedParsed = normalizeExtractionWithContext(parseExtractionV2(repaired), userText, context)
      if (repairedParsed.facts.length > 0) {
        return {
          extraction: repairedParsed,
          usedFallback: false,
          rawText: `${text}\n\n[repaired]\n${repaired}`,
        }
      }
    } catch {
      // continue to retry path
    }

    // Advanced pass 2: retry extraction with stricter format instruction.
    try {
      const retryResponse = await client.chat({
        model,
        input: [
          'Retry extraction with strict JSON only.',
          'No prose. No markdown. No code fences.',
          '{"facts":[{"canonicalText":"...","category":"preference|profile|goal|constraint|other","confidence":0.0,"aliases":["..."],"contradictionWith":["..."],"currentness":0.0}]}',
          `Previous user message: ${context?.previousUserMessage?.trim() || '[none]'}`,
          `Previous assistant message: ${context?.previousAssistantMessage?.trim() || '[none]'}`,
          `User message: ${userText}`,
        ].join('\n'),
        system_prompt: 'Return strict JSON only. If no facts exist, return {"facts":[]}.',
        stream: false,
        store: false,
      })

      const retryText = extractTextFromChatResponse(retryResponse)
      const retryParsed = normalizeExtractionWithContext(parseExtractionV2(retryText), userText, context)
      if (retryParsed.facts.length > 0) {
        return {
          extraction: retryParsed,
          usedFallback: false,
          rawText: `${text}\n\n[retry]\n${retryText}`,
        }
      }
      return {
        extraction: fallbackExtract(userText, context),
        usedFallback: true,
        rawText: `${text}\n\n[retry]\n${retryText}`,
      }
    } catch {
      return { extraction: fallbackExtract(userText, context), usedFallback: true, rawText: text }
    }
  } catch {
    // fallback below
  }

  return {
    extraction: fallbackExtract(userText, context),
    usedFallback: true,
    rawText: '',
    error: 'extract request failed',
  }
}
