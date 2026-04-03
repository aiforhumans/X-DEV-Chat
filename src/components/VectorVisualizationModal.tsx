import { useEffect, useMemo, useRef, useState } from 'react'
import type { MemoryFact, MemoryGraphState } from '../types/chat'
import {
  buildEdgesForSelection,
  buildVectorVisualizationDataset,
  computeNearestNeighborGraph,
  normalizeEmbedding,
  runUmapProjection,
  type ProjectedVectorPoint,
} from '../lib/vectorVisualization'

interface VectorVisualizationModalProps {
  graph: MemoryGraphState
  open: boolean
  onClose: () => void
}

const CHART_WIDTH = 860
const CHART_HEIGHT = 460
const CHART_PADDING = 28

const colorByCategory: Record<MemoryFact['category'] | 'unknown', string> = {
  preference: '#2f80ed',
  profile: '#27ae60',
  goal: '#f2994a',
  constraint: '#eb5757',
  other: '#9b51e0',
  unknown: '#7b8798',
}

export const VectorVisualizationModal = (props: VectorVisualizationModalProps) => {
  const { graph, open, onClose } = props
  const [nNeighbors, setNNeighbors] = useState(15)
  const [minDist, setMinDist] = useState(0.1)
  const [neighborCount, setNeighborCount] = useState(3)
  const [showLinks, setShowLinks] = useState(true)
  const [rerunToken, setRerunToken] = useState(0)
  const [isProjecting, setIsProjecting] = useState(false)
  const [projectionError, setProjectionError] = useState('')
  const [projectionEpoch, setProjectionEpoch] = useState<number | null>(null)
  const [projectedPoints, setProjectedPoints] = useState<ProjectedVectorPoint[]>([])
  const [selectedFactId, setSelectedFactId] = useState<string | null>(null)
  const [hoveredFactId, setHoveredFactId] = useState<string | null>(null)
  const runIdRef = useRef(0)

  const dataset = useMemo(() => buildVectorVisualizationDataset(graph, 1000), [graph])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  useEffect(() => {
    if (!open) return
    if (dataset.points.length < 2) {
      setProjectedPoints([])
      setProjectionError('')
      setIsProjecting(false)
      return
    }

    const runId = ++runIdRef.current
    setIsProjecting(true)
    setProjectionError('')
    setProjectionEpoch(null)

    void (async () => {
      try {
        const vectors = dataset.points.map((point) => point.vector)
        const embedding = await runUmapProjection(
          vectors,
          { nNeighbors, minDist },
          (epoch) => setProjectionEpoch(epoch),
        )
        if (runId !== runIdRef.current) return
        const coordinates = normalizeEmbedding(embedding, CHART_WIDTH, CHART_HEIGHT, CHART_PADDING)
        const projected = dataset.points.map((point, index) => ({
          ...point,
          x: coordinates[index]?.x ?? CHART_WIDTH / 2,
          y: coordinates[index]?.y ?? CHART_HEIGHT / 2,
        }))
        setProjectedPoints(projected)
        if (!projected.some((point) => point.factId === selectedFactId)) {
          setSelectedFactId(null)
        }
      } catch (error) {
        if (runId !== runIdRef.current) return
        setProjectionError(error instanceof Error ? error.message : 'Projection failed')
        setProjectedPoints([])
      } finally {
        if (runId !== runIdRef.current) return
        setIsProjecting(false)
      }
    })()
  }, [dataset.points, minDist, nNeighbors, open, rerunToken, selectedFactId])

  const neighbors = useMemo(
    () => computeNearestNeighborGraph(projectedPoints.map((point) => point.vector), neighborCount),
    [neighborCount, projectedPoints],
  )

  const edges = useMemo(
    () => buildEdgesForSelection(projectedPoints, neighbors, selectedFactId),
    [neighbors, projectedPoints, selectedFactId],
  )

  const pointsById = useMemo(
    () => new Map(projectedPoints.map((point) => [point.factId, point])),
    [projectedPoints],
  )

  const activeFactId = hoveredFactId || selectedFactId
  const activePoint = activeFactId ? pointsById.get(activeFactId) : undefined

  const categoriesPresent = useMemo(
    () =>
      Array.from(
        new Set(
          projectedPoints.map((point) => point.category),
        ),
      ),
    [projectedPoints],
  )

  if (!open) return null

  return (
    <div className="vectorviz-overlay" role="dialog" aria-modal="true" aria-label="Vector visualization">
      <article className="vectorviz-modal">
        <header>
          <div>
            <h2>Vector Visualization</h2>
            <p className="memory-meta">
              Showing {dataset.points.length} of {dataset.totalCount} vectors
              {dataset.sampled ? ' (sampled to 1000)' : ''}
            </p>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <section className="vectorviz-controls" aria-label="Projection controls">
          <label htmlFor="umapNeighbors">
            UMAP n_neighbors: {nNeighbors}
          </label>
          <input
            id="umapNeighbors"
            type="range"
            min={2}
            max={Math.max(2, Math.min(100, dataset.points.length - 1))}
            value={nNeighbors}
            onChange={(event) => setNNeighbors(Number(event.target.value))}
            disabled={isProjecting || dataset.points.length < 2}
          />

          <label htmlFor="umapMinDist">
            UMAP min_dist: {minDist.toFixed(2)}
          </label>
          <input
            id="umapMinDist"
            type="range"
            min={0}
            max={0.99}
            step={0.01}
            value={minDist}
            onChange={(event) => setMinDist(Number(event.target.value))}
            disabled={isProjecting || dataset.points.length < 2}
          />

          <label htmlFor="umapNeighborCount">
            Neighbor links (k): {neighborCount}
          </label>
          <input
            id="umapNeighborCount"
            type="range"
            min={1}
            max={Math.max(1, Math.min(12, projectedPoints.length - 1))}
            value={neighborCount}
            onChange={(event) => setNeighborCount(Number(event.target.value))}
            disabled={projectedPoints.length < 2}
          />

          <label className="vectorviz-checkbox" htmlFor="umapShowLinks">
            <input
              id="umapShowLinks"
              type="checkbox"
              checked={showLinks}
              onChange={(event) => setShowLinks(event.target.checked)}
              disabled={projectedPoints.length < 2}
            />
            Show nearest-neighbor links
          </label>

          <button
            type="button"
            onClick={() => setRerunToken((current) => current + 1)}
            disabled={isProjecting || dataset.points.length < 2}
          >
            Re-run Projection
          </button>
        </section>

        <section className="vectorviz-status" aria-live="polite">
          {dataset.points.length < 2 ? (
            <p className="memory-meta">Need at least 2 vectors to visualize.</p>
          ) : isProjecting ? (
            <p className="memory-meta">
              Running UMAP projection{projectionEpoch !== null ? ` (epoch ${projectionEpoch})` : '...'}
            </p>
          ) : (
            <p className="memory-meta">Projection ready. Click a point to inspect nearest links.</p>
          )}
          {projectionError ? <p className="error">{projectionError}</p> : null}
        </section>

        <section className="vectorviz-chart-wrap">
          {projectedPoints.length < 2 ? (
            <p className="empty">No projection to display yet.</p>
          ) : (
            <svg
              className="vectorviz-chart"
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              role="img"
              aria-label="UMAP projected vector chart"
            >
              <rect x={0} y={0} width={CHART_WIDTH} height={CHART_HEIGHT} fill="transparent" />

              {showLinks
                ? edges.map((edge) => {
                    const from = pointsById.get(edge.fromId)
                    const to = pointsById.get(edge.toId)
                    if (!from || !to) return null
                    return (
                      <line
                        key={`${edge.fromId}-${edge.toId}`}
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        className="vectorviz-edge"
                      />
                    )
                  })
                : null}

              {projectedPoints.map((point) => {
                const selected = point.factId === selectedFactId
                return (
                  <circle
                    key={point.factId}
                    cx={point.x}
                    cy={point.y}
                    r={selected ? 6 : 4}
                    fill={colorByCategory[point.category]}
                    className={selected ? 'vectorviz-point selected' : 'vectorviz-point'}
                    onMouseEnter={() => setHoveredFactId(point.factId)}
                    onMouseLeave={() => setHoveredFactId(null)}
                    onClick={() =>
                      setSelectedFactId((current) => (current === point.factId ? null : point.factId))
                    }
                  >
                    <title>{`${point.canonicalText} | ${point.category} | ${point.provider}`}</title>
                  </circle>
                )
              })}
            </svg>
          )}
        </section>

        <section className="vectorviz-legend" aria-label="Category legend">
          {categoriesPresent.map((category) => (
            <span key={category} className="vectorviz-legend-item">
              <i style={{ backgroundColor: colorByCategory[category] }} />
              {category}
            </span>
          ))}
        </section>

        <section className="vectorviz-detail">
          {activePoint ? (
            <>
              <h3>{activePoint.canonicalText || activePoint.factId}</h3>
              <p className="memory-meta">
                Category: {activePoint.category} | Status: {activePoint.status} | Confidence:{' '}
                {Math.round(activePoint.confidence * 100)}%
              </p>
              <p className="memory-meta">
                Provider: {activePoint.provider} | Model: {activePoint.model}
              </p>
            </>
          ) : (
            <p className="memory-meta">Hover or select a point to inspect details.</p>
          )}
        </section>
      </article>
    </div>
  )
}
