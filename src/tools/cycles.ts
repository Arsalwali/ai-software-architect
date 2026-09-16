import type { GraphStore } from '../store/graph-store.js'
import { buildModuleGraph } from '../graph/module-graph.js'
import { stronglyConnectedComponents } from '../graph/algorithms.js'
import { truncate, type Truncation } from './envelope.js'

export type CycleScope = 'module' | 'file'

export interface CycleOptions {
  scope: CycleScope
  minSize: number
  limit: number
}

export interface Cycle {
  members: string[]
  size: number
  /** Total weight of the edges inside the cycle. Higher means more entangled. */
  internalEdges: number
}

export interface CycleResult {
  scope: CycleScope
  cycles: Cycle[]
  totalCycles: number
  truncated?: Truncation
}

export function findCycles(store: GraphStore, options: CycleOptions): CycleResult {
  const level = options.scope === 'module' ? moduleLevel(store) : fileLevel(store)
  const components = stronglyConnectedComponents(level.nodes, level.successors)

  const cycles: Cycle[] = []
  for (const members of components) {
    // Tarjan returns EVERY node as a component, so without this check an
    // acyclic graph would report one "cycle" per node. A single node is a
    // cycle only when it points at itself.
    if (members.length === 1) {
      const only = members[0]
      let selfLoop = false
      for (const next of level.successors(only)) {
        if (next === only) { selfLoop = true; break }
      }
      if (!selfLoop) continue
    }
    if (members.length < options.minSize) continue

    const inside = new Set(members)
    let internalEdges = 0
    for (const member of members) {
      for (const next of level.successors(member)) {
        if (inside.has(next)) internalEdges += level.weightOf(member, next)
      }
    }
    cycles.push({ members, size: members.length, internalEdges })
  }

  cycles.sort((a, b) =>
    b.size - a.size || b.internalEdges - a.internalEdges || a.members[0].localeCompare(b.members[0]))

  const { items, truncated } = truncate(cycles, options.limit)
  return { scope: options.scope, cycles: items, totalCycles: cycles.length, truncated }
}

function moduleLevel(store: GraphStore) {
  const graph = buildModuleGraph(store)
  return {
    nodes: graph.modules,
    successors: (m: string): Iterable<string> => graph.out.get(m)?.keys() ?? [],
    weightOf: (a: string, b: string): number => graph.out.get(a)?.get(b) ?? 0,
  }
}

function fileLevel(store: GraphStore) {
  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()
  const adjacency = new Map<string, Set<string>>()

  for (const [path, fileId] of idsByPath) {
    const targets = new Set<string>()
    for (const imp of store.importsForFile(fileId)) {
      if (imp.resolvedFileId === null) continue
      const target = pathsById.get(imp.resolvedFileId)
      if (target !== undefined && target !== path) targets.add(target)
    }
    adjacency.set(path, targets)
  }

  return {
    nodes: [...adjacency.keys()].sort(),
    successors: (p: string): Iterable<string> => adjacency.get(p) ?? new Set<string>(),
    // A file-level edge either exists or does not; there is no multiplicity,
    // because the adjacency set already deduplicates targets.
    weightOf: (): number => 1,
  }
}
