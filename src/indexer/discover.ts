import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { git, isGitRepo } from '../repo/repo-source.js'
import { languageForPath } from '../parser/languages.js'

export type SkipReason = 'vendored' | 'too-large' | 'minified' | 'binary' | 'unreadable' | 'not-a-file'

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
const BINARY_SNIFF_BYTES = 8000

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
    let stats: ReturnType<typeof statSync>
    try {
      // statSync follows symlinks, so a symlink to a real file lands here as
      // a regular file, a symlink to a directory is caught by the isFile()
      // check below, and a broken symlink (or any other path that no longer
      // exists, e.g. a tracked-but-rm'd file, or a synthetic directory
      // marker) throws and is recorded rather than silently dropped.
      stats = statSync(absolute)
    } catch {
      skipped.push({ path, reason: 'unreadable' })
      continue
    }
    if (!stats.isFile()) {
      skipped.push({ path, reason: 'not-a-file' })
      continue
    }
    if (stats.size > MAX_BYTES) {
      skipped.push({ path, reason: 'too-large' })
      continue
    }

    const language = languageForPath(path)
    if (language) {
      if (isMinified(absolute, path)) {
        skipped.push({ path, reason: 'minified' })
        continue
      }
    } else if (isBinary(absolute)) {
      skipped.push({ path, reason: 'binary' })
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
      // Dotfiles and dot-directories are real candidates, not noise: source
      // lives in .storybook/, .github/scripts/, .config/, etc. The only
      // dot-entry that must never be walked into is .git itself, and that is
      // already covered by the VENDORED set below (not by a name-prefix check
      // here, which used to drop everything dotted, .gitignore included).
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
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Symlinks are included as candidates so they can't vanish without a
        // diagnostic. statSync above resolves what they point at: a real
        // file is indexed normally, a directory hits not-a-file, and a
        // broken link hits unreadable.
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

/**
 * Sniffs for a NUL byte in the first BINARY_SNIFF_BYTES bytes. Only called
 * for paths with no known language (languageForPath returned null), where an
 * extension denylist can't work because the extension is unknown by
 * definition. Reads as a Buffer, not a utf8 string — decoding as utf8 would
 * substitute replacement characters and destroy the exact signal (0x00)
 * being tested for.
 */
function isBinary(absolute: string): boolean {
  let fd: number
  try {
    fd = openSync(absolute, 'r')
  } catch {
    return false
  }
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } catch {
    return false
  } finally {
    closeSync(fd)
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
