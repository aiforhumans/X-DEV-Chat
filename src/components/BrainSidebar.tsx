import type { EmbeddingStatus, MemoryEvidence, MemoryFact, MemoryGraphState } from '../types/chat'
import type { VectorExportFormat } from '../lib/vectorExport'
import { formatDateTime } from '../lib/dateFormatting'

interface BrainSidebarProps {
  embeddingStatus: EmbeddingStatus
  episodeStatus: string
  fileDerivedFactCount: number
  hasLastAssistantMessage: boolean
  hasMessages: boolean
  isStreaming: boolean
  memoryGraph: MemoryGraphState
  memoryStatus: string
  profileStatus: string
  showEvidenceByFactId: Record<string, boolean>
  sortedFacts: MemoryFact[]
  vectorExportFormat: VectorExportFormat
  vectorMemoryCount: number
  evidenceByFactId: Map<string, MemoryEvidence[]>
  onClearAllMemories: () => void
  onClearChat: () => void
  onClearFileFacts: () => void
  onDeleteFact: (factId: string, canonicalText: string) => void
  onExportVectorData: () => void
  onOpenDebug: () => void
  onRegenerateLastResponse: () => void
  onResolveConflictWinner: (conflictId: string, winnerFactId: string) => void
  onRetryEmbeddings: () => void
  onRunAnalyzeAndMergeVectorMemories: () => void
  onToggleEvidence: (factId: string, open: boolean) => void
  onVectorExportFormatChange: (value: VectorExportFormat) => void
}

export const BrainSidebar = (props: BrainSidebarProps) => {
  const {
    embeddingStatus,
    episodeStatus,
    evidenceByFactId,
    fileDerivedFactCount,
    hasLastAssistantMessage,
    hasMessages,
    isStreaming,
    memoryGraph,
    memoryStatus,
    profileStatus,
    showEvidenceByFactId,
    sortedFacts,
    vectorExportFormat,
    vectorMemoryCount,
    onClearAllMemories,
    onClearChat,
    onClearFileFacts,
    onDeleteFact,
    onExportVectorData,
    onOpenDebug,
    onRegenerateLastResponse,
    onResolveConflictWinner,
    onRetryEmbeddings,
    onRunAnalyzeAndMergeVectorMemories,
    onToggleEvidence,
    onVectorExportFormatChange,
  } = props

  return (
    <aside className="sidebar sidebar-right panel panel-brain">
      <h2>Actions</h2>
      <button onClick={onClearChat} disabled={isStreaming || !hasMessages}>
        Clear Chat
      </button>
      <button
        onClick={onRegenerateLastResponse}
        disabled={isStreaming || !hasLastAssistantMessage}
      >
        Regen Last Response
      </button>
      <button onClick={onOpenDebug}>Brain Debug</button>

      <h2>Brain v2</h2>
      <p className="memory-status" role="status" aria-live="polite">
        {memoryStatus}
      </p>
      <p className="memory-meta">Episodes: {episodeStatus}</p>
      <p className="memory-meta">User profile: {profileStatus}</p>
      <p className="memory-meta">Embeddings: {embeddingStatus}</p>
      <p className="memory-meta">Vector memories: {vectorMemoryCount}</p>
      <p className="memory-meta">File-derived facts: {fileDerivedFactCount}</p>
      <button onClick={onRetryEmbeddings} disabled={isStreaming || embeddingStatus === 'loading'}>
        Retry Embeddings
      </button>
      <button
        onClick={onRunAnalyzeAndMergeVectorMemories}
        disabled={isStreaming || embeddingStatus === 'loading' || memoryGraph.facts.length < 2}
      >
        Analyze & Merge Vector Memories
      </button>
      <label htmlFor="vectorExportFormat">Vector Export Format</label>
      <select
        id="vectorExportFormat"
        value={vectorExportFormat}
        onChange={(event) => onVectorExportFormatChange(event.target.value as VectorExportFormat)}
        disabled={isStreaming || vectorMemoryCount === 0}
      >
        <option value="geojson">GeoJSON</option>
        <option value="kml">KML</option>
        <option value="shapefile">Shapefile (.zip)</option>
      </select>
      <button onClick={onExportVectorData} disabled={isStreaming || vectorMemoryCount === 0}>
        Export Vector Data
      </button>
      <button onClick={onClearAllMemories} disabled={memoryGraph.facts.length === 0 || isStreaming}>
        Clear All Memories
      </button>
      <button onClick={onClearFileFacts} disabled={fileDerivedFactCount === 0 || isStreaming}>
        Clear File Facts
      </button>

      <div className="memory-list" role="list">
        {sortedFacts.length === 0 ? <p className="empty">No stored facts yet.</p> : null}
        {sortedFacts.map((fact) => {
          const evidence = evidenceByFactId.get(fact.id) ?? []
          const open = Boolean(showEvidenceByFactId[fact.id])
          return (
            <article key={fact.id} className="memory-item" role="listitem">
              <header>
                <strong>{fact.category}</strong>
                <span>{fact.status}</span>
              </header>
              <p>{fact.canonicalText}</p>
              <p className="memory-meta">
                {Math.round(fact.confidence * 100)}% | {evidence.length} evidence | {formatDateTime(fact.updatedAt)} |
                {' '}sources: {fact.sourceTags.join(',')}
              </p>
              <div className="memory-actions">
                <button onClick={() => onToggleEvidence(fact.id, !open)} disabled={isStreaming}>
                  {open ? 'Hide Evidence' : 'Show Evidence'}
                </button>
                <button onClick={() => onDeleteFact(fact.id, fact.canonicalText)} disabled={isStreaming}>
                  Delete
                </button>
              </div>
              {open ? (
                <ul className="evidence-list">
                  {evidence.length === 0 ? <li>No evidence yet.</li> : null}
                  {evidence.map((entry) => (
                    <li key={entry.id}>
                      <span>{Math.round(entry.confidence * 100)}%</span> {entry.verbatim}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          )
        })}

        {memoryGraph.conflicts.length > 0 ? <h3 className="conflict-title">Conflicts</h3> : null}
        {memoryGraph.conflicts.map((conflict) => {
          const factA = memoryGraph.facts.find((fact) => fact.id === conflict.factAId)
          const factB = memoryGraph.facts.find((fact) => fact.id === conflict.factBId)
          if (!factA || !factB) return null

          return (
            <article key={conflict.id} className="memory-item">
              <header>
                <strong>Conflict</strong>
                <span>{conflict.resolvedManually ? 'manual' : 'auto'}</span>
              </header>
              <p>{factA.canonicalText}</p>
              <p>{factB.canonicalText}</p>
              <p className="memory-meta">Winner: {conflict.winnerFactId === factA.id ? 'A' : 'B'}</p>
              <div className="memory-actions">
                <button onClick={() => onResolveConflictWinner(conflict.id, factA.id)} disabled={isStreaming}>
                  Set A Winner
                </button>
                <button onClick={() => onResolveConflictWinner(conflict.id, factB.id)} disabled={isStreaming}>
                  Set B Winner
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </aside>
  )
}
