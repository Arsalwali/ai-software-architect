import { describe, it, expect, beforeAll } from 'vitest'
import { discoverFiles } from '../src/indexer/discover.js'
import { indexPathFor } from '../src/repo/repo-source.js'
import { buildFixture } from './fixture-builder.js'

const EXPECTED_FILES = [
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

  it('never silently omits: every skipped entry carries a reason', () => {
    const { skipped } = discoverFiles(plainRoot)
    expect(skipped.length).toBeGreaterThan(0)
    for (const entry of skipped) expect(entry.reason).toBeTruthy()
  })
})

describe('discoverFiles (git ls-files)', () => {
  it('finds the same files as the filesystem walk', () => {
    expect(discoverFiles(gitRoot).files.sort()).toEqual(EXPECTED_FILES)
  })

  it('still skips vendored and minified files', () => {
    const reasons = new Set(discoverFiles(gitRoot).skipped.map(s => s.reason))
    expect(reasons.has('vendored')).toBe(true)
    expect(reasons.has('minified')).toBe(true)
  })
})

describe('indexPathFor', () => {
  it('is deterministic and repo-specific', () => {
    expect(indexPathFor('/a/b')).toBe(indexPathFor('/a/b'))
    expect(indexPathFor('/a/b')).not.toBe(indexPathFor('/a/c'))
    expect(indexPathFor('/a/b')).toMatch(/\.arch\/repos\/[0-9a-f]{16}\/index\.db$/)
  })
})
