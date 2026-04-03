import type { ChatMessage } from '../types/chat'
import { formatTime } from '../lib/dateFormatting'

interface ChatTimelineProps {
  messages: ChatMessage[]
  showReasoningById: Record<string, boolean>
  onToggleReasoning: (id: string, open: boolean) => void
}

export const ChatTimeline = (props: ChatTimelineProps) => {
  const { messages, showReasoningById, onToggleReasoning } = props

  return (
    <section className="timeline" aria-label="Chat Timeline">
      {messages.length === 0 ? <p className="empty">Start by loading a model and sending a message.</p> : null}
      {messages.map((message) => (
        <article key={message.id} className={`bubble ${message.role}`}>
          <header>
            <strong>{message.role}</strong>
            <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          </header>
          <p>{message.content || (message.partial ? '…' : '')}</p>

          {message.role === 'assistant' && message.reasoning ? (
            <details
              open={Boolean(showReasoningById[message.id])}
              onToggle={(event) => onToggleReasoning(message.id, (event.target as HTMLDetailsElement).open)}
            >
              <summary>Reasoning</summary>
              <pre>{message.reasoning}</pre>
            </details>
          ) : null}
        </article>
      ))}
    </section>
  )
}
