import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function indexPathFor(repoRoot: string): string {
  const digest = createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 16)
  return join(homedir(), '.arch', 'repos', digest, 'index.db')
}

export function isGitRepo(repoRoot: string): boolean {
  return git(repoRoot, ['rev-parse', '--is-inside-work-tree']) === 'true'
}

export function gitHeadCommit(repoRoot: string): string | null {
  return git(repoRoot, ['rev-parse', 'HEAD'])
}

/** Runs git, returning trimmed stdout or null when git fails for any reason. */
export function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}
