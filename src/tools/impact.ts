import type { GraphStore } from '../store/graph-store.js'
import { truncate, escapeLikeWildcards, type Truncation } from './envelope.js'
import { traverseSymbols, type DependencyNode } from './dependencies.js'
import { entryPointsFromPackageJson, isEntryPoint } from './entry-points.js'

export interface ImpactOptions {
  symbol: string
  file?: string
  maxDepth: number
  limit: number
  /**
   * Repository root, used to read `package.json` for declared entry points
   * (`main`, `module`, `bin`, `exports`). Optional: when absent, or when
   * `package.json` is missing or unparsable, `exportedFromEntryPoint`
   * degrades to the conventional-basename check alone rather than throwing.
   */
  repoRoot?: string
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
  /**
   * True when a matched symbol is exported from a file this check can
   * recognise as a package entry point — either a conventional basename
   * (`index.ts`, `main.js`, ...) or a path declared in `package.json`'s
   * `main`/`module`/`bin`/`exports`. This verifies ONLY what it can see; it
   * is not a general safety verdict. `false` means "not detected as an
   * entry point by this check", not "safe to change" — an unconventionally
   * named entry file with no matching `package.json` declaration (or a
   * `package.json` this check couldn't read) will also read `false`.
   */
  exportedFromEntryPoint: boolean
  /** The `maxDepth` actually used for this traversal, echoed back. */
  maxDepth: number
  /**
   * True when the BFS still had a non-empty frontier when the depth budget
   * ran out — i.e. more references exist beyond `maxDepth` that this result
   * does not include. `false` means the traversal reached every reachable
   * reference on its own, not merely that none were cut off by a smaller
   * budget than the caller might have wanted.
   */
  depthLimited: boolean
  truncated?: Truncation
  note?: string
}

export function impactOf(store: GraphStore, options: ImpactOptions): ImpactResult {
  // Sized by the TRUE match count, not a magic number — see the identical
  // fix and rationale in dependencies.ts's resolveTarget/symbolLevel. A
  // hardcoded cap here would silently narrow `matchedSymbols`, the
  // traversal's starting set, AND every count derived from it.
  const matchFilter = {
    name: options.symbol,
    pathPrefix: options.file !== undefined ? escapeLikeWildcards(options.file) : undefined,
  }
  const matches = store.findSymbols({ ...matchFilter, limit: store.countSymbols(matchFilter) })

  if (matches.length === 0) {
    return {
      symbol: options.symbol,
      matchedSymbols: [],
      totalReferences: 0,
      buckets: { verified: 0, likely: 0, ambiguous: 0 },
      byModule: [],
      references: [],
      exportedFromEntryPoint: false,
      maxDepth: options.maxDepth,
      depthLimited: false,
      note: `Symbol "${options.symbol}" not found in the index. It may be external, ` +
        `misspelled, or in a file that was skipped at index time.`,
    }
  }

  const { nodes: references, depthLimited } = traverseSymbols(
    store, matches.map(s => s.id), 'in', options.maxDepth,
  )

  // Distinct (path, line) locations, mirroring search.ts's `path:line` dedup.
  // Fix 1 (deduplicating importedFileIds) removes the artifact-duplicate
  // edges that used to inflate this; what's left after that is GENUINE
  // multi-candidate fan-out (several real candidates for one ambiguous
  // call) landing several edges on one line. That's correct in `references`
  // as an edge list — each candidate really is a distinct thing that could
  // break — but wrong in a count of "how many places could break", which is
  // what totalReferences/buckets/byModule are meant to answer. So only the
  // counts are deduplicated here; `references` itself keeps every edge.
  const seenLocations = new Set<string>()
  const uniqueReferences: DependencyNode[] = []
  for (const ref of references) {
    const key = `${ref.path}:${ref.line}`
    if (seenLocations.has(key)) continue
    seenLocations.add(key)
    uniqueReferences.push(ref)
  }

  const buckets = { verified: 0, likely: 0, ambiguous: 0 }
  const moduleCounts = new Map<string, number>()

  for (const ref of uniqueReferences) {
    if (ref.confidence === 'exact') buckets.verified += 1
    else if (ref.confidence === 'heuristic' || ref.confidence === 'resolved') buckets.likely += 1
    else buckets.ambiguous += 1

    const module = ref.path.includes('/') ? ref.path.slice(0, ref.path.lastIndexOf('/')) : '.'
    moduleCounts.set(module, (moduleCounts.get(module) ?? 0) + 1)
  }

  const packageEntryPoints = options.repoRoot !== undefined
    ? entryPointsFromPackageJson(options.repoRoot)
    : new Set<string>()

  const exportedFromEntryPoint = matches.some((s) => s.exported && isEntryPoint(s.path, packageEntryPoints))

  const { items, truncated } = truncate(references, options.limit)

  return {
    symbol: options.symbol,
    matchedSymbols: matches.map(s => ({
      path: s.path, line: s.startLine, kind: s.kind, exported: s.exported,
    })),
    totalReferences: uniqueReferences.length,
    buckets,
    byModule: [...moduleCounts.entries()]
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count),
    references: items,
    exportedFromEntryPoint,
    maxDepth: options.maxDepth,
    depthLimited,
    truncated,
  }
}
