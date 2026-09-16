import type { GraphStore } from '../store/graph-store.js'

export interface ModuleGraph {
  /** Every module that owns at least one indexed file, sorted. */
  modules: string[]
  filesByModule: Map<string, string[]>
  /** from to-map, where the value is the count of distinct file pairs. */
  out: Map<string, Map<string, number>>
  /** The inverse of `out`. */
  in: Map<string, Map<string, number>>
}

/** A module is the directory containing a file. Root files live in ".". */
export function moduleOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '.' : path.slice(0, cut)
}

/**
 * Aggregates resolved file-level imports into a directory-level graph.
 *
 * Weight counts DISTINCT source-file/target-file pairs rather than import
 * rows. The imports table legitimately holds several rows for one pair —
 * `import { x }` plus `import type { Y }` from the same module is ordinary
 * TypeScript — and counting rows would inflate coupling numbers in a way
 * indistinguishable from real architectural coupling.
 */
export function buildModuleGraph(store: GraphStore): ModuleGraph {
  const filesByModule = new Map<string, string[]>()
  for (const path of store.allFilePaths()) {
    const module = moduleOf(path)
    const bucket = filesByModule.get(module)
    if (bucket) bucket.push(path)
    else filesByModule.set(module, [path])
  }

  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()
  const seenPairs = new Set<string>()
  const out = new Map<string, Map<string, number>>()
  const incoming = new Map<string, Map<string, number>>()

  for (const module of filesByModule.keys()) {
    out.set(module, new Map())
    incoming.set(module, new Map())
  }

  for (const [path, fileId] of idsByPath) {
    const from = moduleOf(path)
    for (const imp of store.importsForFile(fileId)) {
      if (imp.resolvedFileId === null) continue
      const targetPath = pathsById.get(imp.resolvedFileId)
      if (targetPath === undefined) continue

      // A repo-relative path cannot contain a newline, so it is a safe joiner.
      const pairKey = `${path}\n${targetPath}`
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)

      const to = moduleOf(targetPath)
      if (to === from) continue

      bump(out, from, to)
      bump(incoming, to, from)
    }
  }

  return { modules: [...filesByModule.keys()].sort(), filesByModule, out, in: incoming }
}

/**
 * File-level import adjacency: for each file, the set of distinct files it
 * resolves an import to.
 *
 * Self-edges are excluded on purpose: a file whose own import specifier
 * resolves back to itself (for example `import { thing } from '.'` inside
 * `src/foo/index.ts`, which `resolveImport` legitimately resolves to
 * `src/foo/index.ts` itself) is not a dependency between two distinct
 * files, so it must never be counted as one. This is the single shared
 * builder for that structure -- `findCycles`'s file-scope search, its
 * `aggregationArtifact` check, and `findHotspots`'s fan-out/hidden-coupling
 * signal all previously built their own near-duplicate copy of this loop,
 * and one of those copies (the aggregation check) had drifted to include
 * self-edges, which could flip `aggregationArtifact` to `false` for a cycle
 * that the file-scope tool -- built on this same policy -- reports as
 * having zero cycles.
 *
 * `restrictTo`, when given, limits both the node set and its edges to paths
 * inside it, so a caller that needs to reason about only the files
 * belonging to a specific set of modules (again, the aggregation-artifact
 * check) gets a graph that never leaks in a file outside that set.
 */
export function buildFileAdjacency(store: GraphStore, restrictTo?: Set<string>): Map<string, Set<string>> {
  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()
  const adjacency = new Map<string, Set<string>>()

  for (const [path, fileId] of idsByPath) {
    if (restrictTo && !restrictTo.has(path)) continue
    const targets = new Set<string>()
    for (const imp of store.importsForFile(fileId)) {
      if (imp.resolvedFileId === null) continue
      const target = pathsById.get(imp.resolvedFileId)
      if (target === undefined || target === path) continue
      if (restrictTo && !restrictTo.has(target)) continue
      targets.add(target)
    }
    adjacency.set(path, targets)
  }
  return adjacency
}

function bump(map: Map<string, Map<string, number>>, a: string, b: string): void {
  let inner = map.get(a)
  if (!inner) {
    inner = new Map()
    map.set(a, inner)
  }
  inner.set(b, (inner.get(b) ?? 0) + 1)
}
