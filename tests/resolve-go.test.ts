import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goResolver, modulePrefixFrom } from '../src/resolve/go.js'

/**
 * `goResolver` reads `go.mod` from the `repoRoot` it is given — there is no
 * cwd fallback (see the doc comment on `goResolver` for why one existed
 * briefly and was removed) — so exercising it for real means giving it a
 * real directory with a real `go.mod` on disk, not injecting a prefix
 * directly.
 */
function repoWithGoMod(contents: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-go-resolve-'))
  if (contents !== null) writeFileSync(join(root, 'go.mod'), contents)
  return root
}

const known = new Set(['go.mod', 'helper/helper.go', 'service/service.go', 'main.go'])
const GO_MOD = 'module example.com/m\n\ngo 1.22\n'

describe('modulePrefixFrom', () => {
  it('reads the module line', () => {
    expect(modulePrefixFrom('module example.com/m\n\ngo 1.22\n')).toBe('example.com/m')
  })

  it('tolerates leading whitespace and trailing comments', () => {
    expect(modulePrefixFrom('  module   example.com/m // root\n')).toBe('example.com/m')
  })

  it('returns null when there is no module line', () => {
    expect(modulePrefixFrom('go 1.22\n')).toBeNull()
  })
})

describe('goResolver', () => {
  it('resolves an internal import to a file in the package directory', () => {
    const repoRoot = repoWithGoMod(GO_MOD)
    expect(goResolver.resolve('service/service.go', 'example.com/m/helper', known, repoRoot))
      .toEqual({ path: 'helper/helper.go', confidence: 'resolved' })
  })

  it('reports a standard-library import as unresolved', () => {
    const repoRoot = repoWithGoMod(GO_MOD)
    expect(goResolver.resolve('main.go', 'fmt', known, repoRoot))
      .toEqual({ path: null, confidence: 'unresolved' })
  })

  it('reports a third-party import as unresolved', () => {
    const repoRoot = repoWithGoMod(GO_MOD)
    expect(goResolver.resolve('main.go', 'github.com/pkg/errors', known, repoRoot))
      .toEqual({ path: null, confidence: 'unresolved' })
  })

  it('reports everything unresolved when the repository has no go.mod', () => {
    const repoRoot = repoWithGoMod(null)
    expect(goResolver.resolve('service/service.go', 'example.com/m/helper', known, repoRoot).path)
      .toBeNull()
  })

  it('resolves correctly for two different repositories in the same process, proving the cache is keyed per root', () => {
    const repoA = repoWithGoMod('module a.example.com\n')
    const repoB = repoWithGoMod('module b.example.com\n')
    expect(goResolver.resolve('x.go', 'a.example.com/pkg', new Set(['pkg/x.go']), repoA).path)
      .toBe('pkg/x.go')
    expect(goResolver.resolve('x.go', 'a.example.com/pkg', new Set(['pkg/x.go']), repoB).path)
      .toBeNull()
  })
})
