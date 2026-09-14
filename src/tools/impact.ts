import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GraphStore } from '../store/graph-store.js'
import { truncate, type Truncation } from './envelope.js'
import { traverseSymbols, type DependencyNode } from './dependencies.js'

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
  truncated?: Truncation
  note?: string
}

const ENTRY_BASENAMES = new Set([
  'index.ts', 'index.tsx', 'index.js', 'index.mjs',
  'main.ts', 'main.js', 'server.ts', 'server.js', 'app.ts', 'app.js', 'cli.ts', 'cli.js',
])

/**
 * Collects repo-relative entry-point paths declared in `package.json`:
 * `main`, `module`, `bin` (a string, or an object of name -> string), and
 * `exports` (a string, or an object whose direct values are strings — one
 * level of nesting; a conditional-exports map nested deeper than that is
 * out of scope here). Returns an empty set, never throws, when there is no
 * `package.json` or it fails to parse.
 */
function entryPointsFromPackageJson(repoRoot: string): Set<string> {
  const entries = new Set<string>()

  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return entries
  }

  const add = (value: unknown): void => {
    if (typeof value === 'string') entries.add(value.replace(/^\.\//, '').replace(/\\/g, '/'))
  }

  const addStringOrShallowObject = (value: unknown): void => {
    if (typeof value === 'string') { add(value); return }
    if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) add(v)
    }
  }

  add(pkg.main)
  add(pkg.module)
  addStringOrShallowObject(pkg.bin)
  addStringOrShallowObject(pkg.exports)

  return entries
}

export function impactOf(store: GraphStore, options: ImpactOptions): ImpactResult {
  // Sized by the TRUE match count, not a magic number — see the identical
  // fix and rationale in dependencies.ts's resolveTarget/symbolLevel. A
  // hardcoded cap here would silently narrow `matchedSymbols`, the
  // traversal's starting set, AND every count derived from it.
  const matchFilter = { name: options.symbol, pathPrefix: options.file }
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

  const packageEntryPoints = options.repoRoot !== undefined
    ? entryPointsFromPackageJson(options.repoRoot)
    : new Set<string>()

  const exportedFromEntryPoint = matches.some((s) => {
    if (!s.exported) return false
    const basename = s.path.slice(s.path.lastIndexOf('/') + 1)
    return ENTRY_BASENAMES.has(basename) || packageEntryPoints.has(s.path)
  })

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
    exportedFromEntryPoint,
    truncated,
  }
}
