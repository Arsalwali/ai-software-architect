import type { GraphStore } from '../store/graph-store.js'
import { buildModuleGraph } from '../graph/module-graph.js'
import { couplingMetrics, type CouplingMetrics } from '../graph/algorithms.js'
import { truncate, type Truncation } from './envelope.js'

export interface ModuleOptions {
  path: string
  limit: number
}

export interface ModuleNeighbour {
  module: string
  weight: number
}

export interface ExportedSymbol {
  name: string
  kind: string
  path: string
  line: number
}

export interface ModuleResult {
  module: string
  files: string[]
  /**
   * Paths of modules nested under this one (i.e. deeper directories whose
   * files are NOT included in `files`). `describe_module` buckets by the
   * exact directory named in `path`, unlike `get_repo_overview`'s coarse
   * top-level grouping -- so a directory with sub-directories will always
   * have files this response does not cover. Query one of these paths to
   * see them.
   */
  subModules: string[]
  publicSurface: ExportedSymbol[]
  dependencies: ModuleNeighbour[]
  dependents: ModuleNeighbour[]
  coupling: CouplingMetrics | null
  /** Always null until spec milestone 9 builds the summarizer. */
  summary: string | null
  summaryUnavailableReason?: string
  note?: string
  truncatedFiles?: Truncation
  truncatedSurface?: Truncation
}

const SUMMARY_UNAVAILABLE =
  'The module summarizer is not built yet (spec milestone 9), so no prose summary is available. ' +
  'Everything else in this response is structural and complete.'

export function describeModule(store: GraphStore, options: ModuleOptions): ModuleResult {
  const target = options.path.replace(/\/$/, '')
  const graph = buildModuleGraph(store)

  const files = (graph.filesByModule.get(target) ?? []).slice().sort()

  // Modules nested under `target`: `describe_module` buckets by the EXACT
  // directory named in `path` (moduleOf), so a file two directories down
  // belongs to its own, deeper module and is never in `files` above. Every
  // other module the graph knows about is a sub-module of `target` when its
  // path is nested inside it -- for `target === '.'` (the repo root) that
  // is every other module, since every module is a directory under the root.
  const subModules = graph.modules
    .filter(m => m !== target && (target === '.' || m.startsWith(`${target}/`)))
    .sort()

  if (files.length === 0) {
    const base = {
      module: target,
      files: [],
      subModules,
      publicSurface: [],
      dependencies: [],
      dependents: [],
      coupling: null,
      summary: null,
      summaryUnavailableReason: SUMMARY_UNAVAILABLE,
    }

    // Two genuinely different situations share `files.length === 0`, and
    // must never be reported the same way: a path with real sub-modules
    // below it is not "may not exist" -- it plainly does, it just owns no
    // files directly. Naming a real child directory while also saying the
    // directory may not exist would contradict itself in the same response.
    if (subModules.length > 0) {
      const additionalFiles = subModules.reduce(
        (sum, m) => sum + (graph.filesByModule.get(m)?.length ?? 0), 0,
      )
      return {
        ...base,
        note: `"${target}" owns no files directly. ${additionalFiles} file(s) live in ` +
          `${subModules.length} sub-module(s): ${subModules.join(', ')}. Call describe_module ` +
          `on one of those paths to see them.`,
      }
    }

    return {
      ...base,
      note: `No indexed files under "${target}". It may not exist, or its files may have ` +
        `been skipped at index time.`,
    }
  }

  const idsByPath = store.fileIdsByPath()
  const exportedByFile = store.exportedSymbolsByFile()

  const publicSurface: ExportedSymbol[] = []
  for (const path of files) {
    const fileId = idsByPath.get(path)
    if (fileId === undefined) continue
    for (const symbol of exportedByFile.get(fileId) ?? []) {
      publicSurface.push({ name: symbol.name, kind: symbol.kind, path, line: symbol.startLine })
    }
  }
  publicSurface.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))

  const dependencies: ModuleNeighbour[] = [...(graph.out.get(target) ?? new Map())]
    .map(([module, weight]) => ({ module, weight }))
    .sort((a, b) => b.weight - a.weight || a.module.localeCompare(b.module))

  const dependents: ModuleNeighbour[] = [...(graph.in.get(target) ?? new Map())]
    .map(([module, weight]) => ({ module, weight }))
    .sort((a, b) => b.weight - a.weight || a.module.localeCompare(b.module))

  const coupling = couplingMetrics(graph).find(m => m.module === target) ?? null

  const fileSlice = truncate(files, options.limit)
  const surfaceSlice = truncate(publicSurface, options.limit)

  // How many files live in a sub-module and are therefore NOT among `files`
  // above, even though `files` came back non-empty and looks like a
  // complete answer. Computed from the un-truncated `subModules` list so it
  // stays correct regardless of `limit`.
  const additionalFiles = subModules.reduce(
    (sum, m) => sum + (graph.filesByModule.get(m)?.length ?? 0), 0,
  )

  return {
    module: target,
    files: fileSlice.items,
    subModules,
    publicSurface: surfaceSlice.items,
    dependencies,
    dependents,
    coupling,
    summary: null,
    summaryUnavailableReason: SUMMARY_UNAVAILABLE,
    note: additionalFiles > 0
      ? `This response covers only the ${files.length} file(s) directly inside "${target}", not ` +
        `its sub-directories. ${additionalFiles} more file(s) live in ${subModules.length} ` +
        `sub-module(s) not included here: ${subModules.join(', ')}. Call describe_module on one ` +
        `of those paths to see them.`
      : undefined,
    truncatedFiles: fileSlice.truncated,
    truncatedSurface: surfaceSlice.truncated,
  }
}
