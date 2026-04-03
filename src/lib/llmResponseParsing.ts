export type JsonParsePath = 'direct' | 'fenced' | 'substring'

export const extractTextFromChatResponse = (payload: Record<string, unknown>): string => {
  if (typeof payload.output_text === 'string') return payload.output_text
  if (typeof payload.text === 'string') return payload.text

  const output = payload.output
  if (!Array.isArray(output)) return ''

  let combined = ''
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const maybeItem = item as Record<string, unknown>
    const content = maybeItem.content

    if (typeof content === 'string') {
      combined += content
      continue
    }
    if (!Array.isArray(content)) continue

    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const maybePart = part as Record<string, unknown>
      if (typeof maybePart.content === 'string') {
        combined += maybePart.content
      }
      if (typeof maybePart.text === 'string') {
        combined += maybePart.text
      }
    }
  }

  return combined.trim()
}

export const parseJsonWithPath = (
  raw: string,
): { value: unknown; parsePath: JsonParsePath } | null => {
  try {
    return { value: JSON.parse(raw), parsePath: 'direct' }
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
    if (fenced) {
      try {
        return { value: JSON.parse(fenced), parsePath: 'fenced' }
      } catch {
        // continue
      }
    }

    const firstBrace = raw.indexOf('{')
    const lastBrace = raw.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return { value: JSON.parse(raw.slice(firstBrace, lastBrace + 1)), parsePath: 'substring' }
      } catch {
        // continue
      }
    }
  }

  return null
}

export const parseJsonLoose = (raw: string): unknown => parseJsonWithPath(raw)?.value ?? null
