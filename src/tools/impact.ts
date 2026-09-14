import type { GraphStore } from '../store/graph-store.js'
import { truncate, type Truncation } from './envelope.js'
import { traverseSymbols, type DependencyNode } from './dependencies.js'

export interface ImpactOptions {
  symbol: string
  file?: string
  maxDepth: number
  limit: number
}

export interface ImpactResult {
  symbol: string
  matchedSymbols: Array<{ path: string; line: number; kind: string; exported: boolean }>
  totalReferences: number
  /**
   * Spec §8's reporting shape. `verified` is evidence from a real type
   * resolver, `likely` is a unique name match, `ambiguous` is a name that
   * matched several candidates and was fanned out to all of them.
   * Unresolved edges cannot appear here at all — they point at no symbol,
   * so reverse reachability from a symbol never reaches them.
   */
  buckets: { verified: number; likely: number; ambiguous: number }
  byModule: Array<{ module: string; count: number }>
  references: DependencyNode[]
  exportedAtPackageBoundary: boolean
  truncated?: Truncation
  note?: string
}

const ENTRY_BASENAMES = new Set([
  'index.ts', 'index.tsx', 'index.js', 'index.mjs',
  'main.ts', 'main.js', 'server.ts', 'server.js', 'app.ts', 'app.js', 'cli.ts', 'cli.js',
])

export function impactOf(store: GraphStore, options: ImpactOptions): ImpactResult {
  const matches = store.findSymbols({
    name: options.symbol,
    pathPrefix: options.file,
    limit: 20,
  })

  if (matches.length === 0) {
    return {
      symbol: options.symbol,
      matchedSymbols: [],
      totalReferences: 0,
      buckets: { verified: 0, likely: 0, ambiguous: 0 },
      byModule: [],
      references: [],
      exportedAtPackageBoundary: false,
      note: `Symbol "${options.symbol}" not found in the index. It may be external, ` +
        `misspelled, or in a file that was skipped at index time.`,
    }
  }

  const references = traverseSymbols(
    store, matches.map(s => s.id), 'in', options.maxDepth,
  )

  const buckets = { verified: 0, likely: 0, ambiguous: 0 }
  const moduleCounts = new Map<string, number>()

  for (const ref of references) {
    if (ref.confidence === 'exact') buckets.verified += 1
    else if (ref.confidence === 'heuristic' || ref.confidence === 'resolved') buckets.likely += 1
    else buckets.ambiguous += 1

    const module = ref.path.includes('/') ? ref.path.slice(0, ref.path.lastIndexOf('/')) : '.'
    moduleCounts.set(module, (moduleCounts.get(module) ?? 0) + 1)
  }

  // Narrowing worth stating: "package boundary" is approximated as an
  // exported symbol living in a conventional entry-point file. Reading
  // package.json `exports` maps would be more precise and is a later
  // refinement; this errs toward NOT claiming a boundary it cannot see.
  const exportedAtPackageBoundary = matches.some(
    s => s.exported && ENTRY_BASENAMES.has(s.path.slice(s.path.lastIndexOf('/') + 1)),
  )

  const { items, truncated } = truncate(references, options.limit)

  return {
    symbol: options.symbol,
    matchedSymbols: matches.map(s => ({
      path: s.path, line: s.startLine, kind: s.kind, exported: s.exported,
    })),
    totalReferences: references.length,
    buckets,
    byModule: [...moduleCounts.entries()]
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count),
    references: items,
    exportedAtPackageBoundary,
    truncated,
  }
}
