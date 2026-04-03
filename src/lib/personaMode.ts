import type { PersonaModeState, PersonaPromptContext } from '../types/chat'

export const defaultPersonaMode = (): PersonaModeState => ({
  enabled: true,
  intensity: 70,
  personaText: '',
})

const clampIntensity = (value: number): number => {
  if (Number.isNaN(value)) return 70
  return Math.max(0, Math.min(100, Math.round(value)))
}

const styleGuidance = (intensity: number): string => {
  if (intensity < 20) return 'Use light conversational warmth and mostly neutral phrasing.'
  if (intensity < 40) return 'Use friendly natural phrasing with mild personality.'
  if (intensity < 60) return 'Use a clearly human conversational style with emotional nuance.'
  if (intensity < 80) return 'Use strong first-person conversational realism and social cues.'
  return 'Use highly vivid personal voice, natural rhythm, and strong human-like spontaneity.'
}

export const buildPersonaPrompt = (personaMode: PersonaModeState): PersonaPromptContext => {
  const intensity = clampIntensity(personaMode.intensity)
  const personaText = personaMode.personaText.trim()

  if (!personaMode.enabled) {
    return {
      personaBlock: '',
      personaEnabled: false,
      intensity,
      personaText,
    }
  }

  const identityLine = personaText
    ? `Adopt this real-person role identity: ${personaText}`
    : 'Behave as a realistic person with coherent personal voice and social awareness.'

  const personaBlock = [
    'Roleplay Mode Instructions:',
    identityLine,
    styleGuidance(intensity),
    'Speak naturally as a person, maintain conversational continuity, and avoid robotic list-like output unless asked.',
  ].join('\n')

  return {
    personaBlock,
    personaEnabled: true,
    intensity,
    personaText,
  }
}

export const composeSystemPrompt = (segments: Array<string | undefined | null>): string =>
  segments
    .map((segment) => (segment ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
