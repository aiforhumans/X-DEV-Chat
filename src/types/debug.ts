import type { EmbeddingStatus } from './chat'

export interface BrainDebugEntry {
  id: string
  kind: 'extract' | 'rerank' | 'optimize' | 'embed' | 'file' | 'episode-summary' | 'profile-extract'
  at: string
  model: string
  status: string
  prompt?: string
  shortlistCount?: number
  selectedCount?: number
  raw: string
  parsePath?: string
  optimizeTarget?: 'system' | 'persona' | 'scenario'
  optimizerSystemPromptUsed?: string
  chatSystemMessageSnapshot?: string
  embeddingStatus?: EmbeddingStatus
  error?: string
  personaEnabled?: boolean
  personaIntensity?: number
  personaBlockLength?: number
}
