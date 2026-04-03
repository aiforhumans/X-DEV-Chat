import Dexie, { type Table } from 'dexie'
import type { ChatMessage, EpisodeRecord, MemoryGraphState, PersistedChatState } from '../types/chat'
import { loadPersistedState } from '../lib/persistence'

export const DEFAULT_SESSION_ID = 'default-session'
const META_MIGRATION_KEY = 'migration.localstorage.v1'

interface DbMessageRow {
  id?: number
  sessionId: string
  messageId: string
  role: ChatMessage['role']
  content: string
  createdAt: string
  reasoning?: string
  partial?: boolean
  responseId?: string
  sourcePrompt?: string
  parentResponseId?: string | null
  position: number
  timestamp: number
}

interface DbEpisodeRow extends EpisodeRecord {
  id?: number
}

interface DbFactRow {
  id?: number
  factKey: string
  fact: string
  topic: string
  winnerId?: string
  memoryVersion: number
  status: 'active' | 'superseded' | 'uncertain'
  confidence: number
  sourceTags: Array<'chat' | 'file'>
  createdAt: string
  updatedAt: string
}

interface DbEvidenceRow {
  id?: number
  evidenceId: string
  factKey: string
  sourceMessageId: string
  verbatim: string
  extractedAt: string
  confidence: number
  sourceType: 'chat' | 'file'
  sourceRef?: {
    fileId?: string
    fileName?: string
  }
}

interface DbAliasRow {
  id?: number
  factKey: string
  aliasText: string
}

interface DbConflictRow {
  id?: number
  conflictId: string
  factAId: string
  factBId: string
  winnerFactId: string
  reason: string
  createdAt: string
  updatedAt: string
  resolvedManually?: boolean
}

interface DbMetaRow {
  key: string
  value: string
}

class LocalChatDb extends Dexie {
  messages!: Table<DbMessageRow, number>
  episodes!: Table<DbEpisodeRow, number>
  brainFacts!: Table<DbFactRow, number>
  brainEvidence!: Table<DbEvidenceRow, number>
  brainAliases!: Table<DbAliasRow, number>
  brainConflicts!: Table<DbConflictRow, number>
  meta!: Table<DbMetaRow, string>

  constructor() {
    super('lmstudio-local-chat-db')
    this.version(1).stores({
      messages: '++id, sessionId, position, timestamp, role',
      episodes: '++id, sessionId, createdAt, [startIndex+endIndex]',
      brainFacts: '++id, factKey, fact, topic, winnerId, memoryVersion, updatedAt',
      brainEvidence: '++id, evidenceId, factKey, extractedAt, sourceType',
      brainAliases: '++id, factKey',
      brainConflicts: '++id, conflictId, winnerFactId, updatedAt',
      meta: 'key',
    })
  }
}

const hasIndexedDb = typeof indexedDB !== 'undefined'
const db = hasIndexedDb ? new LocalChatDb() : null

const fallback = {
  messages: new Map<string, DbMessageRow[]>(),
  episodes: new Map<string, DbEpisodeRow[]>(),
  brainFacts: [] as DbFactRow[],
  brainEvidence: [] as DbEvidenceRow[],
  brainAliases: [] as DbAliasRow[],
  brainConflicts: [] as DbConflictRow[],
  meta: new Map<string, string>(),
}

const parseMeta = <T>(value: string | undefined, defaultValue: T): T => {
  if (!value) return defaultValue
  try {
    return JSON.parse(value) as T
  } catch {
    return defaultValue
  }
}

const setMetaValue = async (key: string, value: unknown): Promise<void> => {
  const encoded = JSON.stringify(value)
  if (db) {
    await db.meta.put({ key, value: encoded })
    return
  }
  fallback.meta.set(key, encoded)
}

const getMetaValue = async <T>(key: string, defaultValue: T): Promise<T> => {
  if (db) {
    const row = await db.meta.get(key)
    return parseMeta(row?.value, defaultValue)
  }
  return parseMeta(fallback.meta.get(key), defaultValue)
}

