import { git, isGitRepo } from '../repo/repo-source.js'

export interface FileHistory {
  path: string
  commits: number
  /** Distinct commit authors. */
  authors: number
  /** Commits whose subject looks like a bug fix. */
  bugFixCommits: number
  /** ISO-8601 date of the most recent commit touching this file. */
  lastCommitAt: string | null
}

export interface CoChangePair {
  /** Lexicographically first path, so a pair is only ever recorded once. */
  a: string
  b: string
  commits: number
}

export interface HistoryWindow {
  available: boolean
  /** Why history is unavailable. Present only when `available` is false. */
  reason?: string
  windowDays: number
  totalCommits: number
  /** Commits excluded from co-change pairing for touching too many files. */
  skippedLargeCommits: number
  largeCommitThreshold: number
  byFile: Map<string, FileHistory>
  coChanges: CoChangePair[]
}

export const DEFAULT_WINDOW_DAYS = 180
export const DEFAULT_LARGE_COMMIT_THRESHOLD = 50

// 0x1E and 0x1F. Neither can appear in a file path or a git subject, which
// is why they are safe delimiters where a '|' would not be.
const RECORD_SEPARATOR = '\u001e'
const UNIT_SEPARATOR = '\u001f'

/**
 * Conventional-commit and plain prefixes. Deliberately anchored: a subject
 * merely mentioning "fix" ("docs: explain how to fix your config") is not a
 * bug fix, and counting it would inflate the signal hotspots multiply by.
 */
const BUG_FIX_SUBJECT = /^(fix|bugfix|hotfix|patch)([(:! ]|$)/i

export interface HistoryOptions {
  windowDays?: number
  largeCommitThreshold?: number
}

export function collectHistory(repoRoot: string, options: HistoryOptions = {}): HistoryWindow {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const largeCommitThreshold = options.largeCommitThreshold ?? DEFAULT_LARGE_COMMIT_THRESHOLD

  const empty: HistoryWindow = {
    available: false,
    windowDays,
    totalCommits: 0,
    skippedLargeCommits: 0,
    largeCommitThreshold,
    byFile: new Map(),
    coChanges: [],
  }

  if (!isGitRepo(repoRoot)) {
    return { ...empty, reason: 'Not a git repository, so churn and co-change signals are unavailable.' }
  }

  // Record and unit separators cannot occur in a path or a git subject, so
  // repository content cannot confuse this parse.
  //
  // For windowDays <= 0 we deliberately do not use `--since=0 days ago`:
  // git resolves that to the current wall-clock second, and commit
  // timestamps only have second resolution, so a commit made moments
  // earlier in the same second as this call would still be >= the cutoff
  // and get included -- making the "empty window" case racy. An explicit
  // one-second-in-the-future epoch cutoff can never match an existing
  // commit, so it deterministically yields no commits.
  const sinceArg =
    windowDays > 0 ? `${windowDays} days ago` : `@${Math.floor(Date.now() / 1000) + 1}`
  const raw = git(repoRoot, [
    'log',
    `--since=${sinceArg}`,
    `--pretty=format:${RECORD_SEPARATOR}%H${UNIT_SEPARATOR}%an${UNIT_SEPARATOR}%aI${UNIT_SEPARATOR}%s`,
    '--name-only',
    '--no-merges',
  ])

  if (raw === null) {
    return { ...empty, reason: 'git log failed, so churn and co-change signals are unavailable.' }
  }

  const byFile = new Map<string, FileHistory>()
  const authorsByFile = new Map<string, Set<string>>()
  const pairCounts = new Map<string, number>()
  let totalCommits = 0
  let skippedLargeCommits = 0

  for (const record of raw.split(RECORD_SEPARATOR)) {
    if (record.trim().length === 0) continue

    const lines = record.split('\n')
    const header = lines[0].split(UNIT_SEPARATOR)
    if (header.length < 4) continue

    const author = header[1]
    const committedAt = header[2]
    const subject = header[3]
    const isBugFix = BUG_FIX_SUBJECT.test(subject)
    const paths = lines.slice(1).map(l => l.trim()).filter(l => l.length > 0)

    totalCommits += 1

    for (const path of paths) {
      let entry = byFile.get(path)
      if (!entry) {
        entry = { path, commits: 0, authors: 0, bugFixCommits: 0, lastCommitAt: null }
        byFile.set(path, entry)
        authorsByFile.set(path, new Set())
      }
      entry.commits += 1
      if (isBugFix) entry.bugFixCommits += 1
      // git log is newest-first, so the first date seen for a file is its latest.
      if (entry.lastCommitAt === null) entry.lastCommitAt = committedAt
      authorsByFile.get(path)!.add(author)
    }

    // A sweep touching hundreds of files produces a quadratic blast of pairs
    // that says nothing about coupling. Skip pairing, keep churn, report it.
    if (paths.length > largeCommitThreshold) {
      skippedLargeCommits += 1
      continue
    }

    const sorted = [...paths].sort()
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\n${sorted[j]}`
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
      }
    }
  }

  for (const [path, authors] of authorsByFile) {
    byFile.get(path)!.authors = authors.size
  }

  const coChanges: CoChangePair[] = []
  for (const [key, commits] of pairCounts) {
    const split = key.indexOf('\n')
    coChanges.push({ a: key.slice(0, split), b: key.slice(split + 1), commits })
  }
  coChanges.sort((x, y) => y.commits - x.commits || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))

  return {
    available: true,
    windowDays,
    totalCommits,
    skippedLargeCommits,
    largeCommitThreshold,
    byFile,
    coChanges,
  }
}
