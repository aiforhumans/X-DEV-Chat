import { describe, expect, it } from 'vitest'
import { buildPersonaPrompt, composeSystemPrompt, defaultPersonaMode } from './personaMode'

describe('personaMode', () => {
  it('returns empty block when disabled', () => {
    const context = buildPersonaPrompt({
      enabled: false,
      intensity: 80,
      personaText: 'A cheerful person',
    })

    expect(context.personaEnabled).toBe(false)
    expect(context.personaBlock).toBe('')
  })

  it('builds persona prompt with clamped intensity', () => {
    const context = buildPersonaPrompt({
      enabled: true,
      intensity: 140,
      personaText: 'A candid close friend',
    })

    expect(context.personaEnabled).toBe(true)
    expect(context.intensity).toBe(100)
    expect(context.personaBlock).toContain('A candid close friend')
  })

  it('composes system prompt in stable order', () => {
    const prompt = composeSystemPrompt(['base system', 'persona block', 'memory block'])
    expect(prompt).toBe('base system\n\npersona block\n\nmemory block')
  })

  it('defaults roleplay mode to enabled and intensity 70', () => {
    expect(defaultPersonaMode()).toEqual({
      enabled: true,
      intensity: 70,
      personaText: '',
    })
  })
})
