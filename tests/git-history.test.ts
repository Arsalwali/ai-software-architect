import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectHistory } from '../src/git/history.js'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-hist-'))
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  run(['init', '-q'])
  run(['config', 'user.email', 'a@example.com'])
  run(['config', 'user.name', 'Author One'])
  return root
}

function commit(root: string, subject: string, files: Record<string, string>, author?: string): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
  const env = author
    ? { ...process.env, GIT_AUTHOR_NAME: author, GIT_COMMITTER_NAME: author }
    : process.env
  execFileSync('git', ['commit', '-q', '-m', subject], { cwd: root, stdio: 'ignore', env })
}

describe('collectHistory', () => {
  it('reports unavailable for a directory that is not a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'arch-plain-'))
    const h = collectHistory(plain)
    expect(h.available).toBe(false)
    expect(h.reason).toMatch(/not a git repository/i)
    expect(h.byFile.size).toBe(0)
  })

  it('counts commits per file', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' })
    commit(root, 'feat: two', { 'a.ts': '2' })
    commit(root, 'feat: three', { 'b.ts': '1' })
    const h = collectHistory(root)
    expect(h.available).toBe(true)
    expect(h.byFile.get('a.ts')!.commits).toBe(2)
    expect(h.byFile.get('b.ts')!.commits).toBe(1)
    expect(h.totalCommits).toBe(3)
  })

  it('counts distinct authors per file', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' }, 'Author One')
    commit(root, 'feat: two', { 'a.ts': '2' }, 'Author Two')
    commit(root, 'feat: three', { 'a.ts': '3' }, 'Author One')
    expect(collectHistory(root).byFile.get('a.ts')!.authors).toBe(2)
  })

  it('counts bug-fix commits by subject', () => {
    const root = repo()
    commit(root, 'feat: add', { 'a.ts': '1' })
    commit(root, 'fix: correct off-by-one', { 'a.ts': '2' })
    commit(root, 'fix(parser): handle empty input', { 'a.ts': '3' })
    commit(root, 'refactor: tidy', { 'a.ts': '4' })
    const file = collectHistory(root).byFile.get('a.ts')!
    expect(file.commits).toBe(4)
    expect(file.bugFixCommits).toBe(2)
  })

  it('does not treat a subject merely containing the word fix as a bug fix', () => {
    const root = repo()
    commit(root, 'docs: explain how to fix your config', { 'a.ts': '1' })
    expect(collectHistory(root).byFile.get('a.ts')!.bugFixCommits).toBe(0)
  })

  it('records the most recent commit date per file', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' })
    const at = collectHistory(root).byFile.get('a.ts')!.lastCommitAt
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('counts co-changes for files committed together', () => {
    const root = repo()
    commit(root, 'feat: pair', { 'a.ts': '1', 'b.ts': '1' })
    commit(root, 'feat: pair again', { 'a.ts': '2', 'b.ts': '2' })
    commit(root, 'feat: alone', { 'c.ts': '1' })
    const h = collectHistory(root)
    const pair = h.coChanges.find(p => p.a === 'a.ts' && p.b === 'b.ts')
    expect(pair!.commits).toBe(2)
    expect(h.coChanges.some(p => p.a === 'c.ts' || p.b === 'c.ts')).toBe(false)
  })

  it('orders each co-change pair consistently so the same pair never appears twice', () => {
    const root = repo()
    commit(root, 'feat: one', { 'z.ts': '1', 'a.ts': '1' })
    const h = collectHistory(root)
    expect(h.coChanges).toHaveLength(1)
    expect(h.coChanges[0]).toMatchObject({ a: 'a.ts', b: 'z.ts' })
  })

  it('skips co-change pairs for an oversized commit and REPORTS the skip', () => {
    const root = repo()
    const many: Record<string, string> = {}
    for (let i = 0; i < 6; i++) many[`f${i}.ts`] = 'x'
    commit(root, 'chore: sweep', many)
    const h = collectHistory(root, { largeCommitThreshold: 5 })
    expect(h.coChanges).toEqual([])
    expect(h.skippedLargeCommits).toBe(1)
    // Churn still counts: the files genuinely changed.
    expect(h.byFile.get('f0.ts')!.commits).toBe(1)
  })

  it('honours the window and reports it', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' })
    const h = collectHistory(root, { windowDays: 7 })
    expect(h.windowDays).toBe(7)
    expect(h.byFile.get('a.ts')!.commits).toBe(1)
  })

  it('returns an empty but available window for a repository with no commits in range', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' })
    const h = collectHistory(root, { windowDays: 0 })
    expect(h.available).toBe(true)
    expect(h.totalCommits).toBe(0)
  })
})
