import { describe, it, expect, beforeAll } from 'vitest'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { discoverFiles } from '../src/indexer/discover.js'
import { indexPathFor } from '../src/repo/repo-source.js'
import { buildFixture } from './fixture-builder.js'

const EXPECTED_FILES = [
  '.config/settings.ts',
  '.eslintrc.js',
  'README.md',
  'src/helper.ts',
  'src/index.ts',
  'src/services/notify.ts',
  'src/services/order.ts',
]

let plainRoot: string
let gitRoot: string

beforeAll(() => {
  plainRoot = buildFixture()
  gitRoot = buildFixture({ git: true })

  // Constructed explicitly, not by relying on a delete/readdir race: a
  // symlink whose target does not exist. This gives the 'unreadable'
  // classification a deterministic case — the entry is a legitimate
  // candidate (walkCandidates now includes symlinks) but statSync throws
  // ENOENT, and that must be recorded rather than silently dropped.
  symlinkSync(join(plainRoot, 'does-not-exist.js'), join(plainRoot, 'broken-link.js'))
})

describe('discoverFiles (filesystem walk)', () => {
  it('finds source files and the unknown-language README', () => {
    expect(discoverFiles(plainRoot).files.sort()).toEqual(EXPECTED_FILES)
  })

  it('skips vendored directories with a reason', () => {
    const { skipped } = discoverFiles(plainRoot)
    expect(skipped.find(s => s.path.startsWith('node_modules'))?.reason).toBe('vendored')
  })

  it('skips minified bundles with a reason', () => {
    const { skipped } = discoverFiles(plainRoot)
    expect(skipped.find(s => s.path === 'bundle.min.js')?.reason).toBe('minified')
  })

  it('skips binary files with a reason instead of indexing them', () => {
    const { files, skipped } = discoverFiles(plainRoot)
    expect(skipped.find(s => s.path === 'assets/logo.png')?.reason).toBe('binary')
    expect(files).not.toContain('assets/logo.png')
  })

  it('records a broken symlink as unreadable instead of letting it vanish', () => {
    const { files, skipped } = discoverFiles(plainRoot)
    expect(skipped.find(s => s.path === 'broken-link.js')?.reason).toBe('unreadable')
    expect(files).not.toContain('broken-link.js')
  })

  it('never silently omits: every skipped entry carries a reason', () => {
    const { skipped } = discoverFiles(plainRoot)
    expect(skipped.length).toBeGreaterThan(0)
    for (const entry of skipped) expect(entry.reason).toBeTruthy()
    // Concrete, not tautological: specific known-bad paths must land under
    // specific reasons, not merely "some truthy string". This is the
    // covering test for the Critical statSync-throw bug — with `continue`
    // instead of pushing to `skipped`, these entries would vanish from both
    // `files` and `skipped`, and this assertion (unlike a bare loop over
    // `skipped`) would catch that.
    const byPath = new Map(skipped.map(s => [s.path, s.reason]))
    expect(byPath.get('node_modules/<directory>')).toBe('vendored')
    expect(byPath.get('bundle.min.js')).toBe('minified')
    expect(byPath.get('assets/logo.png')).toBe('binary')
    expect(byPath.get('broken-link.js')).toBe('unreadable')
  })
})

describe('discoverFiles (git ls-files)', () => {
  it('finds the same files as the filesystem walk', () => {
    expect(discoverFiles(gitRoot).files.sort()).toEqual(EXPECTED_FILES)
  })

  it('still skips vendored, minified, and binary files', () => {
    const reasons = new Set(discoverFiles(gitRoot).skipped.map(s => s.reason))
    expect(reasons.has('vendored')).toBe(true)
    expect(reasons.has('minified')).toBe(true)
    expect(reasons.has('binary')).toBe(true)
  })
})

describe('discoverFiles (cross-branch parity)', () => {
  it('the git branch and the filesystem-walk branch agree on exactly the same files', () => {
    // The single highest-value assertion for this class of bug: init'ing
    // git must not change what gets indexed. Comparing both branches
    // directly (rather than each separately against a fixed EXPECTED_FILES)
    // is what actually catches a regression where both branches drift the
    // same way, or where EXPECTED_FILES itself is stale.
    expect(discoverFiles(gitRoot).files.sort()).toEqual(discoverFiles(plainRoot).files.sort())
  })
})

describe('indexPathFor', () => {
  it('is deterministic and repo-specific', () => {
    expect(indexPathFor('/a/b')).toBe(indexPathFor('/a/b'))
    expect(indexPathFor('/a/b')).not.toBe(indexPathFor('/a/c'))
    expect(indexPathFor('/a/b')).toMatch(/\.arch\/repos\/[0-9a-f]{16}\/index\.db$/)
  })
})
