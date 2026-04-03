import { describe, expect, it } from 'vitest'
import {
  buildOptimizerInstruction,
  buildOptimizerRepairInstruction,
  buildOptimizerRetryInstruction,
  getOptimizerSystemPrompt,
  optimizerConfig,
} from './optimizerConfig'

describe('optimizerConfig', () => {
  it('renders system and persona instruction templates with source text', () => {
    const system = buildOptimizerInstruction('system', 'Keep answers concise.')
    const persona = buildOptimizerInstruction('persona', 'A grounded, practical friend.')
    const scenario = buildOptimizerInstruction('scenario', 'Noir detective roleplay in 1940s Chicago.')

    expect(system).toContain('Keep answers concise.')
    expect(system).toContain('Output contract')
    expect(persona).toContain('A grounded, practical friend.')
    expect(persona).toContain('conversational realism')
    expect(scenario).toContain('Noir detective roleplay in 1940s Chicago.')
    expect(scenario).toContain('Original scenario block')
  })

  it('renders retry templates for both targets', () => {
    const systemRetry = buildOptimizerRetryInstruction('system', 'original system')
    const personaRetry = buildOptimizerRetryInstruction('persona', 'original persona')
    const scenarioRetry = buildOptimizerRetryInstruction('scenario', 'original scenario')

    expect(systemRetry).toContain('original system')
    expect(personaRetry).toContain('original persona')
    expect(scenarioRetry).toContain('original scenario')
    expect(systemRetry).toContain('Previous output was invalid')
  })

  it('renders repair template and injects [empty] for blank raw output', () => {
    const repair = buildOptimizerRepairInstruction('')
    expect(repair).toContain('Raw output:')
    expect(repair).toContain('[empty]')
  })

  it('exposes target-specific optimizer system prompts', () => {
    const systemPrompt = getOptimizerSystemPrompt('system')
    const personaPrompt = getOptimizerSystemPrompt('persona')
    const scenarioPrompt = getOptimizerSystemPrompt('scenario')

    expect(systemPrompt).toContain('system prompt optimizer')
    expect(personaPrompt).toContain('persona prompt optimizer')
    expect(scenarioPrompt).toContain('scenario prompt optimizer')
    expect(optimizerConfig.optimizerRepairTemplate.length).toBeGreaterThan(0)
  })
})