export const loadMessages = async (sessionId = DEFAULT_SESSION_ID): Promise<ChatMessage[]> => {
  const rows = db
    ? await db.messages.where('sessionId').equals(sessionId).sortBy('position')
    : [...(fallback.messages.get(sessionId) ?? [])].sort((a, b) => a.position - b.position)

  return rows.map((row) => ({
    id: row.messageId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    reasoning: row.reasoning,
    partial: row.partial,
    responseId: row.responseId,
    sourcePrompt: row.sourcePrompt,
    parentResponseId: row.parentResponseId,
  }))
}

export const saveMessages = async (sessionId: string, messages: ChatMessage[]): Promise<void> => {
  const rows: DbMessageRow[] = messages.map((message, index) => ({
    sessionId,
    messageId: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    reasoning: message.reasoning,
    partial: message.partial,
    responseId: message.responseId,
    sourcePrompt: message.sourcePrompt,
    parentResponseId: message.parentResponseId,
    position: index,
    timestamp: new Date(message.createdAt).getTime() || Date.now(),
  }))

  if (db) {
    await db.transaction('rw', db.messages, async () => {
      await db.messages.where('sessionId').equals(sessionId).delete()
      if (rows.length > 0) await db.messages.bulkAdd(rows)
    })
    return
  }

  fallback.messages.set(sessionId, rows)
}

export const loadWorkingWindow = async (
  sessionId: string,
  limit: number,
): Promise<ChatMessage[]> => {
  const all = await loadMessages(sessionId)
  if (limit <= 0) return []
  return all.slice(-limit)
}

export const saveMemoryGraph = async (graph: MemoryGraphState): Promise<void> => {
  const facts: DbFactRow[] = graph.facts.map((fact) => ({
    factKey: fact.id,
    fact: fact.canonicalText,
    topic: fact.category,
    winnerId: undefined,
    memoryVersion: 2,
    status: fact.status,
    confidence: fact.confidence,
    sourceTags: fact.sourceTags,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  }))

  const evidence: DbEvidenceRow[] = graph.evidence.map((item) => ({
    evidenceId: item.id,
    factKey: item.factId,
    sourceMessageId: item.sourceMessageId,
    verbatim: item.verbatim,
    extractedAt: item.extractedAt,
    confidence: item.confidence,
    sourceType: item.sourceType,
    sourceRef: item.sourceRef,
  }))

  const aliases: DbAliasRow[] = graph.aliases.map((item) => ({
    factKey: item.factId,
    aliasText: item.aliasText,
  }))

  const conflicts: DbConflictRow[] = graph.conflicts.map((item) => ({
    conflictId: item.id,
    factAId: item.factAId,
    factBId: item.factBId,
    winnerFactId: item.winnerFactId,
    reason: item.reason,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    resolvedManually: item.resolvedManually,
  }))

  if (db) {
    await db.transaction(
      'rw',
      [db.brainFacts, db.brainEvidence, db.brainAliases, db.brainConflicts, db.meta],
      async () => {
        await db.brainFacts.clear()
        await db.brainEvidence.clear()
        await db.brainAliases.clear()
        await db.brainConflicts.clear()
        if (facts.length > 0) await db.brainFacts.bulkAdd(facts)
        if (evidence.length > 0) await db.brainEvidence.bulkAdd(evidence)
        if (aliases.length > 0) await db.brainAliases.bulkAdd(aliases)
        if (conflicts.length > 0) await db.brainConflicts.bulkAdd(conflicts)
        await db.meta.put({
          key: 'brain.vectorIndex',
          value: JSON.stringify(graph.vectorIndex ?? []),
        })
      },
    )
    return
  }

  fallback.brainFacts = facts
  fallback.brainEvidence = evidence
  fallback.brainAliases = aliases
  fallback.brainConflicts = conflicts
  fallback.meta.set('brain.vectorIndex', JSON.stringify(graph.vectorIndex ?? []))
}

