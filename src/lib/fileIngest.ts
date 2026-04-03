import type { FileChunk, FileIngestJob, MemoryGraphState } from '../types/chat'
import type { LmStudioClient } from './lmStudioClient'
import { extractFactsWithModel, mergeFactsWithConflicts } from './memoryGraph'

const MAX_FILES = 5
const MAX_FILE_SIZE = 2 * 1024 * 1024
const CHUNK_SIZE = 1200
const CHUNK_OVERLAP = 150

const uid = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

const extension = (name: string): string => {
  const parts = name.toLowerCase().split('.')
  return parts.length > 1 ? parts.pop() ?? '' : ''
}

const parseCsvRows = (raw: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  const normalized = raw.replace(/\r\n/g, '\n')

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      row.push(cell)
      cell = ''
      continue
    }

    if (char === '\n' && !inQuotes) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }

    cell += char
  }

  row.push(cell)
  rows.push(row)
  return rows
}

const normalizeCsv = (raw: string): string => {
  const rows = parseCsvRows(raw)
    .map((cells) => cells.map((cell) => cell.trim()).filter(Boolean).join(' | '))
    .filter(Boolean)
  return rows.join('\n')
}

const parseFileText = (fileName: string, raw: string): string => {
  const ext = extension(fileName)
  if (ext === 'csv') return normalizeCsv(raw)
  return raw.replace(/\r\n/g, '\n')
}

export const chunkText = (
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): FileChunk[] => {
  const trimmed = text.trim()
  if (!trimmed) return []

  const chunks: FileChunk[] = []
  let cursor = 0
  let index = 0
  while (cursor < trimmed.length) {
    const end = Math.min(trimmed.length, cursor + chunkSize)
    chunks.push({
      id: `chunk-${index}`,
      fileId: '',
      fileName: '',
      index,
      text: trimmed.slice(cursor, end),
    })
    if (end >= trimmed.length) break
    cursor = Math.max(0, end - overlap)
    index += 1
  }
  return chunks
}

const validateFiles = (files: File[]): { valid: File[]; errors: string[] } => {
  const errors: string[] = []
  const valid: File[] = []
  const accepted = new Set(['txt', 'md', 'csv'])
  if (files.length > MAX_FILES) {
    errors.push(`Only up to ${MAX_FILES} files are allowed per drop.`)
  }

  for (const file of files.slice(0, MAX_FILES)) {
    const ext = extension(file.name)
    if (!accepted.has(ext)) {
      errors.push(`${file.name}: unsupported file type`)
      continue
    }
    if (file.size > MAX_FILE_SIZE) {
      errors.push(`${file.name}: file exceeds ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB limit`)
      continue
    }
    valid.push(file)
  }

  return { valid, errors }
}

export const ingestDroppedFiles = async (params: {
  files: File[]
  model: string
  client: LmStudioClient
  graph: MemoryGraphState
  getGraph?: () => MemoryGraphState
  onGraphUpdate?: (graph: MemoryGraphState) => void
  onJobUpdate?: (job: FileIngestJob) => void
  onDebug?: (message: string) => void
}): Promise<{ graph: MemoryGraphState; jobs: FileIngestJob[]; errors: string[]; addedFacts: number }> => {
  const { valid, errors } = validateFiles(params.files)
  let graph = params.graph
  let addedFacts = 0
  const jobs: FileIngestJob[] = []

  for (const file of valid) {
    const fileId = uid()
    const raw = await file.text()
    const parsed = parseFileText(file.name, raw)
    const chunks = chunkText(parsed).map((chunk) => ({
      ...chunk,
      fileId,
      fileName: file.name,
      id: `${fileId}:${chunk.index}`,
    }))

    const job: FileIngestJob = {
      id: fileId,
      fileName: file.name,
      totalChunks: chunks.length,
      processedChunks: 0,
      status: 'queued',
    }
    jobs.push(job)
    params.onJobUpdate?.(job)

    try {
      job.status = 'processing'
      params.onJobUpdate?.({ ...job })

      for (const chunk of chunks) {
        const extraction = await extractFactsWithModel(params.client, params.model, chunk.text)
        const baseGraph = params.getGraph?.() ?? graph
        const merged = mergeFactsWithConflicts(
          baseGraph,
          extraction.extraction,
          `file:${chunk.fileId}:${chunk.index}`,
          {
            sourceType: 'file',
            sourceRef: {
              fileId: chunk.fileId,
              fileName: chunk.fileName,
            },
          },
        ).graph
        addedFacts += Math.max(0, merged.facts.length - baseGraph.facts.length)
        graph = merged
        params.onGraphUpdate?.(merged)
        job.processedChunks += 1
        params.onDebug?.(
          `[file-ingest] ${file.name} chunk ${job.processedChunks}/${job.totalChunks} extracted=${extraction.extraction.facts.length}`,
        )
        params.onJobUpdate?.({ ...job })
      }

      job.status = 'done'
      params.onJobUpdate?.({ ...job })
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : 'file ingest failed'
      errors.push(`${file.name}: ${job.error}`)
      params.onJobUpdate?.({ ...job })
    }
  }

  return { graph, jobs, errors, addedFacts }
}
