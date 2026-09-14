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

// Hash the utf8-decoded string, not the raw Buffer. `RepoParser.parse`
// (see src/parser/parser.ts) hashes the string produced by
// `readFileSync(path, 'utf8')` in parse-worker.ts, and that decode is
// lossy: any byte sequence that isn't valid UTF-8 becomes U+FFFD, which
// re-encodes to different bytes than the original. Hashing the raw Buffer
// here would therefore disagree with the stored hash for any file with an
// invalid-UTF-8 byte and no NUL byte — such a file passes discovery's
// binary sniff as ordinary source, so it isn't excluded the way true
// binaries are. Applying the identical lossy decode on both sides makes
// the two hashes agree by construction, for every file, not by luck.
function hashOf(absolutePath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(absolutePath, 'utf8')).digest('hex')
  } catch {
    return null
  }
}
