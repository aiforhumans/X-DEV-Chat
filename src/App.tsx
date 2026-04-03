import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import './App.css'
import { BrainSidebar } from './components/BrainSidebar'
import { ChatWorkspace } from './components/ChatWorkspace'
import { DebugDrawer } from './components/DebugDrawer'
import { OptimizerPreviewModal } from './components/OptimizerPreviewModal'
import { VectorVisualizationModal } from './components/VectorVisualizationModal'
import { autoResizeTextarea, useAutoResizeTextarea } from './hooks/useAutoResizeTextarea'
import {
  clearEpisodes,
  DEFAULT_SESSION_ID,
  loadMemoryGraph,
  loadMessages,
  migrateLocalStateToDexieOnce,
  resetProfileTurnCounter,
  saveMemoryGraph,
  saveMessages,
  setEpisodeCursor,
} from './db/database'
import { applyStreamEvent, extractResponseId, initialAccumulator } from './lib/chatStream'
import {
  createMemoryQueue,
  enqueueEpisodeSummary,
  findRelevantEpisodes,
  runProfileExtractionCycle,
  WORKING_MEMORY_LIMIT,
} from './lib/episodicMemory'
import { ingestDroppedFiles } from './lib/fileIngest'
import {
  buildEpisodicContextBlock,
  buildWorkingMemoryInput,
  extractUserFactsNlFirst,
} from './lib/memoryIntelligence'
import { LmStudioClient } from './lib/lmStudioClient'
import {
  analyzeAndMergeVectorMemories,
  buildMemoryContext,
  clearFileFacts,
  clearMemoryGraph,
  deleteFact,
  mergeHybridCandidates,
  mergeFactsWithConflicts,
  prefilterFacts,
  RECALL_LIMIT,
  rerankFactsWithModel,
  resolveConflict,
} from './lib/memoryGraph'
import { buildPersonaPrompt, composeSystemPrompt, defaultPersonaMode } from './lib/personaMode'
import { DEFAULT_BASE_URL, loadPersistedState, loadUiState, saveUiState } from './lib/persistence'
import { getOptimizerSystemPrompt } from './lib/optimizerConfig'
import {
  getEmbeddingError,
  getLmStudioEmbeddingModel,
  getEmbeddingStatus,
  initializeEmbeddings,
  probeApiEmbeddings,
  setLmStudioEmbeddingModel,
  semanticPrefilterFacts,
} from './lib/semanticSearch'
import { optimizeCustomPersona, optimizeScenarioPrompt, optimizeSystemPrompt } from './lib/systemPromptOptimizer'
import {
  buildVectorExportBlob,
  buildVectorExportPayload,
  type VectorExportFormat,
} from './lib/vectorExport'
import { formatDateTime } from './lib/dateFormatting'
import type {
  ChatMessage,
  EmbeddingStatus,
  FileIngestJob,
  MemoryFact,
  MemoryGraphState,
  ModelInfo,
  PersonaModeState,
  StreamEvent,
  SystemPromptOptimizationResult,
} from './types/chat'
import type { BrainDebugEntry } from './types/debug'

const uid = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
const DEFAULT_MEMORY_MODEL_ID = 'liquid/lfm2.5-1.2b'
type MobilePanel = 'settings' | 'chat' | 'brain'

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong'

const emptyGraph = (): MemoryGraphState => ({
  facts: [],
  evidence: [],
  aliases: [],
  conflicts: [],
  vectorIndex: [],
})

const isModelLoaded = (model: ModelInfo): boolean =>
  Boolean(model.loaded) || (Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0)

const isEmbeddingModel = (model: ModelInfo): boolean => {
  if (model.type === 'embedding') return true
  const id = `${model.id || ''} ${model.key || ''}`.toLowerCase()
  return id.includes('embedding') || id.includes('embed')
}

