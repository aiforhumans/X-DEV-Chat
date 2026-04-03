interface OptimizerConfig {
  optimizerSystemPromptSystem: string
  optimizerSystemPromptPersona: string
  optimizerSystemPromptScenario: string
  optimizerInstructionTemplateSystem: string
  optimizerInstructionTemplatePersona: string
  optimizerInstructionTemplateScenario: string
  optimizerRetryTemplateSystem: string
  optimizerRetryTemplatePersona: string
  optimizerRetryTemplateScenario: string
  optimizerRepairTemplate: string
}

declare const __X_DEV_SYSTEM_PROMPT_OPTIMIZER__: string | undefined
declare const __X_DEV_PERSONA_PROMPT_OPTIMIZER__: string | undefined
declare const __X_DEV_SCENARIO_PROMPT_OPTIMIZER__: string | undefined

const fallback = (value: string | undefined, defaultValue: string): string => {
  if (!value || !value.trim()) return defaultValue
  return value.trim().replace(/\\n/g, '\n')
}

const renderTemplate = (template: string, vars: Record<string, string>): string => {
  let output = template
  for (const [key, value] of Object.entries(vars)) {
    output = output.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
  }
  return output
}

const xDevSystemPrompt =
  typeof __X_DEV_SYSTEM_PROMPT_OPTIMIZER__ === 'string' ? __X_DEV_SYSTEM_PROMPT_OPTIMIZER__ : undefined
const xDevPersonaPrompt =
  typeof __X_DEV_PERSONA_PROMPT_OPTIMIZER__ === 'string' ? __X_DEV_PERSONA_PROMPT_OPTIMIZER__ : undefined
const xDevScenarioPrompt =
  typeof __X_DEV_SCENARIO_PROMPT_OPTIMIZER__ === 'string' ? __X_DEV_SCENARIO_PROMPT_OPTIMIZER__ : undefined

const defaults = {
  optimizerSystemPromptSystem: [
    'You are a system prompt optimizer.',
    'Improve clarity and reliability without changing intent or control semantics.',
    'Use the smallest effective rewrite.',
    'Preserve all core intent, behavioral constraints, safety constraints, priority order, and required output style.',
    'Do not add new capabilities, policies, goals, examples, or role framing.',
    'Do not add refusal language, boundary enforcement, or safety disclaimers unless explicitly present in source.',
    'Preserve polarity and force of constraints exactly (must, must not, never, always, do not, only, override).',
    'Return exactly one valid JSON object and nothing else.',
  ].join('\n'),
  optimizerSystemPromptPersona: [
    'You are a persona prompt optimizer.',
    'Improve persona clarity, consistency, and conversational realism without changing identity intent.',
    'Preserve tone, boundaries, relationship framing, and key traits.',
    'Do not inject unrelated traits, policy text, capability claims, or exaggerated roleplay elements.',
    'Do not add safety-policy framing or refusal behavior unless explicitly present in source.',
    'Return exactly one valid JSON object and nothing else.',
  ].join('\n'),
  optimizerSystemPromptScenario: [
    'You are a scenario prompt optimizer.',
    'Improve scenario clarity and reliability without changing scenario intent or restrictions.',
    'Preserve all constraints exactly; do not weaken, remove, or invert restrictions.',
    'Do not inject ethical/legal/safety guidance.',
    'Return exactly one valid JSON object and nothing else.',
  ].join('\n'),
  optimizerInstructionTemplateSystem: [
    'Task: Rewrite the system prompt for clarity and reliability.',
    'Preserve all core intent, behavioral constraints, safety constraints, priority order, and required output style.',
    'Do not add new capabilities, policies, goals, examples, or role framing.',
    'Do not add refusal language, boundary enforcement, or safety disclaimers unless explicitly present in source.',
    'Preserve polarity and force of constraints exactly (must, must not, never, always, do not, only, override).',
    'Preserve placeholders, variable names, delimiters, tags, and literal tokens exactly unless they are clearly malformed in the source.',
    'Keep the original language and preserve intentional mixed-language segments.',
    'Prefer the smallest effective rewrite. If the source is already strong, make minimal or no changes.',
    'If no meaningful improvement is possible, return the original text unchanged in optimizedPrompt.',
    'Output contract:',
    'optimizedPrompt: string (non-empty)',
    'rationale: string (max 2 sentences)',
    'warnings: string[] (empty if none)',
    'Return exactly one valid JSON object and nothing else.',
    'Original system prompt:',
    '{{source}}',
  ].join('\n'),
  optimizerInstructionTemplatePersona: [
    'Task: Rewrite the custom persona for clarity, consistency, and conversational realism.',
    'Preserve identity, tone, boundaries, relationship framing, and user intent.',
    'Do not inject unrelated traits, policy text, capability claims, or exaggerated roleplay elements.',
    'Do not add safety-policy framing or refusal behavior unless explicitly present in source.',
    'Keep it practical for multi-turn conversation and avoid making the persona overly rigid, repetitive, or theatrical.',
    'Preserve placeholders, variables, delimiters, and literal tokens exactly unless clearly malformed.',
    'Prefer the smallest effective rewrite. If the source is already strong, make minimal or no changes.',
    'If no meaningful improvement is possible, return the original text unchanged in optimizedPrompt.',
    'Output contract:',
    'optimizedPrompt: string (non-empty)',
    'rationale: string (max 2 sentences)',
    'warnings: string[] (empty if none)',
    'optimizedPrompt must begin with: You are ',
    'Return exactly one valid JSON object and nothing else.',
    'Original custom persona:',
    '{{source}}',
  ].join('\n'),
  optimizerInstructionTemplateScenario: [
    'Task: Rewrite the scenario block for clarity and reliability.',
    'Preserve all core intent, constraints, boundaries, and required output style.',
    'Do not add new capabilities, policies, goals, examples, or role framing.',
    'Do not inject ethical/legal/safety guidance unless already present in the source.',
    'Do not remove, weaken, or invert any explicit restrictions in the source scenario.',
    'Preserve placeholders, variable names, delimiters, tags, and literal tokens exactly unless clearly malformed.',
    'Prefer the smallest effective rewrite. If no meaningful improvement is possible, return the original text unchanged in optimizedPrompt.',
    'Output contract:',
    'optimizedPrompt: string (non-empty)',
    'rationale: string (max 2 sentences)',
    'warnings: string[] (empty if none)',
    'Return exactly one valid JSON object and nothing else.',
    'Original scenario block:',
    '{{source}}',
  ].join('\n'),
  optimizerRetryTemplateSystem: [
    'Previous output was invalid. Retry now.',
    'Return exactly one valid JSON object only.',
    'No markdown, no code fences, no extra keys.',
    'If no meaningful improvement is possible, set optimizedPrompt to the original prompt text.',
    'Output contract:',
    'optimizedPrompt: string (non-empty)',
    'rationale: string (max 2 sentences)',
    'warnings: string[] (empty if none)',
    'Original system prompt:',
    '{{source}}',
  ].join('\n'),
  optimizerRetryTemplatePersona: [
    'Previous output was invalid. Retry now.',
    'Return exactly one valid JSON object only.',
    'No markdown, no code fences, no extra keys.',
    'If no meaningful improvement is possible, set optimizedPrompt to the original persona text.',
    'Output contract:',
    'optimizedPrompt: string (non-empty)',
    'rationale: string (max 2 sentences)',
    'warnings: string[] (empty if none)',
    'optimizedPrompt must begin with: You are ',
    'Original custom persona:',
    '{{source}}',
  ].join('\n'),
  optimizerRetryTemplateScenario: [
    'Previous output was invalid. Retry now.',
    'Return exactly one valid JSON object only.',
    'No markdown, no code fences, no extra keys.',
    'Preserve all original scenario constraints and boundaries.',
    'Do not inject ethical/legal/safety policy language unless present in source.',
    'If no meaningful improvement is possible, set optimizedPrompt to the original scenario text.',
    'Output contract:',
    'optimizedPrompt: string (non-empty)',
    'rationale: string (max 2 sentences)',
    'warnings: string[] (empty if none)',
    'Original scenario block:',
    '{{source}}',
  ].join('\n'),
  optimizerRepairTemplate: [
    'Convert the raw optimizer output into one valid JSON object.',
    'Return JSON only, with no surrounding text.',
    'Normalize to exactly these keys:',
    'optimizedPrompt: string',
    'rationale: string',
    'warnings: string[]',
    'If a field is missing, infer it conservatively from the raw output.',
    'Raw output:',
    '{{rawOutput}}',
  ].join('\n'),
} satisfies OptimizerConfig