export const loadMemoryGraph = async (): Promise<MemoryGraphState> => {
  const [facts, evidence, aliases, conflicts, vectors] = db
    ? await Promise.all([
        db.brainFacts.toArray(),
        db.brainEvidence.toArray(),
        db.brainAliases.toArray(),
        db.brainConflicts.toArray(),
        db.meta.get('brain.vectorIndex'),
      ])
    : [
        fallback.brainFacts,
        fallback.brainEvidence,
        fallback.brainAliases,
        fallback.brainConflicts,
        { value: fallback.meta.get('brain.vectorIndex') },
      ]

  return {
    facts: facts.map((fact) => ({
      id: fact.factKey,
      canonicalText: fact.fact,
      category: (fact.topic as 'preference' | 'profile' | 'goal' | 'constraint' | 'other') ?? 'other',
      status: fact.status,
      confidence: fact.confidence,
      sourceTags: fact.sourceTags,
      createdAt: fact.createdAt,
      updatedAt: fact.updatedAt,
    })),
    evidence: evidence.map((item) => ({
      id: item.evidenceId,
      factId: item.factKey,
      sourceMessageId: item.sourceMessageId,
      verbatim: item.verbatim,
      extractedAt: item.extractedAt,
      confidence: item.confidence,
      sourceType: item.sourceType,
      sourceRef: item.sourceRef,
    })),
    aliases: aliases.map((item) => ({
      factId: item.factKey,
      aliasText: item.aliasText,
    })),
    conflicts: conflicts.map((item) => ({
      id: item.conflictId,
      factAId: item.factAId,
      factBId: item.factBId,
      winnerFactId: item.winnerFactId,
      reason: item.reason,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      resolvedManually: item.resolvedManually,
    })),
    vectorIndex: parseMeta(vectors?.value, []),
  }
}

export const addEpisode = async (episode: EpisodeRecord): Promise<void> => {
  const row: DbEpisodeRow = { ...episode }
  if (db) {
    await db.episodes.add(row)
    return
  }
  const current = fallback.episodes.get(episode.sessionId) ?? []
  current.push(row)
  fallback.episodes.set(episode.sessionId, current)
}

export const listEpisodes = async (sessionId: string): Promise<EpisodeRecord[]> => {
  const rows = db
    ? await db.episodes.where('sessionId').equals(sessionId).sortBy('createdAt')
    : [...(fallback.episodes.get(sessionId) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return rows
}

export const getEpisodeCursor = async (sessionId: string): Promise<number> =>
  getMetaValue(`episodes.cursor.${sessionId}`, 0)

export const setEpisodeCursor = async (sessionId: string, value: number): Promise<void> => {
  await setMetaValue(`episodes.cursor.${sessionId}`, Math.max(0, value))
}

export const incrementProfileTurnCounter = async (sessionId: string): Promise<number> => {
  const key = `profile.turnCounter.${sessionId}`
  const current = await getMetaValue(key, 0)
  const next = current + 1
  await setMetaValue(key, next)
  return next
}

export const resetProfileTurnCounter = async (sessionId: string): Promise<void> => {
  await setMetaValue(`profile.turnCounter.${sessionId}`, 0)
}

export const migrateLocalStateToDexieOnce = async (
  legacySnapshot?: PersistedChatState,
): Promise<void> => {
  const done = await getMetaValue(META_MIGRATION_KEY, false)
  if (done) return

  const persisted = legacySnapshot ?? loadPersistedState()
  const existingMessages = await loadMessages(DEFAULT_SESSION_ID)
  if (existingMessages.length === 0 && persisted.messages.length > 0) {
    await saveMessages(DEFAULT_SESSION_ID, persisted.messages)
  }

  const existingGraph = await loadMemoryGraph()
  if (existingGraph.facts.length === 0 && persisted.memoryGraph.facts.length > 0) {
    await saveMemoryGraph(persisted.memoryGraph)
  }

  await setMetaValue(META_MIGRATION_KEY, true)
}
