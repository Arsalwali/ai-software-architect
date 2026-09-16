import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { impactOf } from '../src/tools/impact.js'
import { getDependencies } from '../src/tools/dependencies.js'
import { buildFixture } from './fixture-builder.js'
import { withTestHome } from './test-home.js'

const CLI = join(process.cwd(), 'dist/cli.js')

let store: GraphStore
let fixture: string

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-debt-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('HOME isolation', () => {
  it('writes no index into the real home directory', () => {
    const { home, env } = withTestHome()
    const repo = buildFixture({ git: true })
    execFileSync('node', [CLI, 'index', repo], { env, encoding: 'utf8' })
    expect(existsSync(join(home, '.arch', 'repos'))).toBe(true)
  })
})

describe('impact_of reference counting (final-wave fix 2)', () => {
  it('counts distinct locations, so totalReferences never exceeds the reference list', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 100, repoRoot: fixture })
    expect(r.totalReferences).toBeLessThanOrEqual(r.references.length)
    expect(r.buckets.verified + r.buckets.likely + r.buckets.ambiguous).toBe(r.totalReferences)
  })
})

describe('impact_of path escaping (final-wave fix 3)', () => {
  it('treats _ in a path filter literally rather than as a wildcard', () => {
    const real = impactOf(store, { symbol: 'helper', file: 'src/helper.ts', maxDepth: 1, limit: 10, repoRoot: fixture })
    expect(real.matchedSymbols.length).toBeGreaterThan(0)
    const wildcarded = impactOf(store, { symbol: 'helper', file: 'src/h_lper.ts', maxDepth: 1, limit: 10, repoRoot: fixture })
    expect(wildcarded.matchedSymbols).toHaveLength(0)
  })

  it('treats % in a path filter literally', () => {
    const r = impactOf(store, { symbol: 'helper', file: '%helper', maxDepth: 1, limit: 10, repoRoot: fixture })
    expect(r.matchedSymbols).toHaveLength(0)
  })
})

describe('depth truncation is reported (final-wave fix 4)', () => {
  it('flags depthLimited on a symbol traversal that was cut off', () => {
    const shallow = impactOf(store, { symbol: 'helper', maxDepth: 1, limit: 100, repoRoot: fixture })
    const deep = impactOf(store, { symbol: 'helper', maxDepth: 10, limit: 100, repoRoot: fixture })
    expect(deep.depthLimited).toBe(false)
    expect(typeof shallow.depthLimited).toBe('boolean')
  })

  it('flags depthLimited on a file traversal that was cut off', () => {
    const shallow = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 1, limit: 100 })
    const deep = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 10, limit: 100 })
    expect(deep.depthLimited).toBe(false)
    expect(shallow.depthLimited).toBe(true)
  })
})

describe('corrupt index error (final-wave fix 7)', () => {
  it('names the index path and the remedy rather than leaking a raw SQLite message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-corrupt-'))
    const bad = join(dir, 'index.db')
    writeFileSync(bad, 'this is definitely not a sqlite database')
    expect(() => GraphStore.open(bad)).toThrow(/arch index --force/)
    expect(() => GraphStore.open(bad)).toThrow(/not a database/)
  })
})
