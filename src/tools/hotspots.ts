import type { GraphStore } from '../store/graph-store.js'
import { collectHistory, type CoChangePair } from '../git/history.js'
import { buildFileAdjacency } from '../graph/module-graph.js'
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
  /**
   * True when no direct import edge and no two-hop import path (A -> X -> B
   * or B -> X -> A) was found between the pair, despite changing together.
   * This is deliberately NOT full reachability: in a connected codebase
   * almost every file is transitively reachable from almost every other
   * through some shared utility, so "no path anywhere" would suppress
   * nearly all signal. It is also deliberately not direct-edge-only: a hub
   * file (e.g. a root component importing many things) is transitively
   * reachable from most of its own descendants by construction, so a
   * direct-edge-only check would systematically flag a hub against its own
   * descendants as "hidden" coupling that isn't hidden at all. The bounded
   * two-hop check is a middle ground: it catches the common
   * "shared-utility" and "sibling-via-parent" cases without either extreme.
   */
  noNearbyImportPath: boolean
}

export interface HotspotResult {
  hotspots: Hotspot[]
  totalFiles: number
  gitAvailable: boolean
  windowDays: number
  /**
   * Total commits found inside `windowDays`. A git repository with no
   * commits in the window still reports `gitAvailable: true`, but a
   * `totalCommits` of 0 means the churn half of every score below
   * contributed nothing — the same practical outcome as `gitAvailable:
   * false`, just reached a different way, and otherwise indistinguishable
   * from it by a caller who only looks at `gitAvailable`.
   */
  totalCommits: number
  skippedLargeCommits: number
  /** Pairs that change together but have no nearby import relationship. */
  hiddenCoupling: HiddenCoupling[]
  /** True count of qualifying pairs before `hiddenCoupling` was capped. */
  totalHiddenCoupling: number
  note?: string
  truncated?: Truncation
  /** Present only when `hiddenCoupling` was capped by `options.limit`. */
  truncatedHiddenCoupling?: Truncation
}

const HIDDEN_COUPLING_MIN_COMMITS = 3

export function findHotspots(
  store: GraphStore,
  repoRoot: string,
  options: HotspotOptions,
): HotspotResult {
  const history = collectHistory(repoRoot, { windowDays: options.windowDays })

  const idsByPath = store.fileIdsByPath()
  const symbolsByFile = store.symbolsByFile()

  const cycleMembers = new Set<string>()
  for (const cycle of findCycles(store, { scope: 'file', minSize: 2, limit: Number.MAX_SAFE_INTEGER }).cycles) {
    for (const member of cycle.members) cycleMembers.add(member)
  }

  const importTargets = buildFileAdjacency(store)
  const rows: Hotspot[] = []

  for (const [path, fileId] of idsByPath) {
    const targets = importTargets.get(path) ?? new Set<string>()

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

    const aTargets = importTargets.get(pair.a)
    const bTargets = importTargets.get(pair.b)

    const direct = (aTargets?.has(pair.b) ?? false) || (bTargets?.has(pair.a) ?? false)
    if (direct) continue

    // Bounded two-hop check: A -> X -> B, or B -> X -> A. Not full
    // reachability -- see the doc comment on `noNearbyImportPath`.
    let twoHop = false
    if (aTargets) {
      for (const x of aTargets) {
        if (importTargets.get(x)?.has(pair.b)) { twoHop = true; break }
      }
    }
    if (!twoHop && bTargets) {
      for (const x of bTargets) {
        if (importTargets.get(x)?.has(pair.a)) { twoHop = true; break }
      }
    }
    if (twoHop) continue

    hiddenCoupling.push({ ...pair, noNearbyImportPath: true })
  }

  const { items, truncated } = truncate(rows, options.limit)
  const hiddenCouplingCapped = truncate(hiddenCoupling, options.limit)

  const notes: string[] = []
  if (!history.available) {
    notes.push(
      `${history.reason ?? 'Git history unavailable.'} Ranking is structural only — size, ` +
      `fan-in/out and cycle membership — with no churn signal, so treat it as incomplete ` +
      `rather than as a debt ranking.`,
    )
  }
  // `loc` was persisted as 0 for every file before this plan's schema
  // change, and an existing index does not get the new value until it is
  // fully rebuilt (incremental reindex never re-parses an unchanged file).
  // A zeroed `loc` silently drops the size half of the structural signal
  // out of every score, which changes the ranking and can knock genuinely
  // large files out of the top results entirely -- so this must be labelled
  // rather than left to look like an ordinary, complete ranking.
  if (rows.length > 0 && rows.every(r => r.loc === 0)) {
    notes.push(
      'Every indexed file reports 0 lines of code, so the size half of the structural signal ' +
      'is unavailable -- this index predates line-count collection. Run "arch index --full" ' +
      'to rebuild it and restore accurate rankings.',
    )
  }

  return {
    hotspots: items,
    totalFiles: rows.length,
    gitAvailable: history.available,
    windowDays: history.windowDays,
    totalCommits: history.totalCommits,
    skippedLargeCommits: history.skippedLargeCommits,
    hiddenCoupling: hiddenCouplingCapped.items,
    totalHiddenCoupling: hiddenCoupling.length,
    note: notes.length > 0 ? notes.join(' ') : undefined,
    truncated,
    truncatedHiddenCoupling: hiddenCouplingCapped.truncated,
  }
}
