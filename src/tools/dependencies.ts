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
  truncated?: Truncation
}

/** A file path wins over a directory, which wins over a symbol name. */
export function resolveTarget(store: GraphStore, target: string): ResolvedTarget {
  if (store.fileIdByPath(target) !== undefined) return { kind: 'file', resolved: target }

  const prefix = target.endsWith('/') ? target : `${target}/`
  if (store.allFilePaths().some(p => p.startsWith(prefix))) {
    return { kind: 'module', resolved: target.replace(/\/$/, '') }
  }

  const symbols = store.findSymbols({ name: target, limit: 20 })
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
  if (target.kind === 'unknown') return { target, direction: options.direction, nodes: [] }

  const nodes = target.kind === 'symbol'
    ? symbolLevel(store, target, options)
    : fileLevel(store, target, options)

  const { items, truncated } = truncate(nodes, options.limit)
  return { target, direction: options.direction, nodes: items, truncated }
}

function fileLevel(store: GraphStore, target: ResolvedTarget, options: DependencyOptions): DependencyNode[] {
  const pathsById = store.pathsById()
  const idsByPath = store.fileIdsByPath()

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

  return out
}

function symbolLevel(store: GraphStore, target: ResolvedTarget, options: DependencyOptions): DependencyNode[] {
  const startIds = store.findSymbols({ name: target.resolved, limit: 20 }).map(s => s.id)
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
): DependencyNode[] {
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

  return out
}
