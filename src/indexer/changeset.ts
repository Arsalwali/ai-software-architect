import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverFiles, type SkippedFile } from './discover.js'
import type { GraphStore } from '../store/graph-store.js'

export interface ChangeSet {
  /** New or modified files needing a re-parse. */
  changed: string[]
  /** Indexed paths that are no longer discoverable — removed, or now skipped. */
  deleted: string[]
  /** Indexed paths whose content hash is unchanged. */
  unchanged: string[]
  /** Current skip classification, carried through for the finalize step. */
  skipped: SkippedFile[]
}

/**
 * Compares the repository on disk against what the index holds.
 *
 * Content hashes are the comparison, not git. That keeps one code path
 * correct for git and non-git repositories alike, and a hash cannot
 * disagree with the file the way a git-derived list can when the working
 * tree has moved. See the plan's design ruling for the full argument.
 */
export function computeChangeSet(repoRoot: string, store: GraphStore): ChangeSet {
  const { files, skipped } = discoverFiles(repoRoot)
  const indexed = store.contentHashByPath()

  const changed: string[] = []
  const unchanged: string[] = []
  const discovered = new Set<string>()

  for (const path of files) {
    discovered.add(path)
    const current = hashOf(join(repoRoot, path))
    if (current === null) {
      // Readable a moment ago during discovery, gone now. Treat as changed so
      // the re-parse records it as an error rather than silently keeping stale data.
      changed.push(path)
      continue
    }
    if (indexed.get(path) === current) unchanged.push(path)
    else changed.push(path)
  }

  // Anything indexed but no longer discoverable has left the graph. That
  // covers outright deletion AND a file that became skippable — newly
  // vendored, newly minified, newly too large. Both must drop their rows,
  // or the graph keeps symbols for code that is no longer part of the repo.
  const deleted = [...indexed.keys()].filter(path => !discovered.has(path))

  return {
    changed: changed.sort(),
    deleted: deleted.sort(),
    unchanged: unchanged.sort(),
    skipped,
  }
}

function hashOf(absolutePath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
  } catch {
    return null
  }
}
