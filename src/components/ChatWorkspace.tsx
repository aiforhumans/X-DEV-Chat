import { useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChatTimeline } from './ChatTimeline'
import type { ChatMessage, FileIngestJob } from '../types/chat'

interface ChatWorkspaceProps {
  errorBanner: string
  fileJobs: FileIngestJob[]
  input: string
  isStreaming: boolean
  lastFailedPrompt: string | null
  messages: ChatMessage[]
  selectedModel: string
  showReasoningById: Record<string, boolean>
  statusLine: string
  onComposerInputChange: (value: string) => void
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onFileList: (files: FileList) => void
  onRetryLastFailedPrompt: () => void
  onSend: () => void
  onToggleReasoning: (id: string, open: boolean) => void
}

export const ChatWorkspace = (props: ChatWorkspaceProps) => {
  const {
    errorBanner,
    fileJobs,
    input,
    isStreaming,
    lastFailedPrompt,
    messages,
    selectedModel,
    showReasoningById,
    statusLine,
    onComposerInputChange,
    onComposerKeyDown,
    onFileList,
    onRetryLastFailedPrompt,
    onSend,
    onToggleReasoning,
  } = props
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)

  const openFilePicker = (): void => {
    fileInputRef.current?.click()
  }

  return (
    <main className="chat-panel panel panel-chat">
      <div className="status-bar">
        <p className="status-line" role="status" aria-live="polite">
          {statusLine}
        </p>
        {errorBanner ? (
          <p className="error" role="alert">
            {errorBanner}
          </p>
        ) : null}
      </div>

      <ChatTimeline
        messages={messages}
        showReasoningById={showReasoningById}
        onToggleReasoning={onToggleReasoning}
      />

      <section className="composer" aria-label="Chat Composer Region">
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.csv"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) {
              onFileList(event.target.files)
              event.target.value = ''
            }
          }}
        />

        <button
          type="button"
          className={`drop-zone ${dragActive ? 'active' : ''}`}
          onClick={openFilePicker}
          onDragOver={(event) => {
            event.preventDefault()
            setDragActive(true)
          }}
          onDragLeave={(event) => {
            event.preventDefault()
            setDragActive(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragActive(false)
            onFileList(event.dataTransfer.files)
          }}
          aria-label="Add files for Brain ingest"
        >
          <strong>Add Files for Brain Ingest</strong>
          <p>Drop .txt, .md, or .csv files here, or click to browse…</p>
        </button>

        {fileJobs.length > 0 ? (
          <div className="file-jobs" role="status" aria-live="polite">
            {fileJobs.slice(0, 5).map((job) => (
              <p key={job.id} className="memory-meta">
                {job.fileName}: {job.status} ({job.processedChunks}/{job.totalChunks})
                {job.error ? ` - ${job.error}` : ''}
              </p>
            ))}
          </div>
        ) : null}

        <label className="sr-only" htmlFor="composerInput">
          Message Composer
        </label>
        <textarea
          id="composerInput"
          name="composer_message"
          value={input}
          onChange={(event) => onComposerInputChange(event.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder="Message the local model…"
          disabled={isStreaming}
          autoComplete="off"
        />

        <div className="composer-actions">
          <button onClick={onSend} disabled={isStreaming || !input.trim() || !selectedModel}>
            Send
          </button>
          {lastFailedPrompt ? (
            <button onClick={onRetryLastFailedPrompt} disabled={isStreaming || !selectedModel}>
              Retry Last Failed Prompt
            </button>
          ) : null}
        </div>
      </section>
    </main>
  )
}
