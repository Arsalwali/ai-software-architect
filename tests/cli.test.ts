import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildFixture } from './fixture-builder.js'
import { indexPathFor } from '../src/repo/repo-source.js'
import { GraphStore } from '../src/store/graph-store.js'
import { withTestHome } from './test-home.js'

const FIXTURE = buildFixture({ git: true })
const CLI = join(process.cwd(), 'dist/cli.js')
const { home: TEST_HOME, env: TEST_ENV } = withTestHome()

function run(args: string[]): string {
  return execFileSync('node', [CLI, ...args], { env: TEST_ENV, encoding: 'utf8' })
}

function commit(repoRoot: string, relativePath: string, content: string): void {
  writeFileSync(join(repoRoot, relativePath), content)
  execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' })
  execFileSync('git', ['commit', '-q', '-m', 'follow-up'], { cwd: repoRoot, stdio: 'ignore' })
}

/**
 * `run()` shells out to the CLI with HOME redirected to a throwaway
 * directory so the child process never touches the developer's real
 * ~/.arch. This test file also opens the resulting index directly via
 * `indexPathFor`, which resolves through `os.homedir()` in *this*
 * process -- so calls to it here must see the same redirected HOME the
 * child process used, or the path they compute won't match what the
 * child wrote. Scoped to just the `indexPathFor` call and restored
 * immediately after, so it can't leak into other test files.
 */
function indexPathUnderTestHome(repoRoot: string): string {
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  process.env.HOME = TEST_HOME
  process.env.USERPROFILE = TEST_HOME
  try {
    return indexPathFor(repoRoot)
  } finally {
    process.env.HOME = prevHome
    process.env.USERPROFILE = prevProfile
  }
}

describe('arch CLI', () => {
  it('indexes a repository and reports counts', () => {
    const output = run(['index', FIXTURE])
    expect(output).toMatch(/Indexed 7 files/)
    expect(output).toMatch(/symbols/)
    expect(output).toMatch(/edges/)
  })

  it('reports status for an indexed repository', () => {
    run(['index', FIXTURE])
    const output = run(['status', FIXTURE])
    expect(output).toMatch(/Files:\s+7/)
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
    const dbPath = indexPathUnderTestHome(incompleteFixture)
    const store = GraphStore.open(dbPath)
    store.setMeta('index_complete', '')
    store.close()
    const output = run(['status', incompleteFixture])
    expect(output).toMatch(/INCOMPLETE/)
  })

  it('exits non-zero with a readable message instead of a raw stack trace', () => {
    // GraphStore.open composes a specific, actionable message for a
    // schema-version mismatch. Before Fix 5 the CLI had no top-level error
    // handling, so this surfaced as an uncaught-exception stack trace with
    // the actual message buried several lines down.
    const mismatchFixture = buildFixture({ git: true })
    run(['index', mismatchFixture])
    const dbPath = indexPathUnderTestHome(mismatchFixture)
    const store = GraphStore.open(dbPath)
    store.setMeta('schema_version', '999')
    store.close()

    let error: (Error & { status?: number | null; stderr?: string }) | undefined
    try {
      run(['status', mismatchFixture])
    } catch (e) {
      error = e as typeof error
    }

    expect(error).toBeDefined()
    expect(error!.status).not.toBe(0)
    expect(error!.stderr).toMatch(/schema version/i)
    expect(error!.stderr).toMatch(/arch index --force/)
  })
})
