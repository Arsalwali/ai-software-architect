import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { git, isGitRepo } from '../repo/repo-source.js'
import { languageForPath } from '../parser/languages.js'

export type SkipReason = 'vendored' | 'too-large' | 'minified' | 'binary'

export interface SkippedFile {
  path: string
  reason: SkipReason
}

export interface DiscoveryResult {
  files: string[]
  skipped: SkippedFile[]
}

const VENDORED = new Set(['node_modules', 'vendor', 'dist', 'build', '.venv', 'venv', '.git', 'target'])
const MAX_BYTES = 1_000_000
const MAX_AVERAGE_LINE_LENGTH = 500

export function discoverFiles(repoRoot: string): DiscoveryResult {
  const candidates = isGitRepo(repoRoot) ? gitCandidates(repoRoot) : walkCandidates(repoRoot)

  const files: string[] = []
  const skipped: SkippedFile[] = []

  for (const path of candidates) {
    if (path.split(sep).some(segment => VENDORED.has(segment))) {
      skipped.push({ path, reason: 'vendored' })
      continue
    }

    const absolute = join(repoRoot, path)
    let size: number
    try {
      size = statSync(absolute).size
    } catch {
      continue
    }
    if (size > MAX_BYTES) {
      skipped.push({ path, reason: 'too-large' })
      continue
    }
    if (languageForPath(path) && isMinified(absolute, path)) {
      skipped.push({ path, reason: 'minified' })
      continue
    }
    files.push(path)
  }

  return { files, skipped }
}

/**
 * Tracked files plus untracked-but-not-ignored files. The second set matters:
 * a file created and not yet committed is exactly the file you want indexed.
 */
function gitCandidates(repoRoot: string): string[] {
  const tracked = git(repoRoot, ['ls-files']) ?? ''
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']) ?? ''
  const all = [...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean)
  return [...new Set(all)]
}

function walkCandidates(repoRoot: string): string[] {
  const ignored = readGitignoreDirectories(repoRoot)
  const out: string[] = []

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
      const absolute = join(dir, entry.name)
      const rel = relative(repoRoot, absolute)
      if (entry.isDirectory()) {
        // Skip vendored and gitignored trees without descending. Enumerating
        // node_modules would defeat the purpose; one marker entry satisfies the
        // never-silently-omit rule instead of thousands.
        if (VENDORED.has(entry.name) || ignored.has(entry.name)) {
          out.push(join(rel, '<directory>'))
          continue
        }
        visit(absolute)
      } else if (entry.isFile() && entry.name !== '.gitignore') {
        out.push(rel)
      }
    }
  }

  visit(repoRoot)
  return out
}

function readGitignoreDirectories(repoRoot: string): Set<string> {
  try {
    const lines = readFileSync(join(repoRoot, '.gitignore'), 'utf8').split('\n')
    return new Set(
      lines.map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/\/$/, '')),
    )
  } catch {
    return new Set()
  }
}

function isMinified(absolute: string, path: string): boolean {
  if (/\.min\.[a-z]+$/.test(path)) return true
  try {
    const source = readFileSync(absolute, 'utf8')
    const lines = source.split('\n')
    return source.length / Math.max(lines.length, 1) > MAX_AVERAGE_LINE_LENGTH
  } catch {
    return false
  }
}