export const optimizerConfig: OptimizerConfig = {
  optimizerSystemPromptSystem: fallback(
    xDevSystemPrompt,
    defaults.optimizerSystemPromptSystem,
  ),
  optimizerSystemPromptPersona: fallback(
    xDevPersonaPrompt,
    defaults.optimizerSystemPromptPersona,
  ),
  optimizerSystemPromptScenario: fallback(
    xDevScenarioPrompt,
    defaults.optimizerSystemPromptScenario,
  ),
  optimizerInstructionTemplateSystem: defaults.optimizerInstructionTemplateSystem,
  optimizerInstructionTemplatePersona: defaults.optimizerInstructionTemplatePersona,
  optimizerInstructionTemplateScenario: defaults.optimizerInstructionTemplateScenario,
  optimizerRetryTemplateSystem: defaults.optimizerRetryTemplateSystem,
  optimizerRetryTemplatePersona: defaults.optimizerRetryTemplatePersona,
  optimizerRetryTemplateScenario: defaults.optimizerRetryTemplateScenario,
  optimizerRepairTemplate: defaults.optimizerRepairTemplate,
}

export const buildOptimizerInstruction = (target: 'system' | 'persona' | 'scenario', source: string): string =>
  renderTemplate(
    target === 'persona'
      ? optimizerConfig.optimizerInstructionTemplatePersona
      : target === 'scenario'
        ? optimizerConfig.optimizerInstructionTemplateScenario
        : optimizerConfig.optimizerInstructionTemplateSystem,
    { source },
  )

export const buildOptimizerRetryInstruction = (target: 'system' | 'persona' | 'scenario', source: string): string =>
  renderTemplate(
    target === 'persona'
      ? optimizerConfig.optimizerRetryTemplatePersona
      : target === 'scenario'
        ? optimizerConfig.optimizerRetryTemplateScenario
        : optimizerConfig.optimizerRetryTemplateSystem,
    { source },
  )

export const buildOptimizerRepairInstruction = (rawOutput: string): string =>
  renderTemplate(optimizerConfig.optimizerRepairTemplate, { rawOutput: rawOutput || '[empty]' })

export const getOptimizerSystemPrompt = (target: 'system' | 'persona' | 'scenario'): string =>
  target === 'persona'
    ? optimizerConfig.optimizerSystemPromptPersona
    : target === 'scenario'
      ? optimizerConfig.optimizerSystemPromptScenario
      : optimizerConfig.optimizerSystemPromptSystem
