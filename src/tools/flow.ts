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
  /**
   * True only when a genuine expansion of this symbol exists somewhere in
   * the tree -- either finished already, or actively in progress higher up
   * the current call chain (which is what a real cycle looks like). False
   * for a symbol that was marked to prevent re-expansion but whose own
   * expand() call was cut short by `maxDepth`/`limit` before it examined a
   * single edge: there is nothing anywhere in the result for that
   * reference to point back to, so it must not claim otherwise.
   */
  repeated: boolean
  calls: FlowNode[]
}

export interface FlowResult {
  entry: string
  root: FlowNode | null
  /** Total nodes emitted, including repeats and external calls. */
  totalNodes: number
  depthLimited: boolean
  /** True when the node/edge cap (`limit`) cut the walk short somewhere. */
  limitReached: boolean
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
      limitReached: false,
      maxDepth: options.maxDepth,
      note: `Entry point "${options.entry}" not found in the index. Use search_code to locate ` +
        `it first, or pass "file" to disambiguate if the name is not unique.`,
    }
  }

  const start = candidates[0]
  const pathsById = store.pathsById()
  let totalNodes = 1
  let depthLimited = false
  let limitReached = false

  /**
   * Per symbol id: whether its OWN expand() call ever genuinely started --
   * i.e. passed the depth/limit guards and began looking at its edges --
   * as opposed to being cut short before examining a single one.
   *
   * Presence in this map (regardless of value) is the pre-order "don't
   * recurse into this again" marker that makes the walk terminate on a
   * cycle: an id is added here BEFORE the recursive call that expands it,
   * not after it returns. That ordering is load-bearing and must never
   * move to post-order -- a mutually recursive pair would then recurse
   * forever, since neither side would ever see the other as already
   * claimed until it was too late to matter.
   *
   * The boolean value is a separate, purely reporting-facing concern layered
   * on top of that same map: it tracks whether real detail exists anywhere
   * in the tree for this id, so a later reference to it can be labelled
   * `repeated: true` only when that is actually true. It is flipped from
   * `false` to `true` the instant `expand()` passes its own guards for that
   * id -- BEFORE iterating its edges, not after -- so an in-progress
   * expansion counts as real. That is what makes a genuine cycle (e.g.
   * a -> b -> a) come out right: by the time b's edge back to a is
   * processed, a has already committed to building the real children array
   * that the finished tree will include as a's node, even though that
   * array isn't finished yet. It is only ever left `false` when the depth
   * or node-limit guard trips immediately, before any edge was looked at --
   * exactly the case where nothing about this id appears anywhere in the
   * result, so a reference to it must not claim `repeated: true`.
   */
  const expandState = new Map<number, boolean>()

  const expand = (symbolId: number, fromModule: string, depth: number): FlowNode[] => {
    if (totalNodes >= options.limit) {
      limitReached = true
      return []
    }
    if (depth > options.maxDepth) {
      depthLimited = true
      return []
    }
    // Real work is about to happen for this id: flip it to realized now,
    // before the loop below, so an edge that cycles back to it mid-loop
    // (the in-progress case described above) is recognised as real.
    expandState.set(symbolId, true)

    const children: FlowNode[] = []
    for (const edge of store.edgesFromSymbol(symbolId)) {
      if (totalNodes >= options.limit) {
        limitReached = true
        break
      }

      const targetPath = edge.dstFileId === null ? null : pathsById.get(edge.dstFileId) ?? null
      const targetName = edge.dstSymbolId === null
        ? edge.dstName
        : store.symbolById(edge.dstSymbolId)?.name ?? edge.dstName

      const alreadyMarked = edge.dstSymbolId !== null && expandState.has(edge.dstSymbolId)
      const realizedElsewhere = edge.dstSymbolId !== null && expandState.get(edge.dstSymbolId) === true
      const node: FlowNode = {
        name: targetName,
        path: targetPath,
        line: edge.line,
        confidence: edge.confidence,
        crossesModule: targetPath !== null && moduleOf(targetPath) !== fromModule,
        repeated: realizedElsewhere,
        calls: [],
      }
      totalNodes += 1

      // An unresolved edge points at nothing in this repository, so there is
      // nothing to expand. A symbol already marked is never recursed into
      // twice -- that's what keeps a recursive cycle finite -- but whether
      // it is rendered `repeated: true` depends on whether it was ever
      // genuinely realized (see expandState's doc comment above).
      if (edge.dstSymbolId !== null && !alreadyMarked) {
        // Pre-order marking, before the recursive call -- see expandState's
        // doc comment. Starts `false`; `expand` itself flips it to `true`
        // the moment it knows real work is happening for this id.
        expandState.set(edge.dstSymbolId, false)
        node.calls = expand(edge.dstSymbolId, targetPath === null ? fromModule : moduleOf(targetPath), depth + 1)
      }

      children.push(node)
    }
    return children
  }

  expandState.set(start.id, false)
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
    limitReached,
    maxDepth: options.maxDepth,
    note: candidates.length > 1
      ? `"${options.entry}" has ${candidates.length} definitions; traced from ${start.path}:${start.startLine}. ` +
        `Pass "file" to trace a different one.`
      : undefined,
  }
}
