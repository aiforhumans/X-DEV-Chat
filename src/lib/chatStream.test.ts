import { describe, expect, it } from 'vitest'
import { applyStreamEvent, extractResponseId, initialAccumulator } from './chatStream'

describe('applyStreamEvent', () => {
  it('appends message and reasoning deltas', () => {
    let state = initialAccumulator()
    state = applyStreamEvent(state, { type: 'message.delta', content: 'Hello' })
    state = applyStreamEvent(state, { type: 'reasoning.delta', content: 'Thinking' })

    expect(state.messageText).toBe('Hello')
    expect(state.reasoningText).toBe('Thinking')
  })

  it('maps progress events to status text', () => {
    const state = applyStreamEvent(initialAccumulator(), { type: 'model_load.progress', progress: 0.52 })
    expect(state.statusLine).toBe('Loading model... 52%')
  })

  it('maps non-delta lifecycle events to status text', () => {
    const start = applyStreamEvent(initialAccumulator(), { type: 'prompt_processing.start' })
    expect(start.statusLine).toBe('Processing prompt...')

    const progress = applyStreamEvent(start, { type: 'prompt_processing.progress', progress: 0.25 })
    expect(progress.statusLine).toBe('Processing prompt... 25%')

    const generating = applyStreamEvent(progress, { type: 'message.start' })
    expect(generating.statusLine).toBe('Generating response...')

    const complete = applyStreamEvent(generating, { type: 'message.end' })
    expect(complete.statusLine).toBe('Response complete')
  })
})

describe('extractResponseId', () => {
  it('reads explicit response_id when present', () => {
    expect(extractResponseId({ type: 'message.delta', response_id: 'resp_1' })).toBe('resp_1')
  })

  it('falls back to event id for response events', () => {
    expect(extractResponseId({ type: 'response.created', id: 'resp_2' })).toBe('resp_2')
  })

  it('returns null when no response id can be inferred', () => {
    expect(extractResponseId({ type: 'message.delta', id: 'msg_1' })).toBeNull()
  })
})
