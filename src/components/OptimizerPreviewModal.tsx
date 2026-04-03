import type { SystemPromptOptimizationResult } from '../types/chat'

interface OptimizerPreview {
  target: 'system' | 'persona' | 'scenario'
  currentPrompt: string
  result: SystemPromptOptimizationResult
}

interface OptimizerPreviewModalProps {
  preview: OptimizerPreview | null
  onAccept: (preview: OptimizerPreview) => void
  onReject: (preview: OptimizerPreview) => void
}

export const OptimizerPreviewModal = (props: OptimizerPreviewModalProps) => {
  const { preview, onAccept, onReject } = props
  if (!preview) return null

  return (
    <div className="optimizer-overlay" role="dialog" aria-modal="true" aria-label="Prompt optimization preview">
      <article className="optimizer-modal">
        <header>
          <h2>
            {preview.target === 'persona'
              ? 'Optimized Custom Persona'
              : preview.target === 'scenario'
                ? 'Optimized Scenario Block'
                : 'Optimized System Prompt'}
          </h2>
        </header>
        <section>
          <h3>
            {preview.target === 'persona'
              ? 'Current Custom Persona'
              : preview.target === 'scenario'
                ? 'Current Scenario Block'
                : 'Current Chat System Message'}
          </h3>
          <pre>{preview.currentPrompt || '[empty]'}</pre>
        </section>
        <section>
          <h3>Improved Prompt</h3>
          <pre>{preview.result.optimizedPrompt}</pre>
        </section>
        <section>
          <h3>Rationale</h3>
          <p>{preview.result.rationale}</p>
        </section>
        <div className="memory-actions">
          <button onClick={() => onAccept(preview)}>Accept</button>
          <button onClick={() => onReject(preview)}>Reject</button>
        </div>
      </article>
    </div>
  )
}
