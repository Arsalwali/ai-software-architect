import { GraphStore } from '../store/graph-store.js'
import { indexPathFor } from '../repo/repo-source.js'
import { ensureFresh, type Freshness, type IndexState } from '../indexer/freshness.js'
import type { Confidence } from '../types.js'

/**
 * Explicit confidence ranking. The union's declaration order is NOT a
 * ranking — relying on it would silently invert a minConfidence filter.
 * `ambiguous` outranks `unresolved` because an ambiguous edge names real
 * candidates in this repository, while an unresolved one names nothing.
 */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  exact: 4,
  resolved: 3,
  heuristic: 2,
  ambiguous: 1,
  unresolved: 0,
}

export interface IndexStatus {
  repoRoot: string
  state: IndexState
  changedFiles: number
  deletedFiles: number
  indexedAt: string | null
  /** Present only when state is not `current`, explaining what to do. */
  note?: string
}

export interface Truncation {
  returned: number
  total: number
}

export interface ToolEnvelope<T> {
  index: IndexStatus
  result: T
  truncated?: Truncation
}

/** Caps a list and says so, with the true total. Never trims silently. */
export function truncate<T>(items: T[], limit: number): { items: T[]; truncated?: Truncation } {
  if (items.length <= limit) return { items }
  return { items: items.slice(0, limit), truncated: { returned: limit, total: items.length } }
}

/**
 * Escapes SQL LIKE metacharacters so a caller-supplied value is matched
 * literally by `GraphStore.findSymbols`'s `contains`/`pathPrefix` filters,
 * which wrap the value into a `LIKE '...'` pattern without escaping it.
 * Without this, a value containing `_` (matches any single character) or
 * `%` (matches any run of characters) would be silently reinterpreted as a
 * wildcard — e.g. a path of `src/tools/e_velope.ts` would also match
 * `src/tools/envelope.ts`, and a path of `%envelope` would turn a documented
 * PREFIX match into a substring search. `\` is escaped first (and is itself
 * the escape character) so a value that already contains a backslash cannot
 * smuggle a live wildcard back in. Paired with the `ESCAPE '\'` clause on
 * those LIKE expressions in graph-store.ts. Shared by every tool that passes
 * a user-supplied string into a LIKE filter (search.ts, impact.ts) so the
 * fix lives in one place rather than being rediscovered per call site.
 */
export function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Runs a read against a repository's index, bringing it up to date first when
 * that is cheap. Always closes the store. The returned envelope carries the
 * freshness of the data the callback actually saw.
 */
export async function withIndex<T>(
  repoRoot: string,
  fn: (store: GraphStore, freshness: Freshness) => T,
  dbPathOverride?: string,
): Promise<ToolEnvelope<T>> {
  const dbPath = dbPathOverride ?? indexPathFor(repoRoot)
  const freshness = await ensureFresh(repoRoot, dbPath)
  const store = GraphStore.open(dbPath)
  try {
    return { index: statusOf(repoRoot, freshness), result: fn(store, freshness) }
  } finally {
    store.close()
  }
}

export function statusOf(repoRoot: string, freshness: Freshness): IndexStatus {
  const status: IndexStatus = {
    repoRoot,
    state: freshness.state,
    changedFiles: freshness.changedFiles,
    deletedFiles: freshness.deletedFiles,
    indexedAt: freshness.indexedAt,
  }
  if (freshness.state === 'stale') {
    status.note =
      `${freshness.changedFiles} files changed and ${freshness.deletedFiles} were deleted since ` +
      `this index was built — too many to absorb inline. Results may be out of date. ` +
      `Run "arch index" to refresh.`
  }
  if (freshness.state === 'incomplete') {
    status.note = 'A previous index did not finish. Results are incomplete; run "arch index".'
  }
  return status
}

/** MCP tools return text content; the envelope is the payload. */
export function toolText<T>(envelope: ToolEnvelope<T>): {
  content: Array<{ type: 'text'; text: string }>
} {
  return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] }
}
