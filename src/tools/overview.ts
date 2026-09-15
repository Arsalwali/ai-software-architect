import type { GraphStore } from '../store/graph-store.js'
import { entryPointsFromPackageJson, isEntryPoint } from './entry-points.js'

export interface RepoOverview {
  repoRoot: string | null
  indexedAt: string | null
  headCommit: string | null
  totals: { files: number; symbols: number; edges: number; imports: number }
  languages: Array<{ lang: string | null; files: number; symbols: number }>
  /** Every confidence tier, reported separately. Never merged. */
  edgeConfidence: Record<string, number>
  /** Share of edges whose target is a symbol inside this repository. The remainder point at external, builtin, or third-party code, which is expected rather than a resolution failure. */
  internalTargetFraction: number
  modules: Array<{ path: string; files: number; symbols: number }>
  entryPoints: string[]
  skipped: { total: number; byReason: Record<string, number> }
  filesWithParseErrors: number
}

/**
 * `repoRoot` is optional, the same seam `impactOf` already uses: when
 * absent (or when `package.json` is missing/unparsable), entry-point
 * detection degrades to the conventional-basename check alone rather than
 * throwing. Passing it lets `entryPoints` agree with `impact_of`'s
 * `exportedFromEntryPoint` about package.json-declared entries (`main`,
 * `module`, `bin`, `exports`) instead of only recognising conventional
 * basenames — the two used to hold separately-drifted copies of this logic.
 */
export function buildOverview(store: GraphStore, repoRoot?: string): RepoOverview {
  const totals = store.totals()
  const edgeConfidence = store.confidenceBreakdown()

  // "Resolved" here means the edge found a concrete symbol in this repo.
  // Unresolved edges are external by definition, not failures.
  const targeted = edgeConfidence.exact + edgeConfidence.resolved +
    edgeConfidence.heuristic + edgeConfidence.ambiguous
  const resolvedFraction = totals.edges === 0 ? 0 : targeted / totals.edges

  const paths = store.allFilePaths()
  const symbolsByFile = store.symbolsByFile()
  const idsByPath = store.fileIdsByPath()

  const moduleFiles = new Map<string, { files: number; symbols: number }>()
  let filesWithParseErrors = 0
  const entryPoints: string[] = []
  const packageEntryPoints = repoRoot !== undefined ? entryPointsFromPackageJson(repoRoot) : new Set<string>()

  for (const path of paths) {
    const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : '.'
    const bucket = moduleFiles.get(top) ?? { files: 0, symbols: 0 }
    bucket.files += 1
    const fileId = idsByPath.get(path)
    if (fileId !== undefined) bucket.symbols += (symbolsByFile.get(fileId) ?? []).length
    moduleFiles.set(top, bucket)

    const row = store.fileRow(path)
    if (row && row.errorCount > 0) filesWithParseErrors += 1

    if (isEntryPoint(path, packageEntryPoints)) entryPoints.push(path)
  }

  let byReason: Record<string, number> = {}
  const raw = store.getMeta('files_skipped_by_reason')
  if (raw) {
    try { byReason = JSON.parse(raw) as Record<string, number> } catch { byReason = {} }
  }

  return {
    repoRoot: store.getMeta('repo_root') ?? null,
    indexedAt: store.getMeta('indexed_at') ?? null,
    headCommit: store.getMeta('head_commit') || null,
    totals,
    languages: store.languageBreakdown(),
    edgeConfidence,
    internalTargetFraction: Number(resolvedFraction.toFixed(4)),
    modules: [...moduleFiles.entries()]
      .map(([path, counts]) => ({ path, ...counts }))
      .sort((a, b) => b.files - a.files),
    entryPoints: entryPoints.sort(),
    skipped: { total: Number(store.getMeta('files_skipped') ?? '0'), byReason },
    filesWithParseErrors,
  }
}