function App() {
  const legacyPersistedSnapshot = useMemo(() => loadPersistedState(), [])
  const persisted = useMemo(() => loadUiState(), [])
  const initialTheme = useMemo<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    const stored = localStorage.getItem('lmstudio-theme')
    if (stored === 'light' || stored === 'dark') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }, [])
  const [baseUrl, setBaseUrl] = useState<string>(persisted.baseUrl || DEFAULT_BASE_URL)
  const [baseUrlDraft, setBaseUrlDraft] = useState<string>(persisted.baseUrl || DEFAULT_BASE_URL)
  const [selectedModel, setSelectedModel] = useState<string>(persisted.selectedModel)
  const [selectedBrainModel, setSelectedBrainModel] = useState<string>(
    persisted.brainModel || DEFAULT_MEMORY_MODEL_ID,
  )
  const [selectedEmbedModel, setSelectedEmbedModel] = useState<string>(
    persisted.embedModel || getLmStudioEmbeddingModel(),
  )
  const [systemPrompt, setSystemPrompt] = useState<string>(persisted.systemPrompt || '')
  const [scenarioPrompt, setScenarioPrompt] = useState<string>(persisted.scenarioPrompt || '')
  const [lastOptimizationMeta, setLastOptimizationMeta] = useState<{ at: string; model: string } | undefined>(
    persisted.lastOptimizationMeta,
  )
  const [personaMode, setPersonaMode] = useState<PersonaModeState>(persisted.personaMode ?? defaultPersonaMode())
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [memoryGraph, setMemoryGraph] = useState<MemoryGraphState>(emptyGraph())
  const [lastResponseId, setLastResponseId] = useState<string | null>(persisted.lastResponseId)
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(persisted.lastFailedPrompt)
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [statusLine, setStatusLine] = useState('Idle')
  const [connection, setConnection] = useState<'unknown' | 'online' | 'offline'>('unknown')
  const [errorBanner, setErrorBanner] = useState('')
  const [showReasoningById, setShowReasoningById] = useState<Record<string, boolean>>({})
  const [showEvidenceByFactId, setShowEvidenceByFactId] = useState<Record<string, boolean>>({})
  const [hydratedFromDb, setHydratedFromDb] = useState(false)
  const [memoryStatus, setMemoryStatus] = useState('Idle')
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus>('idle')
  const [vectorExportFormat, setVectorExportFormat] = useState<VectorExportFormat>('geojson')
  const [fileJobs, setFileJobs] = useState<FileIngestJob[]>([])
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('chat')
  const [episodeStatus, setEpisodeStatus] = useState('Idle')
  const [profileStatus, setProfileStatus] = useState('Idle')
  const [optimizerStatus, setOptimizerStatus] = useState<'idle' | 'optimizing' | 'ready' | 'failed'>('idle')
  const [personaOptimizerStatus, setPersonaOptimizerStatus] = useState<'idle' | 'optimizing' | 'ready' | 'failed'>(
    'idle',
  )
  const [scenarioOptimizerStatus, setScenarioOptimizerStatus] = useState<'idle' | 'optimizing' | 'ready' | 'failed'>(
    'idle',
  )
  const [optimizerPreview, setOptimizerPreview] = useState<{
    target: 'system' | 'persona' | 'scenario'
    currentPrompt: string
    result: SystemPromptOptimizationResult
  } | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [vectorVisualizationOpen, setVectorVisualizationOpen] = useState(false)
  const [debugEntries, setDebugEntries] = useState<BrainDebugEntry[]>([])
  const systemPromptRef = useRef<HTMLTextAreaElement>(null)
  const scenarioPromptRef = useRef<HTMLTextAreaElement>(null)
  const personaTextRef = useRef<HTMLTextAreaElement>(null)
  const sendInFlightRef = useRef(false)
  const fileIngestInFlightRef = useRef(false)
  const memoryQueueRef = useRef(createMemoryQueue())
  const memoryGraphRef = useRef(memoryGraph)

  const client = useMemo(() => new LmStudioClient(baseUrl), [baseUrl])
  const memoryModelId = selectedBrainModel
  const memoryTaskModel = useMemo(() => {
    const configured = memoryModelId.trim()
    if (!configured) return selectedModel
    return configured
  }, [memoryModelId, selectedModel])
  const optimizerSystemPromptFor = (target: 'system' | 'persona' | 'scenario'): string =>
    getOptimizerSystemPrompt(target)

  useEffect(() => {
    setLmStudioEmbeddingModel(selectedEmbedModel)
  }, [selectedEmbedModel])

  useEffect(() => {
    setEmbeddingStatus(getEmbeddingStatus())
  }, [])

  useEffect(() => {
    memoryGraphRef.current = memoryGraph
  }, [memoryGraph])

  useEffect(() => {
    setBaseUrlDraft(baseUrl)
  }, [baseUrl])

  useAutoResizeTextarea(systemPromptRef, systemPrompt)
  useAutoResizeTextarea(scenarioPromptRef, scenarioPrompt)
  useAutoResizeTextarea(personaTextRef, personaMode.personaText)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await migrateLocalStateToDexieOnce(legacyPersistedSnapshot)
      const [dbMessages, dbGraph] = await Promise.all([
        loadMessages(DEFAULT_SESSION_ID),
        loadMemoryGraph(),
      ])
      if (cancelled) return
      if (dbMessages.length > 0) {
        setMessages(dbMessages)
      }
      if (dbGraph.facts.length > 0 || dbGraph.evidence.length > 0 || dbGraph.conflicts.length > 0) {
        setMemoryGraph(dbGraph)
      }
      setHydratedFromDb(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    saveUiState({
      baseUrl,
      selectedModel,
      brainModel: selectedBrainModel,
      embedModel: selectedEmbedModel,
      systemPrompt,
      scenarioPrompt,
      lastOptimizationMeta,
      personaMode,
      lastResponseId,
      lastFailedPrompt,
    })
  }, [
    baseUrl,
    selectedModel,
    selectedBrainModel,
    selectedEmbedModel,
    systemPrompt,
    scenarioPrompt,
    lastOptimizationMeta,
    personaMode,
    lastResponseId,
    lastFailedPrompt,
  ])

  useEffect(() => {
    if (!hydratedFromDb) return
    void saveMessages(DEFAULT_SESSION_ID, messages)
  }, [hydratedFromDb, messages])

  useEffect(() => {
    if (!hydratedFromDb) return
    void saveMemoryGraph(memoryGraph)
  }, [hydratedFromDb, memoryGraph])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('lmstudio-theme', theme)
  }, [theme])

  const chatModels = useMemo(() => models.filter((model) => !isEmbeddingModel(model)), [models])
  const brainModels = chatModels
  const brainOptions = useMemo(() => {
    if (brainModels.length > 0) return brainModels
    if (!selectedBrainModel) return []
    return [{ id: selectedBrainModel }] as ModelInfo[]
  }, [brainModels, selectedBrainModel])
  const embeddingModels = useMemo(() => models.filter((model) => isEmbeddingModel(model)), [models])
  const embeddingOptions = useMemo(() => {
    if (embeddingModels.length > 0) return embeddingModels
    if (!selectedEmbedModel) return []
    return [{ id: selectedEmbedModel }] as ModelInfo[]
  }, [embeddingModels, selectedEmbedModel])

  const isMainModelLoaded = useMemo(() => {
    const model = models.find((item) => item.id === selectedModel || item.key === selectedModel)
    return Boolean(model && isModelLoaded(model))
  }, [models, selectedModel])

  const isBrainModelLoaded = useMemo(() => {
    const model = models.find((item) => item.id === selectedBrainModel || item.key === selectedBrainModel)
    return Boolean(model && isModelLoaded(model))
  }, [models, selectedBrainModel])

  const isEmbeddingCompanionLoaded = useMemo(() => {
    const embedding = models.find((model) => model.id === selectedEmbedModel || model.key === selectedEmbedModel)
    return Boolean(embedding && isModelLoaded(embedding))
  }, [models, selectedEmbedModel])

  const sortedFacts = useMemo(
    () => [...memoryGraph.facts].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [memoryGraph.facts],
  )

  const fileDerivedFactCount = useMemo(
    () => memoryGraph.facts.filter((fact) => fact.sourceTags.includes('file')).length,
    [memoryGraph.facts],
  )

  const vectorMemoryCount = useMemo(() => memoryGraph.vectorIndex?.length ?? 0, [memoryGraph.vectorIndex])

  const evidenceByFactId = useMemo(() => {
    const map = new Map<string, typeof memoryGraph.evidence>()
    for (const item of memoryGraph.evidence) {
      const current = map.get(item.factId) ?? []
      current.push(item)
      map.set(item.factId, current)
    }
    for (const [key, value] of map.entries()) {
      value.sort((a, b) => new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime())
      map.set(key, value)
    }
    return map
  }, [memoryGraph.evidence])

  const applyBaseUrl = (): void => {
    const normalized = baseUrlDraft.trim() || DEFAULT_BASE_URL
    if (normalized === baseUrl) return
    setBaseUrl(normalized)
    setConnection('unknown')
    setErrorBanner('')
    setStatusLine(`LM Studio URL updated to ${normalized}`)
  }

  const refreshModels = async (): Promise<ModelInfo[]> => {
    try {
      setStatusLine('Fetching models...')
      const listed = await client.listModels()
      setModels(listed)
      setConnection('online')
      setErrorBanner('')
      const firstChatModel = listed.find((model) => !isEmbeddingModel(model))
      const firstEmbeddingModel =
        listed.find((model) => model.id === selectedEmbedModel || model.key === selectedEmbedModel) ??
        listed.find((model) => isEmbeddingModel(model))
      const firstBrainModel =
        listed.find((model) => model.id === selectedBrainModel || model.key === selectedBrainModel) ??
        firstChatModel

      if (!selectedModel && firstChatModel) {
        setSelectedModel(firstChatModel.id)
      }
      if (!selectedBrainModel && firstBrainModel) {
        setSelectedBrainModel(firstBrainModel.id)
      }
      if (!selectedEmbedModel && firstEmbeddingModel) {
        setSelectedEmbedModel(firstEmbeddingModel.id)
      }
      setStatusLine('Models refreshed')
      return listed
    } catch (error) {
      setConnection('offline')
      setErrorBanner(`Connection error: ${toErrorMessage(error)}`)
      setStatusLine('Unable to reach LM Studio')
      return []
    }
  }

  useEffect(() => {
    void refreshModels()
  }, [baseUrl])

  const appendAssistantEvent = (assistantId: string, updater: (msg: ChatMessage) => ChatMessage): void => {
    setMessages((current) =>
      current.map((msg) => {
        if (msg.id !== assistantId) return msg
        return updater(msg)
      }),
    )
  }

  const pushDebug = (entry: Omit<BrainDebugEntry, 'id' | 'at'>): void => {
    setDebugEntries((current) => [
      { id: uid(), at: new Date().toISOString(), ...entry },
      ...current,
    ].slice(0, 60))
  }

  const runMemoryExtraction = async (
    userText: string,
    sourceMessageId: string,
    context?: { previousUserMessage?: string; previousAssistantMessage?: string },
  ): Promise<void> => {
    if (!memoryTaskModel) return

    setMemoryStatus('Extracting')

    const analysis = await extractUserFactsNlFirst({
      client,
      model: memoryTaskModel,
      userText,
      context,
    })

    const { extraction } = analysis
    pushDebug({
      kind: 'extract',
      model: memoryTaskModel,
      status: analysis.usedFallback ? 'json-fallback' : 'nl',
      prompt: userText,
      selectedCount: extraction.facts.length,
      raw: analysis.rawText,
      error: analysis.error,
      parsePath: analysis.parseMode,
      personaEnabled: personaMode.enabled,
      personaIntensity: personaMode.intensity,
      personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
    })
    if (extraction.facts.length === 0) {
      setMemoryStatus('No durable facts detected')
      return
    }

    const baseGraph = memoryGraphRef.current
    const before = baseGraph.facts.length
    const merged = mergeFactsWithConflicts(baseGraph, extraction, sourceMessageId)
    const factDelta = merged.graph.facts.length - before
    const conflictDetected = merged.conflictDetected

    memoryGraphRef.current = merged.graph
    setMemoryGraph(merged.graph)

    if (conflictDetected) {
      setMemoryStatus(analysis.usedFallback ? 'Conflict detected (json fallback)' : 'Conflict detected')
      return
    }

    if (analysis.usedFallback) {
      setMemoryStatus(factDelta > 0 ? `JSON fallback (+${factDelta})` : 'JSON fallback')
      return
    }

    setMemoryStatus(factDelta > 0 ? `Merged (+${factDelta})` : 'Merged')
  }

  const sendMessage = async (
    rawPrompt?: string,
    options?: {
      includeUserMessage?: boolean
      previousResponseIdOverride?: string | null
      forceFreshSample?: boolean
    },
  ): Promise<void> => {
    const includeUserMessage = options?.includeUserMessage ?? true
    const previousResponseIdForTurn =
      options?.previousResponseIdOverride === undefined ? lastResponseId : options.previousResponseIdOverride
    const prompt = (rawPrompt ?? input).trim()
    if (!prompt || isStreaming || sendInFlightRef.current) return
    if (!selectedModel) {
      setErrorBanner('Select a model first')
      return
    }
    sendInFlightRef.current = true

    try {
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
    }
    const previousUserMessage = [...messages].reverse().find((item) => item.role === 'user')?.content
    const previousAssistantMessage = [...messages].reverse().find((item) => item.role === 'assistant')?.content
    const workingInput = buildWorkingMemoryInput(messages, prompt, WORKING_MEMORY_LIMIT)

    const semanticInfo = await semanticPrefilterFacts({
      graph: memoryGraph,
      prompt,
      limit: 20,
      client,
      allowApiFallback: false,
    })
    const graphForRetrieval = semanticInfo.graph ?? memoryGraph
    if (semanticInfo.graph) {
      setMemoryGraph(semanticInfo.graph)
    }
    const lexicalShortlist = prefilterFacts(graphForRetrieval, prompt)
    const currentEmbeddingStatus = getEmbeddingStatus()
    const resolvedEmbeddingStatus: EmbeddingStatus = semanticInfo.provider
      ? 'ready'
      : semanticInfo.usedFallback
        ? 'failed'
        : embeddingStatus === 'ready'
          ? 'ready'
          : currentEmbeddingStatus
    setEmbeddingStatus(resolvedEmbeddingStatus)
    pushDebug({
      kind: 'embed',
      model:
        semanticInfo.provider === 'api'
          ? getLmStudioEmbeddingModel()
          : semanticInfo.provider === 'hash'
            ? 'LocalHash/256'
            : 'Xenova/all-MiniLM-L6-v2',
      status: semanticInfo.usedFallback ? 'fallback' : semanticInfo.provider ?? 'ok',
      prompt,
      shortlistCount: semanticInfo.results.length,
      selectedCount: lexicalShortlist.length,
      raw: semanticInfo.usedFallback
        ? semanticInfo.error ?? 'semantic fallback'
        : `provider=${semanticInfo.provider ?? 'browser'} semantic=${semanticInfo.results.length} lexical=${lexicalShortlist.length} vectors+${semanticInfo.embeddedCount ?? 0}`,
      embeddingStatus: resolvedEmbeddingStatus,
      error: semanticInfo.error,
      personaEnabled: personaMode.enabled,
      personaIntensity: personaMode.intensity,
      personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
    })

    const shortlist = mergeHybridCandidates(semanticInfo.results, lexicalShortlist, 20)
    const personaContext = buildPersonaPrompt(personaMode)
    const episodicInfo = await findRelevantEpisodes({
      sessionId: DEFAULT_SESSION_ID,
      prompt,
      client,
      topK: 3,
    })
    const episodicContextBlock = buildEpisodicContextBlock(episodicInfo.episodes)
    setEpisodeStatus(
      episodicInfo.episodes.length > 0
        ? `Context ${episodicInfo.episodes.length} (${episodicInfo.provider})`
        : 'No episodic match',
    )
    pushDebug({
      kind: 'episode-summary',
      model: selectedModel,
      status: episodicInfo.episodes.length > 0 ? 'retrieved' : 'empty',
      prompt,
      shortlistCount: episodicInfo.episodes.length,
      selectedCount: episodicInfo.episodes.length,
      raw: episodicInfo.episodes.map((episode) => episode.summary).join('\n'),
      error: episodicInfo.error,
      personaEnabled: personaContext.personaEnabled,
      personaIntensity: personaContext.intensity,
      personaBlockLength: personaContext.personaBlock.length,
    })
    let selectedFacts: MemoryFact[] = shortlist.map((item) => item.fact).slice(0, RECALL_LIMIT)

    if (shortlist.length > 0) {
      const rerankInfo = await rerankFactsWithModel(
        client,
        selectedModel,
        prompt,
        shortlist.map((item) => item.fact),
      )
      const rerank = rerankInfo.result
      pushDebug({
        kind: 'rerank',
        model: selectedModel,
        status: rerank ? 'ok' : 'fallback',
        prompt,
        shortlistCount: shortlist.length,
        selectedCount: rerank?.selectedFactIds.length ?? 0,
        raw: rerankInfo.rawText,
        error: rerankInfo.error,
        personaEnabled: personaContext.personaEnabled,
        personaIntensity: personaContext.intensity,
        personaBlockLength: personaContext.personaBlock.length,
      })

      if (rerank && rerank.selectedFactIds.length > 0) {
        const byId = new Map(shortlist.map((item) => [item.fact.id, item.fact]))
        selectedFacts = rerank.selectedFactIds
          .map((id) => byId.get(id))
          .filter((fact): fact is MemoryFact => Boolean(fact))
          .slice(0, RECALL_LIMIT)
        if (selectedFacts.length > 0) {
          setMemoryStatus('Reranked')
        }
      }
    }

    const recall = buildMemoryContext(selectedFacts)
    const fullSystemPrompt = composeSystemPrompt([
      systemPrompt.trim(),
      personaContext.personaBlock,
      scenarioPrompt.trim() ? `Scenario Block:\n${scenarioPrompt.trim()}` : '',
      recall.contextBlock,
      episodicContextBlock,
    ])

    const assistantId = uid()
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      partial: true,
      sourcePrompt: prompt,
      parentResponseId: previousResponseIdForTurn ?? null,
    }

    setMessages((current) => [...current, ...(includeUserMessage ? [userMessage] : []), assistantMessage])
    setInput('')
    setIsStreaming(true)
    setErrorBanner('')
    setLastFailedPrompt(null)
    let streamState = initialAccumulator()
    let streamResponseId: string | null = null

    const applyEvent = (event: StreamEvent): void => {
      streamState = applyStreamEvent(streamState, event)
      setStatusLine(streamState.statusLine || 'Streaming...')
      const maybeResponseId = extractResponseId(event)
      if (maybeResponseId) {
        streamResponseId = maybeResponseId
      }

      appendAssistantEvent(assistantId, (msg) => ({
        ...msg,
        content: streamState.messageText,
        reasoning: streamState.reasoningText,
        responseId: streamResponseId ?? msg.responseId,
      }))
    }

    const request = {
      model: selectedModel,
      input: workingInput,
      system_prompt: fullSystemPrompt || undefined,
      previous_response_id: previousResponseIdForTurn ?? undefined,
      store: true,
      stream: true,
      ...(options?.forceFreshSample
        ? {
            temperature: 0.9,
            top_p: 0.95,
          }
        : {}),
    }

      await client.streamChat(
        request,
        {
        onEvent: applyEvent,
        onComplete: () => {
          const finalAssistantMessage: ChatMessage = {
            id: assistantId,
            role: 'assistant',
            content: streamState.messageText || '[No message content]',
            createdAt: assistantMessage.createdAt,
            reasoning: streamState.reasoningText,
            partial: false,
            responseId: streamResponseId ?? undefined,
            sourcePrompt: prompt,
            parentResponseId: previousResponseIdForTurn ?? null,
          }

          const postTurnMessages = [...messages, ...(includeUserMessage ? [userMessage] : []), finalAssistantMessage]
          appendAssistantEvent(assistantId, (msg) => ({
            ...msg,
            partial: false,
            content: msg.content || '[No message content]',
          }))
          if (streamResponseId) {
            setLastResponseId(streamResponseId)
          }
          setStatusLine('Response complete')
          setIsStreaming(false)
          if (includeUserMessage) {
            void runMemoryExtraction(prompt, userMessage.id, {
              previousUserMessage,
              previousAssistantMessage,
            })

            void memoryQueueRef.current.enqueue(async () => {
              try {
                const episodeResult = await enqueueEpisodeSummary({
                  sessionId: DEFAULT_SESSION_ID,
                  messages: postTurnMessages,
                  client,
                  model: memoryTaskModel,
                })
                if (!episodeResult.skipped && episodeResult.episode) {
                  setEpisodeStatus(`Summarized chunk (${episodeResult.embeddingProvider ?? 'unknown'})`)
                } else if (episodeResult.reason === 'not-enough-messages') {
                  setEpisodeStatus('Waiting for enough history')
                }
                pushDebug({
                  kind: 'episode-summary',
                  model: memoryTaskModel,
                  status: episodeResult.skipped ? 'skipped' : 'stored',
                  raw: episodeResult.episode?.summary ?? episodeResult.reason ?? '[none]',
                  error: episodeResult.reason === 'empty-summary' ? 'empty summary' : undefined,
                  personaEnabled: personaMode.enabled,
                  personaIntensity: personaMode.intensity,
                  personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
                })
              } catch (episodeError) {
                setEpisodeStatus('Episode summary failed')
                pushDebug({
                  kind: 'episode-summary',
                  model: memoryTaskModel,
                  status: 'failed',
                  raw: '',
                  error: toErrorMessage(episodeError),
                  personaEnabled: personaMode.enabled,
                  personaIntensity: personaMode.intensity,
                  personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
                })
              }

              try {
                const profileResult = await runProfileExtractionCycle({
                  sessionId: DEFAULT_SESSION_ID,
                  messages: postTurnMessages,
                  graph: memoryGraphRef.current,
                  client,
                  model: memoryTaskModel,
                })
                if (profileResult.ran) {
                  if (profileResult.factDelta !== 0) {
                    setMemoryGraph(profileResult.graph)
                    memoryGraphRef.current = profileResult.graph
                  }
                  setProfileStatus(
                    profileResult.result.lines.length > 0
                      ? `Updated (${profileResult.result.parseMode})`
                      : 'No new profile info',
                  )
                  pushDebug({
                    kind: 'profile-extract',
                    model: memoryTaskModel,
                    status: profileResult.result.usedFallback ? 'json-fallback' : 'nl',
                    selectedCount: profileResult.result.lines.length,
                    raw: profileResult.result.rawText,
                    parsePath: profileResult.result.parseMode,
                    error: profileResult.result.error,
                    personaEnabled: personaMode.enabled,
                    personaIntensity: personaMode.intensity,
                    personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
                  })
                }
              } catch (profileError) {
                setProfileStatus('Profile extract failed')
                pushDebug({
                  kind: 'profile-extract',
                  model: memoryTaskModel,
                  status: 'failed',
                  raw: '',
                  error: toErrorMessage(profileError),
                  personaEnabled: personaMode.enabled,
                  personaIntensity: personaMode.intensity,
                  personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
                })
              }
            })
          }
        },
        onError: (error) => {
          appendAssistantEvent(assistantId, (msg) => ({
            ...msg,
            partial: true,
            content: msg.content || '[Stream interrupted]',
          }))
          setLastFailedPrompt(prompt)
          setErrorBanner(`Stream error: ${error.message}`)
          setStatusLine('Stream interrupted')
          setIsStreaming(false)
        },
        },
      )
    } catch (error) {
      setErrorBanner(`Send failed: ${toErrorMessage(error)}`)
      setStatusLine('Send failed')
      setIsStreaming(false)
    } finally {
      sendInFlightRef.current = false
    }
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const loadModelById = async (modelId: string, label: string): Promise<void> => {
    if (!modelId) {
      setErrorBanner(`Pick a ${label} model to load`)
      return
    }
    try {
      setStatusLine(`Loading ${label} model: ${modelId}...`)
      await client.loadModel(modelId)
      await refreshModels()
      setStatusLine(`Loaded ${label} model: ${modelId}`)
    } catch (error) {
      setErrorBanner(`${label} load failed: ${toErrorMessage(error)}`)
      setStatusLine(`${label} model load failed`)
    }
  }

  const unloadModelById = async (modelId: string, label: string): Promise<void> => {
    if (!modelId) {
      setErrorBanner(`Pick a ${label} model to unload`)
      return
    }
    try {
      setStatusLine(`Unloading ${label} model: ${modelId}...`)
      await client.unloadModel(modelId)
      await refreshModels()
      setStatusLine(`Unloaded ${label} model: ${modelId}`)
    } catch (error) {
      setErrorBanner(`${label} unload failed: ${toErrorMessage(error)}`)
      setStatusLine(`${label} model unload failed`)
    }
  }

  const confirmDestructiveAction = (message: string): boolean => {
    if (typeof window === 'undefined') return true
    return window.confirm(message)
  }

  const clearChat = (): void => {
    const accepted = confirmDestructiveAction('Clear the current chat history? This cannot be undone.')
    if (!accepted) return
    setMessages([])
    setLastResponseId(null)
    setLastFailedPrompt(null)
    setShowReasoningById({})
    setEpisodeStatus('Idle')
    setProfileStatus('Idle')
    setStatusLine('New chat started')
    void (async () => {
      try {
        await Promise.all([
          setEpisodeCursor(DEFAULT_SESSION_ID, 0),
          resetProfileTurnCounter(DEFAULT_SESSION_ID),
          clearEpisodes(DEFAULT_SESSION_ID),
        ])
      } catch (error) {
        pushDebug({
          kind: 'episode-summary',
          model: memoryTaskModel || selectedModel || 'none',
          status: 'reset-failed',
          raw: '',
          error: toErrorMessage(error),
          embeddingStatus,
          personaEnabled: personaMode.enabled,
          personaIntensity: personaMode.intensity,
          personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
        })
      }
    })()
  }

  const lastAssistantMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role === 'assistant' && message.sourcePrompt) {
        return message
      }
    }
    return null
  }, [messages])

  const regenerateLastResponse = async (): Promise<void> => {
    if (isStreaming) return
    if (!lastAssistantMessage?.sourcePrompt) {
      setErrorBanner('No assistant response available to regenerate')
      return
    }

    setMessages((current) => current.filter((message) => message.id !== lastAssistantMessage.id))
    setLastResponseId(lastAssistantMessage.parentResponseId ?? null)
    setStatusLine('Regenerating...')
    await sendMessage(lastAssistantMessage.sourcePrompt, {
      includeUserMessage: false,
      previousResponseIdOverride: lastAssistantMessage.parentResponseId ?? null,
      forceFreshSample: true,
    })
  }

  const removeFact = (factId: string, canonicalText: string): void => {
    const previewText = canonicalText.length > 80 ? `${canonicalText.slice(0, 80)}…` : canonicalText
    const accepted = confirmDestructiveAction(`Delete this memory fact?\n\n"${previewText}"`)
    if (!accepted) return
    setMemoryGraph((current) => deleteFact(current, factId))
  }

  const clearAllMemories = (): void => {
    const accepted = confirmDestructiveAction('Clear all stored memories? This cannot be undone.')
    if (!accepted) return
    setMemoryGraph(clearMemoryGraph())
    setMemoryStatus('Idle')
  }

  const resolveConflictWinner = (conflictId: string, winnerFactId: string): void => {
    const accepted = confirmDestructiveAction('Apply this conflict winner selection?')
    if (!accepted) return
    setMemoryGraph((current) => resolveConflict(current, conflictId, winnerFactId))
    setMemoryStatus('Merged')
  }

  const clearFileDerivedFacts = (): void => {
    const accepted = confirmDestructiveAction('Clear all file-derived memory facts?')
    if (!accepted) return
    setMemoryGraph((current) => clearFileFacts(current))
    setMemoryStatus('File-derived memories cleared')
    pushDebug({
      kind: 'file',
      model: memoryTaskModel || selectedModel || 'none',
      status: 'cleared',
      raw: 'Cleared file-derived memory facts and evidence',
      embeddingStatus,
      personaEnabled: personaMode.enabled,
      personaIntensity: personaMode.intensity,
      personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
    })
  }

  const retryEmbeddings = async (): Promise<void> => {
    setEmbeddingStatus('loading')
    const status = await initializeEmbeddings(true)
    let resolvedStatus: EmbeddingStatus = status
    let error = status === 'failed' ? getEmbeddingError() : undefined

    if (status === 'failed') {
      try {
        await probeApiEmbeddings(client)
        resolvedStatus = 'ready'
        error = undefined
        setErrorBanner('')
      } catch (apiError) {
        resolvedStatus = 'failed'
        const apiMessage = apiError instanceof Error ? apiError.message : 'api embeddings failed'
        error = `${error || 'browser embeddings failed'} | ${apiMessage}`
        setErrorBanner(`Embeddings failed: ${error}`)
      }
    }

    setEmbeddingStatus(resolvedStatus)
    pushDebug({
      kind: 'embed',
      model: resolvedStatus === 'ready' && status === 'failed' ? getLmStudioEmbeddingModel() : 'Xenova/all-MiniLM-L6-v2',
      status: resolvedStatus,
      raw:
        resolvedStatus === 'ready'
          ? status === 'ready'
            ? 'Embeddings retry succeeded (browser provider)'
            : 'Embeddings retry succeeded (LM Studio API provider)'
          : 'Embeddings retry failed',
      embeddingStatus: resolvedStatus,
      error,
      personaEnabled: personaMode.enabled,
      personaIntensity: personaMode.intensity,
      personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
    })
  }

  const runAnalyzeAndMergeVectorMemories = async (): Promise<void> => {
    const snapshot = memoryGraphRef.current
    if (snapshot.facts.length < 2) {
      setMemoryStatus('Need at least 2 facts to analyze')
      return
    }

    setMemoryStatus('Analyzing vector memories...')
    setErrorBanner('')

    try {
      const promptSeed = snapshot.facts
        .filter((fact) => fact.status !== 'superseded')
        .slice(0, 8)
        .map((fact) => fact.canonicalText)
        .join(' | ') || 'memory vector analysis'

      const semanticInfo = await semanticPrefilterFacts({
        graph: snapshot,
        prompt: promptSeed,
        limit: 20,
        client,
        allowApiFallback: true,
      })

      const graphWithVectors = semanticInfo.graph ?? snapshot
      const mergeResult = analyzeAndMergeVectorMemories(graphWithVectors)
      const nextGraph = mergeResult.graph
      setMemoryGraph(nextGraph)
      memoryGraphRef.current = nextGraph

      const resolvedEmbeddingStatus: EmbeddingStatus = semanticInfo.provider
        ? 'ready'
        : semanticInfo.usedFallback
          ? 'failed'
          : embeddingStatus
      setEmbeddingStatus(resolvedEmbeddingStatus)

      if (semanticInfo.usedFallback && semanticInfo.error) {
        setErrorBanner(`Vector analysis fallback: ${semanticInfo.error}`)
      }

      setMemoryStatus(
        mergeResult.mergedPairs > 0
          ? `Vector merge complete (${mergeResult.mergedPairs} merged)`
          : 'Vector analysis complete (no merges)',
      )

      pushDebug({
        kind: 'embed',
        model:
          semanticInfo.provider === 'api'
            ? getLmStudioEmbeddingModel()
            : semanticInfo.provider === 'hash'
              ? 'LocalHash/256'
              : 'Xenova/all-MiniLM-L6-v2',
        status: mergeResult.mergedPairs > 0 ? 'vector-merged' : 'vector-analyzed',
        prompt: promptSeed,
        shortlistCount: semanticInfo.results.length,
        selectedCount: mergeResult.mergedPairs,
        raw: `provider=${semanticInfo.provider ?? 'unknown'} vectors+${semanticInfo.embeddedCount ?? 0} merged=${mergeResult.mergedPairs}`,
        embeddingStatus: resolvedEmbeddingStatus,
        error: semanticInfo.error,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    } catch (error) {
      const message = toErrorMessage(error)
      setMemoryStatus('Vector analysis failed')
      setErrorBanner(`Vector analysis failed: ${message}`)
      pushDebug({
        kind: 'embed',
        model: selectedEmbedModel || 'unknown',
        status: 'vector-merge-failed',
        raw: '',
        error: message,
        embeddingStatus,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    }
  }

  const exportVectorData = async (): Promise<void> => {
    try {
      const payload = buildVectorExportPayload(memoryGraphRef.current)
      if (payload.vectorCount === 0) {
        setErrorBanner('No vector data available to export')
        return
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const artifact = await buildVectorExportBlob(payload, vectorExportFormat)
      const fileName = `brain-vectors-${stamp}.${artifact.extension}`
      const blob = artifact.blob
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileName
      link.click()
      URL.revokeObjectURL(url)
      setStatusLine(`Exported ${payload.vectorCount} vectors as ${vectorExportFormat.toUpperCase()} to ${fileName}`)
      setMemoryStatus('Vector export complete')
    } catch (error) {
      const message = toErrorMessage(error)
      setErrorBanner(`Vector export failed: ${message}`)
      setStatusLine('Vector export failed')
    }
  }

  const upsertFileJob = (job: FileIngestJob): void => {
    setFileJobs((current) => {
      const index = current.findIndex((item) => item.id === job.id)
      if (index < 0) return [job, ...current].slice(0, 30)
      const next = [...current]
      next[index] = job
      return next
    })
  }

  const handleFileList = async (incomingFiles: FileList | File[]): Promise<void> => {
    if (!selectedBrainModel) {
      setErrorBanner('Select a brain model before file ingestion')
      return
    }
    if (fileIngestInFlightRef.current) {
      setErrorBanner('File ingest is already running')
      return
    }

    const files = Array.from(incomingFiles)
    if (files.length === 0) return
    fileIngestInFlightRef.current = true
    setStatusLine(`Ingesting ${files.length} file(s)...`)
    pushDebug({
      kind: 'file',
      model: memoryTaskModel,
      status: 'started',
      raw: `Starting file ingest for ${files.map((file) => file.name).join(', ')}`,
      embeddingStatus,
      personaEnabled: personaMode.enabled,
      personaIntensity: personaMode.intensity,
      personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
    })

    try {
      const result = await ingestDroppedFiles({
        files,
        model: memoryTaskModel,
        client,
        graph: memoryGraphRef.current,
        getGraph: () => memoryGraphRef.current,
        onGraphUpdate: (graph) => {
          memoryGraphRef.current = graph
          setMemoryGraph(graph)
        },
        onJobUpdate: upsertFileJob,
        onDebug: (message) => {
          pushDebug({
            kind: 'file',
            model: memoryTaskModel,
            status: 'processing',
            raw: message,
            embeddingStatus,
            personaEnabled: personaMode.enabled,
            personaIntensity: personaMode.intensity,
            personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
          })
        },
      })

      const addedFacts = result.addedFacts
      if (result.errors.length > 0) {
        setErrorBanner(`File ingest warnings: ${result.errors.join(' | ')}`)
      }
      setStatusLine('File ingest complete')
      setMemoryStatus(`File ingest done (+${addedFacts} facts)`)
      pushDebug({
        kind: 'file',
        model: memoryTaskModel,
        status: result.errors.length > 0 ? 'done-with-warnings' : 'done',
        raw: `jobs=${result.jobs.length} addedFacts=${addedFacts}${result.errors.length ? ` errors=${result.errors.join('; ')}` : ''}`,
        embeddingStatus,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    } catch (error) {
      const message = toErrorMessage(error)
      setErrorBanner(`File ingest failed: ${message}`)
      setStatusLine('File ingest failed')
      pushDebug({
        kind: 'file',
        model: memoryTaskModel,
        status: 'failed',
        raw: '',
        error: message,
        embeddingStatus,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    } finally {
      fileIngestInFlightRef.current = false
    }
  }

  const onSidebarTextareaInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    autoResizeTextarea(event.currentTarget)
  }

  const runOptimizeSystemPrompt = async (): Promise<void> => {
    if (isStreaming || !selectedModel) return
    const currentPrompt = systemPrompt
    if (!currentPrompt.trim()) {
      setErrorBanner('Add a system prompt before optimizing')
      return
    }

    setOptimizerStatus('optimizing')
    setErrorBanner('')
    pushDebug({
      kind: 'optimize',
      model: selectedModel,
      status: 'optimizing',
      raw: '',
      parsePath: 'start',
      optimizeTarget: 'system',
      optimizerSystemPromptUsed: optimizerSystemPromptFor('system'),
      chatSystemMessageSnapshot: systemPrompt,
      personaEnabled: personaMode.enabled,
      personaIntensity: personaMode.intensity,
      personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
    })

    try {
      const result = await optimizeSystemPrompt(client, selectedModel, currentPrompt)
      setOptimizerPreview({
        target: 'system',
        currentPrompt,
        result,
      })
      setOptimizerStatus('ready')
      pushDebug({
        kind: 'optimize',
        model: selectedModel,
        status: 'ready',
        raw: result.rawOutput,
        parsePath: result.parsePath,
        optimizeTarget: 'system',
        optimizerSystemPromptUsed: optimizerSystemPromptFor('system'),
        chatSystemMessageSnapshot: systemPrompt,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    } catch (error) {
      const message = toErrorMessage(error)
      setOptimizerStatus('failed')
      setErrorBanner(`Prompt optimize failed: ${message}`)
      pushDebug({
        kind: 'optimize',
        model: selectedModel,
        status: 'failed',
        raw: '',
        parsePath: 'failed',
        optimizeTarget: 'system',
        optimizerSystemPromptUsed: optimizerSystemPromptFor('system'),
        chatSystemMessageSnapshot: systemPrompt,
        error: message,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    }
  }

  const runOptimizePersona = async (): Promise<void> => {
    if (isStreaming || !selectedModel) return
    const currentPrompt = personaMode.personaText
    if (!currentPrompt.trim()) {
      setErrorBanner('Add custom persona text before optimizing')
      return
    }

    setPersonaOptimizerStatus('optimizing')
    setErrorBanner('')
    pushDebug({
      kind: 'optimize',
      model: selectedModel,
      status: 'optimizing',
      raw: '',
      parsePath: 'start',
      optimizeTarget: 'persona',
      optimizerSystemPromptUsed: optimizerSystemPromptFor('persona'),
      chatSystemMessageSnapshot: systemPrompt,
      personaEnabled: personaMode.enabled,
      personaIntensity: personaMode.intensity,
      personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
    })

    try {
      const result = await optimizeCustomPersona(client, selectedModel, currentPrompt)
      setOptimizerPreview({
        target: 'persona',
        currentPrompt,
        result,
      })
      setPersonaOptimizerStatus('ready')
      pushDebug({
        kind: 'optimize',
        model: selectedModel,
        status: 'ready',
        raw: result.rawOutput,
        parsePath: result.parsePath,
        optimizeTarget: 'persona',
        optimizerSystemPromptUsed: optimizerSystemPromptFor('persona'),
        chatSystemMessageSnapshot: systemPrompt,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    } catch (error) {
      const message = toErrorMessage(error)
      setPersonaOptimizerStatus('failed')
      setErrorBanner(`Persona optimize failed: ${message}`)
      pushDebug({
        kind: 'optimize',
        model: selectedModel,
        status: 'failed',
        raw: '',
        parsePath: 'failed',
        optimizeTarget: 'persona',
        optimizerSystemPromptUsed: optimizerSystemPromptFor('persona'),
        chatSystemMessageSnapshot: systemPrompt,
        error: message,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    }
  }

  const runOptimizeScenario = async (): Promise<void> => {
    if (isStreaming || !selectedModel) return
    const currentPrompt = scenarioPrompt
    if (!currentPrompt.trim()) {
      setErrorBanner('Add a scenario block before optimizing')
      return
    }

    setScenarioOptimizerStatus('optimizing')
    setErrorBanner('')
    pushDebug({
      kind: 'optimize',
      model: selectedModel,
      status: 'optimizing',
      raw: '',
      parsePath: 'start',
      optimizeTarget: 'scenario',
      optimizerSystemPromptUsed: optimizerSystemPromptFor('scenario'),
      chatSystemMessageSnapshot: systemPrompt,
      personaEnabled: personaMode.enabled,
      personaIntensity: personaMode.intensity,
      personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
    })

    try {
      const result = await optimizeScenarioPrompt(client, selectedModel, currentPrompt)
      setOptimizerPreview({
        target: 'scenario',
        currentPrompt,
        result,
      })
      setScenarioOptimizerStatus('ready')
      pushDebug({
        kind: 'optimize',
        model: selectedModel,
        status: 'ready',
        raw: result.rawOutput,
        parsePath: result.parsePath,
        optimizeTarget: 'scenario',
        optimizerSystemPromptUsed: optimizerSystemPromptFor('scenario'),
        chatSystemMessageSnapshot: systemPrompt,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    } catch (error) {
      const message = toErrorMessage(error)
      setScenarioOptimizerStatus('failed')
      setErrorBanner(`Scenario optimize failed: ${message}`)
      pushDebug({
        kind: 'optimize',
        model: selectedModel,
        status: 'failed',
        raw: '',
        parsePath: 'failed',
        optimizeTarget: 'scenario',
        optimizerSystemPromptUsed: optimizerSystemPromptFor('scenario'),
        chatSystemMessageSnapshot: systemPrompt,
        error: message,
        personaEnabled: personaMode.enabled,
        personaIntensity: personaMode.intensity,
        personaBlockLength: buildPersonaPrompt(personaMode).personaBlock.length,
      })
    }
  }

  const handleReasoningToggle = (messageId: string, open: boolean): void => {
    setShowReasoningById((current) => ({
      ...current,
      [messageId]: open,
    }))
  }

  const handleEvidenceToggle = (factId: string, open: boolean): void => {
    setShowEvidenceByFactId((current) => ({
      ...current,
      [factId]: open,
    }))
  }

  const acceptOptimizerPreview = (preview: NonNullable<typeof optimizerPreview>): void => {
    if (preview.target === 'persona') {
      setPersonaMode((current) => ({
        ...current,
        personaText: preview.result.optimizedPrompt,
        personaUpdatedAt: new Date().toISOString(),
      }))
      setPersonaOptimizerStatus('idle')
    } else if (preview.target === 'scenario') {
      setScenarioPrompt(preview.result.optimizedPrompt)
      setScenarioOptimizerStatus('idle')
    } else {
      setSystemPrompt(preview.result.optimizedPrompt)
      setOptimizerStatus('idle')
    }

    setLastOptimizationMeta({
      at: new Date().toISOString(),
      model: selectedModel,
    })
    setOptimizerPreview(null)
  }

  const rejectOptimizerPreview = (preview: NonNullable<typeof optimizerPreview>): void => {
    setOptimizerPreview(null)
    if (preview.target === 'persona') {
      setPersonaOptimizerStatus('idle')
    } else if (preview.target === 'scenario') {
      setScenarioOptimizerStatus('idle')
    } else {
      setOptimizerStatus('idle')
    }
  }

  return (
    <div className="app-frame">
      <nav className="mobile-panel-toggle" aria-label="Panel Navigation">
        <button
          type="button"
          className={mobilePanel === 'settings' ? 'active' : ''}
          onClick={() => setMobilePanel('settings')}
          aria-pressed={mobilePanel === 'settings'}
        >
          Settings
        </button>
        <button
          type="button"
          className={mobilePanel === 'chat' ? 'active' : ''}
          onClick={() => setMobilePanel('chat')}
          aria-pressed={mobilePanel === 'chat'}
        >
          Chat
        </button>
        <button
          type="button"
          className={mobilePanel === 'brain' ? 'active' : ''}
          onClick={() => setMobilePanel('brain')}
          aria-pressed={mobilePanel === 'brain'}
        >
          Brain
        </button>
      </nav>
      <div className="app-shell" data-mobile-panel={mobilePanel}>
      <aside className="sidebar panel panel-settings">
        <h1>LM Studio Workspace</h1>
        <div className="theme-row">
          <span>Theme</span>
          <button
            className="theme-toggle"
            onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
            type="button"
          >
            {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
          </button>
        </div>
        <label htmlFor="baseUrl">LM Studio URL</label>
        <input
          id="baseUrl"
          value={baseUrlDraft}
          onChange={(event) => setBaseUrlDraft(event.target.value)}
          onBlur={applyBaseUrl}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              applyBaseUrl()
            }
          }}
          placeholder={DEFAULT_BASE_URL}
          disabled={isStreaming}
        />
        <div className="button-row">
          <button
            onClick={applyBaseUrl}
            disabled={isStreaming || (baseUrlDraft.trim() || DEFAULT_BASE_URL) === baseUrl}
          >
            Apply URL
          </button>
        </div>

        <p className={`connection ${connection}`}>Connection: {connection}</p>

        <details className="model-group" open>
          <summary>Model Load Settings</summary>

          <label htmlFor="mainModelSelect">Main LLM model</label>
          <select
            id="mainModelSelect"
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
            disabled={isStreaming || chatModels.length === 0}
          >
            <option value="">Select Main Model…</option>
            {chatModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
          <div className="button-row model-actions">
            <button onClick={() => void loadModelById(selectedModel, 'Main')} disabled={isStreaming || !selectedModel}>
              Load
            </button>
            <button onClick={() => void unloadModelById(selectedModel, 'Main')} disabled={isStreaming || !selectedModel}>
              Unload
            </button>
          </div>
          <p className="memory-meta">Main loaded: {isMainModelLoaded ? 'yes' : 'no'}</p>

          <label htmlFor="brainModelSelect">Brain model</label>
          <select
            id="brainModelSelect"
            value={selectedBrainModel}
            onChange={(event) => setSelectedBrainModel(event.target.value)}
            disabled={isStreaming || brainOptions.length === 0}
          >
            <option value="">Select Brain Model…</option>
            {brainOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
          <div className="button-row model-actions">
            <button
              onClick={() => void loadModelById(selectedBrainModel, 'Brain')}
              disabled={isStreaming || !selectedBrainModel}
            >
              Load
            </button>
            <button
              onClick={() => void unloadModelById(selectedBrainModel, 'Brain')}
              disabled={isStreaming || !selectedBrainModel}
            >
              Unload
            </button>
          </div>
          <p className="memory-meta">Brain loaded: {isBrainModelLoaded ? 'yes' : 'no'}</p>

          <label htmlFor="embedModelSelect">Embed model</label>
          <select
            id="embedModelSelect"
            value={selectedEmbedModel}
            onChange={(event) => setSelectedEmbedModel(event.target.value)}
            disabled={isStreaming || embeddingOptions.length === 0}
          >
            <option value="">Select Embedding Model…</option>
            {embeddingOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id}
              </option>
            ))}
          </select>
          <div className="button-row model-actions">
            <button
              onClick={() => void loadModelById(selectedEmbedModel, 'Embed')}
              disabled={isStreaming || !selectedEmbedModel}
            >
              Load
            </button>
            <button
              onClick={() => void unloadModelById(selectedEmbedModel, 'Embed')}
              disabled={isStreaming || !selectedEmbedModel}
            >
              Unload
            </button>
          </div>
          <p className="memory-meta">Embed loaded: {isEmbeddingCompanionLoaded ? 'yes' : 'no'}</p>
        </details>

        <details className="model-group" open>
          <summary>System Message</summary>
          <label htmlFor="systemPrompt">System message</label>
          <textarea
            ref={systemPromptRef}
            id="systemPrompt"
            className="sidebar-system"
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            onInput={onSidebarTextareaInput}
            placeholder="You are a helpful local assistant…"
            disabled={isStreaming}
          />
          <div className="system-tools">
            <button onClick={() => void runOptimizeSystemPrompt()} disabled={isStreaming || !selectedModel}>
              Optimize
            </button>
            <span className="memory-meta">
              Optimizer:{' '}
              {optimizerStatus === 'optimizing'
                ? 'Optimizing'
                : optimizerStatus === 'ready'
                  ? 'Ready'
                  : optimizerStatus === 'failed'
                    ? 'Failed'
                    : 'Idle'}
            </span>
          </div>
          {lastOptimizationMeta ? (
            <p className="memory-meta">
              Last optimized: {formatDateTime(lastOptimizationMeta.at)} ({lastOptimizationMeta.model})
            </p>
          ) : null}
        </details>

        <details className="model-group" open>
          <summary>Persona</summary>
          <p className="memory-meta">
            Roleplay: {personaMode.enabled ? 'On' : 'Off'} | {personaMode.intensity}%
          </p>
          <button
            onClick={() =>
              setPersonaMode((current) => ({
                ...current,
                enabled: !current.enabled,
                personaUpdatedAt: new Date().toISOString(),
              }))
            }
            disabled={isStreaming}
          >
            {personaMode.enabled ? 'Disable Roleplay' : 'Enable Roleplay'}
          </button>
          <label htmlFor="personaIntensity">Roleplay intensity</label>
          <input
            id="personaIntensity"
            type="range"
            min={0}
            max={100}
            step={1}
            value={personaMode.intensity}
            onChange={(event) =>
              setPersonaMode((current) => ({
                ...current,
                intensity: Number(event.target.value),
                personaUpdatedAt: new Date().toISOString(),
              }))
            }
            disabled={isStreaming}
          />
          <label htmlFor="personaText">Custom persona</label>
          <textarea
            ref={personaTextRef}
            id="personaText"
            className="sidebar-system"
            value={personaMode.personaText}
            onChange={(event) =>
              setPersonaMode((current) => ({
                ...current,
                personaText: event.target.value,
                personaUpdatedAt: new Date().toISOString(),
              }))
            }
            onInput={onSidebarTextareaInput}
            placeholder="Example: A warm, witty friend who talks naturally and asks thoughtful follow-ups…"
            disabled={isStreaming}
          />
          <div className="system-tools">
            <button onClick={() => void runOptimizePersona()} disabled={isStreaming || !selectedModel}>
              Optimize persona
            </button>
            <span className="memory-meta">
              Persona optimizer:{' '}
              {personaOptimizerStatus === 'optimizing'
                ? 'Optimizing'
                : personaOptimizerStatus === 'ready'
                  ? 'Ready'
                  : personaOptimizerStatus === 'failed'
                    ? 'Failed'
                    : 'Idle'}
            </span>
          </div>
        </details>

        <details className="model-group" open>
          <summary>Scenario</summary>
          <label htmlFor="scenarioPrompt">Scenario block</label>
          <textarea
            ref={scenarioPromptRef}
            id="scenarioPrompt"
            className="sidebar-system"
            value={scenarioPrompt}
            onChange={(event) => setScenarioPrompt(event.target.value)}
            onInput={onSidebarTextareaInput}
            placeholder="Example: You are helping with a noir detective roleplay set in 1940s Chicago…"
            disabled={isStreaming}
          />
          <div className="system-tools">
            <button onClick={() => void runOptimizeScenario()} disabled={isStreaming || !selectedModel}>
              Optimize scenario
            </button>
            <span className="memory-meta">
              Scenario optimizer:{' '}
              {scenarioOptimizerStatus === 'optimizing'
                ? 'Optimizing'
                : scenarioOptimizerStatus === 'ready'
                  ? 'Ready'
                  : scenarioOptimizerStatus === 'failed'
                    ? 'Failed'
                    : 'Idle'}
            </span>
          </div>
        </details>

        <div className="button-row">
          <button onClick={() => void refreshModels()} disabled={isStreaming}>
            Refresh
          </button>
        </div>

        <p className="active-model">Main model: {selectedModel || 'none'}</p>
        <p className="memory-meta">Brain model: {selectedBrainModel || 'none'}</p>
        <p className="memory-meta">Embed model: {selectedEmbedModel || 'none'}</p>
      </aside>

      <ChatWorkspace
        statusLine={statusLine}
        errorBanner={errorBanner}
        messages={messages}
        showReasoningById={showReasoningById}
        onToggleReasoning={handleReasoningToggle}
        fileJobs={fileJobs}
        input={input}
        isStreaming={isStreaming}
        selectedModel={selectedModel}
        lastFailedPrompt={lastFailedPrompt}
        onComposerInputChange={setInput}
        onComposerKeyDown={onComposerKeyDown}
        onFileList={(files) => void handleFileList(files)}
        onRetryLastFailedPrompt={() => void sendMessage(lastFailedPrompt || '')}
        onSend={() => void sendMessage()}
      />

      <BrainSidebar
        canVisualizeVectors={vectorMemoryCount >= 2}
        hasMessages={messages.length > 0}
        hasLastAssistantMessage={Boolean(lastAssistantMessage)}
        isStreaming={isStreaming}
        memoryStatus={memoryStatus}
        episodeStatus={episodeStatus}
        profileStatus={profileStatus}
        embeddingStatus={embeddingStatus}
        vectorMemoryCount={vectorMemoryCount}
        fileDerivedFactCount={fileDerivedFactCount}
        vectorExportFormat={vectorExportFormat}
        memoryGraph={memoryGraph}
        sortedFacts={sortedFacts}
        evidenceByFactId={evidenceByFactId}
        showEvidenceByFactId={showEvidenceByFactId}
        onClearChat={clearChat}
        onRegenerateLastResponse={() => void regenerateLastResponse()}
        onOpenDebug={() => setDebugOpen(true)}
        onOpenVectorVisualization={() => setVectorVisualizationOpen(true)}
        onRetryEmbeddings={() => void retryEmbeddings()}
        onRunAnalyzeAndMergeVectorMemories={() => void runAnalyzeAndMergeVectorMemories()}
        onVectorExportFormatChange={setVectorExportFormat}
        onExportVectorData={() => void exportVectorData()}
        onClearAllMemories={clearAllMemories}
        onClearFileFacts={clearFileDerivedFacts}
        onToggleEvidence={handleEvidenceToggle}
        onDeleteFact={removeFact}
        onResolveConflictWinner={resolveConflictWinner}
      />
      </div>

      <DebugDrawer
        debugOpen={debugOpen}
        debugEntries={debugEntries}
        onClear={() => setDebugEntries([])}
        onClose={() => setDebugOpen(false)}
      />

      <VectorVisualizationModal
        graph={memoryGraph}
        open={vectorVisualizationOpen}
        onClose={() => setVectorVisualizationOpen(false)}
      />

      <OptimizerPreviewModal
        preview={optimizerPreview}
        onAccept={acceptOptimizerPreview}
        onReject={rejectOptimizerPreview}
      />
    </div>
  )
}

export default App
