import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { buildFixture } from './fixture-builder.js'

const FIXTURE = buildFixture({ git: true })
const CLI = join(process.cwd(), 'dist/cli.js')

function run(args: string[]): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8' })
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
})
