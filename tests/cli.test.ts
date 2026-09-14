import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildFixture } from './fixture-builder.js'
import { indexPathFor } from '../src/repo/repo-source.js'
import { GraphStore } from '../src/store/graph-store.js'

const FIXTURE = buildFixture({ git: true })
const CLI = join(process.cwd(), 'dist/cli.js')

function run(args: string[]): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8' })
}

function commit(repoRoot: string, relativePath: string, content: string): void {
  writeFileSync(join(repoRoot, relativePath), content)
  execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'follow-up'], { cwd: repoRoot, stdio: 'ignore' })
}

describe('arch CLI', () => {
  it('indexes a repository and reports counts', () => {
    const output = run(['index', FIXTURE])
    expect(output).toMatch(/Indexed 5 files/)
    expect(output).toMatch(/symbols/)
    expect(output).toMatch(/edges/)
  })

  it('reports status for an indexed repository', () => {
    run(['index', FIXTURE])
    const output = run(['status', FIXTURE])
    expect(output).toMatch(/Files:\s+5/)
    expect(output).toMatch(/Index:/)
  })

  it('reports a clear message for a repository with no index', () => {
    const output = run(['status', buildFixture()])
    expect(output).toMatch(/No index/)
  })

  it('reports current (not INCOMPLETE) for a successfully indexed non-git repository', () => {
    // Regression test for the head_commit overload: a non-git repo's
    // head_commit is '' on success too, so status must not mistake that
    // for an interrupted run.
    const nonGitFixture = buildFixture()
    run(['index', nonGitFixture])
    const output = run(['status', nonGitFixture])
    expect(output).toMatch(/current/)
    expect(output).not.toMatch(/INCOMPLETE/)
  })

  it('reports STALE when the repository has moved past the indexed commit', () => {
    const staleFixture = buildFixture({ git: true })
    run(['index', staleFixture])
    commit(staleFixture, 'src/helper.ts', 'export function helper(n: number): number {\n  return n + 2;\n}\n')
    const output = run(['status', staleFixture])
    expect(output).toMatch(/STALE/)
  })

  it('reports INCOMPLETE when a previous run did not finish', () => {
    const incompleteFixture = buildFixture({ git: true })
    run(['index', incompleteFixture])
    const dbPath = indexPathFor(incompleteFixture)
    const store = GraphStore.open(dbPath)
    store.setMeta('index_complete', '')
    store.close()
    const output = run(['status', incompleteFixture])
    expect(output).toMatch(/INCOMPLETE/)
  })
})
