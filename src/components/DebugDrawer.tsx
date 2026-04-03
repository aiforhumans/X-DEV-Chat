import type { BrainDebugEntry } from '../types/debug'
import { formatTime } from '../lib/dateFormatting'

interface DebugDrawerProps {
  debugOpen: boolean
  debugEntries: BrainDebugEntry[]
  onClear: () => void
  onClose: () => void
}

export const DebugDrawer = (props: DebugDrawerProps) => {
  const { debugOpen, debugEntries, onClear, onClose } = props

  return (
    <aside className={`debug-drawer ${debugOpen ? 'open' : ''}`}>
      <div className="debug-head">
        <h2>Brain Debug</h2>
        <div className="memory-actions">
          <button onClick={onClear} disabled={debugEntries.length === 0}>
            Clear logs
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="debug-list">
        {debugEntries.length === 0 ? <p className="empty">No debug events yet.</p> : null}
        {debugEntries.map((entry) => (
          <article key={entry.id} className="memory-item">
            <header>
              <strong>{entry.kind}</strong>
              <span>{entry.status}</span>
            </header>
            <p className="memory-meta">
              {formatTime(entry.at)} | model: {entry.model}
            </p>
            {entry.prompt ? (
              <p>
                prompt: <code>{entry.prompt.slice(0, 120)}</code>
              </p>
            ) : null}
            {entry.kind !== 'optimize' ? (
              <p className="memory-meta">
                shortlist: {entry.shortlistCount ?? '-'} | selected: {entry.selectedCount ?? '-'}
              </p>
            ) : (
              <>
                <p className="memory-meta">
                  target: {entry.optimizeTarget ?? 'system'} | parse path: {entry.parsePath ?? '-'}
                </p>
                <p className="memory-meta">
                  optimizer system prompt: <code>{(entry.optimizerSystemPromptUsed ?? '').slice(0, 120)}</code>
                </p>
                <p className="memory-meta">
                  chat system message: <code>{(entry.chatSystemMessageSnapshot ?? '').slice(0, 120)}</code>
                </p>
              </>
            )}
            <p className="memory-meta">
              embeddings: {entry.embeddingStatus ?? '-'} | persona: {entry.personaEnabled ? 'on' : 'off'} | intensity:{' '}
              {entry.personaIntensity ?? '-'} | block: {entry.personaBlockLength ?? 0}
            </p>
            {entry.error ? <p className="error">{entry.error}</p> : null}
            <details>
              <summary>Raw Response</summary>
              <pre>{entry.raw || '[empty]'}</pre>
            </details>
          </article>
        ))}
      </div>
    </aside>
  )
}
