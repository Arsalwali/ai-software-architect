import { existsSync } from 'node:fs'
import { GraphStore } from '../store/graph-store.js'
import { git, gitHeadCommit, isGitRepo } from '../repo/repo-source.js'
import { computeChangeSet } from './changeset.js'
import { runIncrementalIndex } from './incremental.js'

export type IndexState = 'current' | 'stale' | 'incomplete' | 'missing'

export interface Freshness {
  state: IndexState
  changedFiles: number
  deletedFiles: number
  indexedAt: string | null
  headCommit: string | null
  filesIndexed: number
}

/**
 * Spec §7.2. Below this many changed-or-deleted files, absorb the delta
 * inline — it is sub-second and the caller never notices. At or above it,
 * answer with a stale label rather than blocking a tool call for a minute.
 */
export const AUTO_REINDEX_THRESHOLD = 50

export function checkFreshness(repoRoot: string, dbPath: string): Freshness {
  const empty: Freshness = {
    state: 'missing', changedFiles: 0, deletedFiles: 0,
    indexedAt: null, headCommit: null, filesIndexed: 0,
  }
  if (!existsSync(dbPath)) return empty

  // Deliberately NOT wrapped in try/catch: a db file that exists but fails
  // to open (schema mismatch, corruption) must propagate per spec §9
  // ("refuse to serve; instruct the user to reindex — no silent
  // migration"). GraphStore.open already composes the actionable
  // "arch index --force" message for this case; swallowing it into
  // 'missing' here would print "No index for ..." instead and silently
  // discard that message, which is exactly the kind of silent behavior
  // this task must not introduce (see tests/cli.test.ts's schema-mismatch
  // case, which asserts the message and a non-zero exit reach the user).
  const store = GraphStore.open(dbPath)

  try {
    const base: Freshness = {
      state: 'current',
      changedFiles: 0,
      deletedFiles: 0,
      indexedAt: store.getMeta('indexed_at') ?? null,
      headCommit: store.getMeta('head_commit') || null,
      filesIndexed: Number(store.getMeta('files_indexed') ?? '0'),
    }

    if (store.getMeta('index_complete') !== '1') return { ...base, state: 'incomplete' }

    // Cheap git pre-check: if HEAD is where we indexed it and the working
    // tree is clean, nothing can have changed, so skip hashing entirely.
    if (isGitRepo(repoRoot)) {
      const head = gitHeadCommit(repoRoot)
      const dirty = git(repoRoot, ['status', '--porcelain'])
      if (head !== null && head === base.headCommit && dirty === '') return base
    }

    const changes = computeChangeSet(repoRoot, store)
    const delta = changes.changed.length + changes.deleted.length
    return {
      ...base,
      state: delta === 0 ? 'current' : 'stale',
      changedFiles: changes.changed.length,
      deletedFiles: changes.deleted.length,
    }
  } finally {
    store.close()
  }
}

/**
 * Brings the index up to date when that is cheap, and reports honestly when
 * it is not. Never returns a `current` claim it has not earned.
 */
export async function ensureFresh(repoRoot: string, dbPath: string): Promise<Freshness> {
  const before = checkFreshness(repoRoot, dbPath)

  if (before.state === 'current') return before

  if (before.state === 'missing' || before.state === 'incomplete') {
    await runIncrementalIndex({ repoRoot, dbPath })   // falls back to a cold index internally
    return checkFreshness(repoRoot, dbPath)
  }

  const delta = before.changedFiles + before.deletedFiles
  if (delta >= AUTO_REINDEX_THRESHOLD) return before

  await runIncrementalIndex({ repoRoot, dbPath })
  return checkFreshness(repoRoot, dbPath)
}
