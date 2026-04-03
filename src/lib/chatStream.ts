import type { StreamEvent } from '../types/chat'

export interface StreamAccumulator {
  messageText: string
  reasoningText: string
  statusLine: string
}

export const initialAccumulator = (): StreamAccumulator => ({
  messageText: '',
  reasoningText: '',
  statusLine: '',
})

export const applyStreamEvent = (
  current: StreamAccumulator,
  event: StreamEvent,
): StreamAccumulator => {
  const next = { ...current }

  if (event.type === 'message.delta') {
    next.messageText += String(event.content ?? '')
  }

  if (event.type === 'reasoning.delta') {
    next.reasoningText += String(event.content ?? '')
  }

  if (event.type === 'model_load.start') {
    next.statusLine = 'Loading model...'
  }

  if (event.type === 'model_load.progress') {
    const progress = typeof event.progress === 'number' ? Math.round(event.progress * 100) : null
    next.statusLine = progress === null ? 'Loading model...' : `Loading model... ${progress}%`
  }

  if (event.type === 'prompt_processing.start') {
    next.statusLine = 'Processing prompt...'
  }

  if (event.type === 'prompt_processing.progress') {
    const progress = typeof event.progress === 'number' ? Math.round(event.progress * 100) : null
    next.statusLine = progress === null ? 'Processing prompt...' : `Processing prompt... ${progress}%`
  }

  if (event.type === 'message.start') {
    next.statusLine = 'Generating response...'
  }

  if (event.type === 'message.end') {
    next.statusLine = 'Response complete'
  }

  return next
}

export const extractResponseId = (event: StreamEvent): string | null => {
  if (typeof event.response_id === 'string') return event.response_id
  if (typeof event.id === 'string' && event.type.includes('response')) return event.id
  return null
}
