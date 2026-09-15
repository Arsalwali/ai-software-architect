import type { GraphStore, EdgeRow } from '../store/graph-store.js'
import type { Confidence, EdgeKind } from '../types.js'
import { CONFIDENCE_RANK, truncate, type Truncation } from './envelope.js'

export type Direction = 'in' | 'out'

export interface ResolvedTarget {
  kind: 'file' | 'module' | 'symbol' | 'unknown'
  resolved: string
  candidates?: Array<{ path: string; line: number; kind: string }>
}

export interface DependencyOptions {
  target: string
  direction: Direction
  depth: number
  kind?: EdgeKind
  minConfidence?: Confidence
  limit: number
}

export interface DependencyNode {
  path: string
  symbolName: string | null
  depth: number
  via: EdgeKind | 'imports'
  confidence: Confidence
  line: number | null
}

export interface DependencyResult {
  target: ResolvedTarget
  direction: Direction
  nodes: DependencyNode[]
  /** The `depth` actually used for this traversal, echoed back. */
  depth: number
  /**
   * True when the BFS still had a non-empty frontier when the depth budget
   * ran out — i.e. more dependencies exist beyond `depth` that this result
   * does not include. `false` means the traversal reached everything
   * reachable on its own, not merely that nothing was cut off by a smaller
   * budget than the caller might have wanted.
   */
  depthLimited: boolean
  truncated?: Truncation
}

/** A file path wins over a directory, which wins over a symbol name. */
export function resolveTarget(store: GraphStore, target: string): ResolvedTarget {
  if (store.fileIdByPath(target) !== undefined) return { kind: 'file', resolved: target }

  const prefix = target.endsWith('/') ? target : `${target}/`
  if (store.allFilePaths().some(p => p.startsWith(prefix))) {
    return { kind: 'module', resolved: target.replace(/\/$/, '') }
  }

  // Sized by the TRUE match count, not a magic number: a hardcoded limit
  // here would silently drop candidates past it before traversal even
  // begins, which is exactly the class of defect this project has already
  // shipped and fixed once (see search.ts's countSymbols pattern).
  const nameFilter = { name: target }
  const symbols = store.findSymbols({ ...nameFilter, limit: store.countSymbols(nameFilter) })
  if (symbols.length > 0) {
    return {
      kind: 'symbol',
      resolved: target,
      candidates: symbols.map(s => ({ path: s.path, line: s.startLine, kind: s.kind })),
    }
  }

  return { kind: 'unknown', resolved: target }
}

export function getDependencies(store: GraphStore, options: DependencyOptions): DependencyResult {
  const target = resolveTarget(store, options.target)
  if (target.kind === 'unknown') {
    return { target, direction: options.direction, nodes: [], depth: options.depth, depthLimited: false }
  }

  const { nodes, depthLimited } = target.kind === 'symbol'
    ? symbolLevel(store, target, options)
    : fileLevel(store, target, options)

  const { items, truncated } = truncate(nodes, options.limit)
  return { target, direction: options.direction, nodes: items, depth: options.depth, depthLimited, truncated }
}

