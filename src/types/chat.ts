export type ChatRole = 'user' | 'assistant' | 'system' | 'error'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  reasoning?: string
  partial?: boolean
  responseId?: string
  sourcePrompt?: string
  parentResponseId?: string | null
}

export type MemoryFactStatus = 'active' | 'superseded' | 'uncertain'
export type MemorySourceType = 'chat' | 'file'

export interface MemoryFact {
  id: string
  canonicalText: string
  category: 'preference' | 'profile' | 'goal' | 'constraint' | 'other'
  status: MemoryFactStatus
  confidence: number
  sourceTags: MemorySourceType[]
  createdAt: string
  updatedAt: string
}

export interface MemoryEvidence {
  id: string
  factId: string
  sourceMessageId: string
  verbatim: string
  extractedAt: string
  confidence: number
  sourceType: MemorySourceType
  sourceRef?: {
    fileId?: string
    fileName?: string
  }
}

export interface MemoryAlias {
  factId: string
  aliasText: string
}

export interface MemoryConflict {
  id: string
  factAId: string
  factBId: string
  winnerFactId: string
  reason: string
  createdAt: string
  updatedAt: string
  resolvedManually?: boolean
}

export interface MemoryGraphState {
  facts: MemoryFact[]
  evidence: MemoryEvidence[]
  aliases: MemoryAlias[]
  conflicts: MemoryConflict[]
  vectorIndex?: FactVectorIndexEntry[]
}

export interface ExtractionV2Candidate {
  canonicalText: string
  category: MemoryFact['category']
  confidence: number
  aliases?: string[]
  contradictionWith?: string[]
  currentness?: number
}

export interface ExtractionV2Result {
  facts: ExtractionV2Candidate[]
}

export interface RerankResult {
  selectedFactIds: string[]
  scores: Array<{ factId: string; score: number; rationale?: string }>
}

export type EmbeddingStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface FactVectorIndexEntry {
  factId: string
  vector: number[]
  updatedAt: string
  provider?: 'browser' | 'api' | 'hash'
  model?: string
  textHash?: string
}

export interface SemanticPrefilterResult {
  fact: MemoryFact
  score: number
}

export interface PersonaModeState {
  enabled: boolean
  intensity: number
  personaText: string
  personaUpdatedAt?: string
}

export interface PersonaPromptContext {
  personaBlock: string
  personaEnabled: boolean
  intensity: number
  personaText: string
}

export interface SystemPromptOptimizationResult {
  optimizedPrompt: string
  rationale: string
  warnings?: string[]
  rawOutput: string
  parsePath: 'direct' | 'fenced' | 'substring' | 'retry-repair' | 'best-effort'
}

export interface SystemPromptOptimizationDebug {
  status: 'optimizing' | 'ready' | 'failed'
  model: string
  rawOutput: string
  parsePath: string
  error?: string
}

export interface MemoryRecallContext {
  selectedFacts: MemoryFact[]
  contextBlock: string
}

export interface EpisodeRecord {
  id?: number
  sessionId: string
  summary: string
  embedding: number[]
  startIndex: number
  endIndex: number
  createdAt: string
  sourceMessageIds: string[]
}

export interface ProfileExtractionResult {
  lines: string[]
  parseMode: 'nl' | 'json-fallback' | 'none'
  usedFallback: boolean
  rawText: string
  error?: string
}

export type MemoryJobStatus = 'idle' | 'running' | 'done' | 'failed'

export interface FileChunk {
  id: string
  fileId: string
  fileName: string
  index: number
  text: string
}

export interface FileIngestJob {
  id: string
  fileName: string
  totalChunks: number
  processedChunks: number
  status: 'queued' | 'processing' | 'done' | 'failed'
  error?: string
}

export interface LegacyMemoryItem {
  id: string
  text: string
  category: string
  confidence: number
  createdAt: string
  updatedAt: string
  sourceMessageId: string
}

export interface ModelInfo {
  id: string
  key?: string
  object?: string
  type?: string
  loaded?: boolean
  loaded_instances?: Array<{ id?: string }>
  [key: string]: unknown
}

export interface ChatTurnRequest {
  model: string
  input: string | Array<Record<string, unknown>>
  system_prompt?: string
  previous_response_id?: string
  temperature?: number
  top_p?: number
  store?: boolean
  stream?: boolean
}

export interface ChatTurnState {
  lastResponseId: string | null
}

export interface StreamEventBase {
  type: string
  [key: string]: unknown
}

export interface MessageDeltaEvent extends StreamEventBase {
  type: 'message.delta'
  content: string
}

export interface ReasoningDeltaEvent extends StreamEventBase {
  type: 'reasoning.delta'
  content: string
}

export type StreamEvent = MessageDeltaEvent | ReasoningDeltaEvent | StreamEventBase

export interface PersistedChatState {
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
  personaMode: PersonaModeState
  lastResponseId: string | null
  messages: ChatMessage[]
  memoryVersion: 2
  memoryGraph: MemoryGraphState
  lastFailedPrompt: string | null
  // legacy key retained for migration compatibility
  memories?: LegacyMemoryItem[]
}
