import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync('src/App.tsx', 'utf8')

describe('linkage audit assertions', () => {
  it('keeps system prompt composition order as system -> persona -> scenario -> memory', () => {
    const composeIndex = appSource.indexOf('const fullSystemPrompt = composeSystemPrompt([')
    const systemIndex = appSource.indexOf('systemPrompt.trim()', composeIndex)
    const personaIndex = appSource.indexOf('personaContext.personaBlock', composeIndex)
    const scenarioIndex = appSource.indexOf("scenarioPrompt.trim() ? `Scenario Block:", composeIndex)
    const memoryIndex = appSource.indexOf('recall.contextBlock', composeIndex)

    expect(composeIndex).toBeGreaterThan(-1)
    expect(systemIndex).toBeGreaterThan(-1)
    expect(personaIndex).toBeGreaterThan(systemIndex)
    expect(scenarioIndex).toBeGreaterThan(personaIndex)
    expect(memoryIndex).toBeGreaterThan(scenarioIndex)
  })

  it('keeps hybrid merge before rerank call in send flow', () => {
    const mergeIndex = appSource.indexOf('const shortlist = mergeHybridCandidates(')
    const rerankIndex = appSource.indexOf('const rerankInfo = await rerankFactsWithModel(')

    expect(mergeIndex).toBeGreaterThan(-1)
    expect(rerankIndex).toBeGreaterThan(mergeIndex)
  })

  it('runs memory extraction only after successful stream completion', () => {
    const completeIndex = appSource.indexOf('onComplete: () => {')
    const extractionIndex = appSource.indexOf('void runMemoryExtraction(prompt, userMessage.id, {')
    const includeGuardIndex = appSource.indexOf('if (includeUserMessage) {', completeIndex)

    expect(completeIndex).toBeGreaterThan(-1)
    expect(includeGuardIndex).toBeGreaterThan(completeIndex)
    expect(extractionIndex).toBeGreaterThan(includeGuardIndex)
  })
})
