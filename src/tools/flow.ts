import type { GraphStore } from '../store/graph-store.js'
import { moduleOf } from '../graph/module-graph.js'
import { escapeLikeWildcards } from './envelope.js'
import type { Confidence } from '../types.js'

export interface FlowOptions {
  entry: string
  /** Disambiguate the entry by path prefix. */
  file?: string
  maxDepth: number
  limit: number
}

export interface FlowNode {
  name: string
  /** Null for an external call, which has no file in this repository. */
  path: string | null
  line: number | null
  confidence: Confidence
  /** True when this call leaves the caller's module. */
  crossesModule: boolean
  /** True when this node was already expanded elsewhere in the tree. */
  repeated: boolean
  calls: FlowNode[]
}

export interface FlowResult {
  entry: string
  root: FlowNode | null
  /** Total nodes emitted, including repeats and external calls. */
  totalNodes: number
  depthLimited: boolean
  maxDepth: number
  note?: string
}

export function traceFlow(store: GraphStore, options: FlowOptions): FlowResult {
  const filter = {
    name: options.entry,
    pathPrefix: options.file === undefined ? undefined : escapeLikeWildcards(options.file),
  }
  const total = store.countSymbols(filter)
  const candidates = store.findSymbols({ ...filter, limit: Math.max(total, 1) })

  if (candidates.length === 0) {
    return {
      entry: options.entry,
      root: null,
      totalNodes: 0,
      depthLimited: false,
      maxDepth: options.maxDepth,
      note: `Entry point "${options.entry}" not found in the index. Use search_code to locate ` +
        `it first, or pass "file" to disambiguate if the name is not unique.`,
    }
  }

  const start = candidates[0]
  const pathsById = store.pathsById()
  const expanded = new Set<number>()
  let totalNodes = 1
  let depthLimited = false

  const expand = (symbolId: number, fromModule: string, depth: number): FlowNode[] => {
    if (totalNodes >= options.limit) return []
    if (depth > options.maxDepth) {
      depthLimited = true
      return []
    }

    const children: FlowNode[] = []
    for (const edge of store.edgesFromSymbol(symbolId)) {
      if (totalNodes >= options.limit) break

      const targetPath = edge.dstFileId === null ? null : pathsById.get(edge.dstFileId) ?? null
      const targetName = edge.dstSymbolId === null
        ? edge.dstName
        : store.symbolById(edge.dstSymbolId)?.name ?? edge.dstName

      const alreadyExpanded = edge.dstSymbolId !== null && expanded.has(edge.dstSymbolId)
      const node: FlowNode = {
        name: targetName,
        path: targetPath,
        line: edge.line,
        confidence: edge.confidence,
        crossesModule: targetPath !== null && moduleOf(targetPath) !== fromModule,
        repeated: alreadyExpanded,
        calls: [],
      }
      totalNodes += 1

      // An unresolved edge points at nothing in this repository, so there is
      // nothing to expand — and a node already expanded elsewhere is emitted
      // as a reference, which is what keeps a recursive cycle finite.
      if (edge.dstSymbolId !== null && !alreadyExpanded) {
        expanded.add(edge.dstSymbolId)
        node.calls = expand(edge.dstSymbolId, targetPath === null ? fromModule : moduleOf(targetPath), depth + 1)
      }

      children.push(node)
    }
    return children
  }

  expanded.add(start.id)
  const rootModule = moduleOf(start.path)
  const root: FlowNode = {
    name: start.name,
    path: start.path,
    line: start.startLine,
    confidence: 'exact',
    crossesModule: false,
    repeated: false,
    calls: expand(start.id, rootModule, 1),
  }

  return {
    entry: options.entry,
    root,
    totalNodes,
    depthLimited,
    maxDepth: options.maxDepth,
    note: candidates.length > 1
      ? `"${options.entry}" has ${candidates.length} definitions; traced from ${start.path}:${start.startLine}. ` +
        `Pass "file" to trace a different one.`
      : undefined,
  }
}
