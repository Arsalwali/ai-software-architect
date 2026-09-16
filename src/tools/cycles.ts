import type { GraphStore } from '../store/graph-store.js'
import { buildModuleGraph, moduleOf, type ModuleGraph } from '../graph/module-graph.js'
import { stronglyConnectedComponents } from '../graph/algorithms.js'
import { truncate, type Truncation } from './envelope.js'

export type CycleScope = 'module' | 'file'

export interface CycleOptions {
  scope: CycleScope
  minSize: number
  limit: number
}

export interface FileEdge {
  fromFile: string
  toFile: string
}

export interface CycleHop {
  from: string
  to: string
  /** Example file-to-file edges that create this module-to-module hop, capped. */
  via: FileEdge[]
  /** Present only when `via` was capped; the true count of file edges crossing this hop. */
  viaTruncated?: Truncation
}

export interface Cycle {
  members: string[]
  size: number
  /** Total weight of the edges inside the cycle. Higher means more entangled. */
  internalEdges: number
  /**
   * Module-to-module hops inside the cycle, each with the file-level edges
   * responsible for it. Module scope only — at file scope the members
   * already ARE files, so this would just repeat the cycle itself.
   */
  hops?: CycleHop[]
  /**
   * True when this cycle is a directory-bucketing artifact rather than a
   * real circular dependency: at module scope, with no file-level cycle
   * among the files belonging to this cycle's member modules.
   *
   * This is a derivable fact, not a heuristic. A module-to-module edge
   * exists ONLY because some file in the source module imports some file in
   * the target module — it carries no information beyond "at least one file
   * edge crosses this boundary". Two modules can therefore each have an edge
   * into the other's module without any file in either one ever being on a
   * path back to itself — for example, a directory holding both a leaf file
   * that everything imports and an entry-point file that imports broadly
   * will show edges in both directions purely because those two unrelated
   * files share a bucket. Running the file-level SCC restricted to exactly
   * these member modules' files settles the question outright: if it finds
   * no component larger than one file (and no file with a self-edge), there
   * is no circular dependency among any of these files, and the module
   * cycle is manufactured entirely by directory grouping.
   *
   * Undefined at file scope, where the question does not apply.
   */
  aggregationArtifact?: boolean
}

export interface CycleResult {
  scope: CycleScope
  cycles: Cycle[]
  totalCycles: number
  truncated?: Truncation
}

export function findCycles(store: GraphStore, options: CycleOptions): CycleResult {
  const moduleGraph = options.scope === 'module' ? buildModuleGraph(store) : undefined
  const level = moduleGraph ? moduleLevel(moduleGraph) : fileLevel(store)
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

    const cycle: Cycle = { members, size: members.length, internalEdges }
    if (moduleGraph) {
      cycle.hops = hopsFor(store, moduleGraph, members, inside)
      cycle.aggregationArtifact = isAggregationArtifact(store, members)
    }
    cycles.push(cycle)
  }

  cycles.sort((a, b) =>
    b.size - a.size || b.internalEdges - a.internalEdges || a.members[0].localeCompare(b.members[0]))

  const { items, truncated } = truncate(cycles, options.limit)
  return { scope: options.scope, cycles: items, totalCycles: cycles.length, truncated }
}

function moduleLevel(graph: ModuleGraph) {
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

/**
 * For every module-to-module edge inside a cycle, the distinct file-to-file
 * edges that create it — capped per hop, with the true count carried
 * alongside so a capped example list is never mistaken for the whole story.
 */
function hopsFor(store: GraphStore, graph: ModuleGraph, members: string[], inside: Set<string>): CycleHop[] {
  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()
  const hops: CycleHop[] = []

  for (const from of members) {
    const targets = graph.out.get(from)
    if (!targets) continue
    for (const to of targets.keys()) {
      if (!inside.has(to)) continue

      const pairs: FileEdge[] = []
      const seen = new Set<string>()
      for (const path of graph.filesByModule.get(from) ?? []) {
        const fileId = idsByPath.get(path)
        if (fileId === undefined) continue
        for (const imp of store.importsForFile(fileId)) {
          if (imp.resolvedFileId === null) continue
          const targetPath = pathsById.get(imp.resolvedFileId)
          if (targetPath === undefined || moduleOf(targetPath) !== to) continue
          const key = `${path}\n${targetPath}`
          if (seen.has(key)) continue
          seen.add(key)
          pairs.push({ fromFile: path, toFile: targetPath })
        }
      }

      const { items, truncated } = truncate(pairs, 3)
      hops.push({ from, to, via: items, viaTruncated: truncated })
    }
  }

  return hops
}

/**
 * Runs the file-level SCC restricted to exactly the files owned by the given
 * modules, and reports whether any real cycle exists among them (a
 * component of more than one file, or a single file with a self-edge).
 * Restricting to these files is what makes the answer sound: a module cycle
 * can only be genuine if the files responsible for its edges loop back to
 * each other, and those files all belong to the modules in `members`.
 */
function isAggregationArtifact(store: GraphStore, members: string[]): boolean {
  const allowedModules = new Set(members)
  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()

  const nodes: string[] = []
  for (const path of idsByPath.keys()) {
    if (allowedModules.has(moduleOf(path))) nodes.push(path)
  }
  const nodeSet = new Set(nodes)

  const adjacency = new Map<string, Set<string>>()
  for (const path of nodes) {
    const targets = new Set<string>()
    for (const imp of store.importsForFile(idsByPath.get(path)!)) {
      if (imp.resolvedFileId === null) continue
      const target = pathsById.get(imp.resolvedFileId)
      if (target !== undefined && nodeSet.has(target)) targets.add(target)
    }
    adjacency.set(path, targets)
  }

  const successors = (p: string): Iterable<string> => adjacency.get(p) ?? new Set<string>()
  const components = stronglyConnectedComponents(nodes.sort(), successors)

  for (const component of components) {
    if (component.length > 1) return false
    const only = component[0]
    for (const next of successors(only)) {
      if (next === only) return false
    }
  }
  return true
}
