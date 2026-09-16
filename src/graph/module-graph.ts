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

function bump(map: Map<string, Map<string, number>>, a: string, b: string): void {
  let inner = map.get(a)
  if (!inner) {
    inner = new Map()
    map.set(a, inner)
  }
  inner.set(b, (inner.get(b) ?? 0) + 1)
}
