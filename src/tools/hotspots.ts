import type { GraphStore } from '../store/graph-store.js'
import { collectHistory, type CoChangePair } from '../git/history.js'
import { findCycles } from './cycles.js'
import { truncate, type Truncation } from './envelope.js'

export interface HotspotOptions {
  limit: number
  windowDays?: number
}

export interface Hotspot {
  path: string
  /** Composite of the structural and churn signals below. Not a unit. */
  score: number
  loc: number
  symbols: number
  fanIn: number
  fanOut: number
  inCycle: boolean
  commits: number
  authors: number
  bugFixCommits: number
  lastCommitAt: string | null
}

export interface HiddenCoupling extends CoChangePair {
  /** True when neither file imports the other, despite changing together. */
  noImportEdge: boolean
}

export interface HotspotResult {
  hotspots: Hotspot[]
  totalFiles: number
  gitAvailable: boolean
  windowDays: number
  skippedLargeCommits: number
  /** Pairs that change together but have no import relationship. */
  hiddenCoupling: HiddenCoupling[]
  note?: string
  truncated?: Truncation
}

const HIDDEN_COUPLING_MIN_COMMITS = 3

export function findHotspots(
  store: GraphStore,
  repoRoot: string,
  options: HotspotOptions,
): HotspotResult {
  const history = collectHistory(repoRoot, { windowDays: options.windowDays })

  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()
  const symbolsByFile = store.symbolsByFile()

  const cycleMembers = new Set<string>()
  for (const cycle of findCycles(store, { scope: 'file', minSize: 2, limit: Number.MAX_SAFE_INTEGER }).cycles) {
    for (const member of cycle.members) cycleMembers.add(member)
  }

  const importTargets = new Map<string, Set<string>>()
  const rows: Hotspot[] = []

  for (const [path, fileId] of idsByPath) {
    const targets = new Set<string>()
    for (const imp of store.importsForFile(fileId)) {
      if (imp.resolvedFileId === null) continue
      const target = pathsById.get(imp.resolvedFileId)
      if (target !== undefined) targets.add(target)
    }
    importTargets.set(path, targets)

    const file = store.fileRow(path)
    const git = history.byFile.get(path)
    rows.push({
      path,
      score: 0,
      loc: file?.loc ?? 0,
      symbols: (symbolsByFile.get(fileId) ?? []).length,
      fanIn: store.filesImporting(fileId).length,
      fanOut: targets.size,
      inCycle: cycleMembers.has(path),
      commits: git?.commits ?? 0,
      authors: git?.authors ?? 0,
      bugFixCommits: git?.bugFixCommits ?? 0,
      lastCommitAt: git?.lastCommitAt ?? null,
    })
  }

  const maxLoc = Math.max(1, ...rows.map(r => r.loc))
  const maxFan = Math.max(1, ...rows.map(r => r.fanIn + r.fanOut))
  const maxCommits = Math.max(1, ...rows.map(r => r.commits))
  const maxFixes = Math.max(1, ...rows.map(r => r.bugFixCommits))

  for (const row of rows) {
    const structural =
      0.4 * (row.loc / maxLoc) +
      0.4 * ((row.fanIn + row.fanOut) / maxFan) +
      (row.inCycle ? 0.2 : 0)

    // Without git there is no churn term. Falling back to 1 would score on
    // structure alone while still looking like a debt ranking, so the caller
    // is told explicitly via `gitAvailable` and `note`.
    const churn = history.available
      ? 0.6 * (row.commits / maxCommits) + 0.4 * (row.bugFixCommits / maxFixes)
      : 1

    row.score = Number((structural * churn).toFixed(4))
  }

  rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  const hiddenCoupling: HiddenCoupling[] = []
  for (const pair of history.coChanges) {
    if (pair.commits < HIDDEN_COUPLING_MIN_COMMITS) continue
    if (!idsByPath.has(pair.a) || !idsByPath.has(pair.b)) continue
    const linked =
      (importTargets.get(pair.a)?.has(pair.b) ?? false) ||
      (importTargets.get(pair.b)?.has(pair.a) ?? false)
    if (linked) continue
    hiddenCoupling.push({ ...pair, noImportEdge: true })
  }

  const { items, truncated } = truncate(rows, options.limit)

  return {
    hotspots: items,
    totalFiles: rows.length,
    gitAvailable: history.available,
    windowDays: history.windowDays,
    skippedLargeCommits: history.skippedLargeCommits,
    hiddenCoupling: hiddenCoupling.slice(0, options.limit),
    note: history.available
      ? undefined
      : `${history.reason ?? 'Git history unavailable.'} Ranking is structural only — size, fan-in/out and cycle membership — with no churn signal, so treat it as incomplete rather than as a debt ranking.`,
    truncated,
  }
}
