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
  if (files.length === 0) {
    return {
      module: target,
      files: [],
      publicSurface: [],
      dependencies: [],
      dependents: [],
      coupling: null,
      summary: null,
      summaryUnavailableReason: SUMMARY_UNAVAILABLE,
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

  return {
    module: target,
    files: fileSlice.items,
    publicSurface: surfaceSlice.items,
    dependencies,
    dependents,
    coupling,
    summary: null,
    summaryUnavailableReason: SUMMARY_UNAVAILABLE,
    truncatedFiles: fileSlice.truncated,
    truncatedSurface: surfaceSlice.truncated,
  }
}