function fileLevel(
  store: GraphStore, target: ResolvedTarget, options: DependencyOptions,
): { nodes: DependencyNode[]; depthLimited: boolean } {
  const pathsById = store.pathsById()
  const idsByPath = store.fileIdsByPath()
  // File-level nodes are always emitted with confidence 'resolved' (import
  // edges carry no independent confidence tier). Apply the same
  // CONFIDENCE_RANK floor traverseSymbols() applies to symbol edges, so
  // minConfidence isn't a silent no-op for file/directory targets: a floor
  // above 'resolved' yields nothing, a floor at or below it keeps everything.
  const floor = options.minConfidence === undefined ? -1 : CONFIDENCE_RANK[options.minConfidence]

  const startIds = target.kind === 'file'
    ? [idsByPath.get(target.resolved)!]
    : store.allFilePaths()
        .filter(p => p.startsWith(`${target.resolved}/`))
        .map(p => idsByPath.get(p)!)

  const seen = new Set<number>(startIds)
  const out: DependencyNode[] = []
  let frontier = startIds

  for (let depth = 1; depth <= options.depth && frontier.length > 0; depth++) {
    const next: number[] = []
    for (const fileId of frontier) {
      const neighbours = options.direction === 'out'
        ? store.importsForFile(fileId)
            .map(i => i.resolvedFileId)
            .filter((id): id is number => id !== null)
        : store.filesImporting(fileId)

      for (const neighbour of neighbours) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        next.push(neighbour)
        if (CONFIDENCE_RANK.resolved < floor) continue
        out.push({
          path: pathsById.get(neighbour) ?? '?',
          symbolName: null,
          depth,
          via: 'imports',
          confidence: 'resolved',
          line: null,
        })
      }
    }
    frontier = next
  }

  // The loop above only exits with a non-empty `frontier` when it ran out
  // of depth budget while nodes were still waiting to be explored (the
  // other exit condition, `frontier.length === 0`, means the BFS finished
  // on its own). That makes this the signal for Fix 4: depth truncation
  // used to be silent here, reporting the same shape of result at
  // maxDepth 1 as at maxDepth 10 with no way to tell them apart.
  return { nodes: out, depthLimited: frontier.length > 0 }
}

function symbolLevel(
  store: GraphStore, target: ResolvedTarget, options: DependencyOptions,
): { nodes: DependencyNode[]; depthLimited: boolean } {
  // Same reasoning as resolveTarget above: size by the true count so a
  // symbol name with many definitions never has its starting set silently
  // narrowed before the BFS even runs.
  const nameFilter = { name: target.resolved }
  const startIds = store.findSymbols({ ...nameFilter, limit: store.countSymbols(nameFilter) }).map(s => s.id)
  return traverseSymbols(store, startIds, options.direction, options.depth, options.kind, options.minConfidence)
}

/**
 * Breadth-first walk over symbol edges. Shared with impact_of.
 * `seen` guarantees termination on a cycle and stops a node being reported twice.
 */
export function traverseSymbols(
  store: GraphStore,
  startSymbolIds: number[],
  direction: Direction,
  maxDepth: number,
  kind?: EdgeKind,
  minConfidence?: Confidence,
): { nodes: DependencyNode[]; depthLimited: boolean } {
  const floor = minConfidence === undefined ? -1 : CONFIDENCE_RANK[minConfidence]
  const pathsById = store.pathsById()
  const seen = new Set<number>(startSymbolIds)
  const out: DependencyNode[] = []
  let frontier = startSymbolIds

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = []
    for (const symbolId of frontier) {
      const edges: EdgeRow[] = direction === 'in'
        ? store.edgesToSymbol(symbolId)
        : store.edgesFromSymbol(symbolId)

      for (const edge of edges) {
        if (kind !== undefined && edge.kind !== kind) continue
        if (CONFIDENCE_RANK[edge.confidence] < floor) continue

        const otherSymbolId = direction === 'in' ? edge.srcSymbolId : edge.dstSymbolId
        const otherFileId = direction === 'in' ? edge.srcFileId : edge.dstFileId

        out.push({
          path: otherFileId === null ? '(external)' : pathsById.get(otherFileId) ?? '?',
          symbolName: otherSymbolId === null
            ? (direction === 'in' ? null : edge.dstName)
            : store.symbolById(otherSymbolId)?.name ?? null,
          depth,
          via: edge.kind,
          confidence: edge.confidence,
          line: edge.line,
        })

        if (otherSymbolId !== null && !seen.has(otherSymbolId)) {
          seen.add(otherSymbolId)
          next.push(otherSymbolId)
        }
      }
    }
    frontier = next
  }

  return { nodes: out, depthLimited: frontier.length > 0 }
}
