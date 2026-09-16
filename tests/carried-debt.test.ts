import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { impactOf } from '../src/tools/impact.js'
import { getDependencies } from '../src/tools/dependencies.js'
import { buildFixture } from './fixture-builder.js'
import { withTestHome } from './test-home.js'

const CLI = join(process.cwd(), 'dist/cli.js')

/**
 * Writes an ad hoc repository into a fresh temp dir, independent of the
 * shared `buildFixture` fixture, mirroring the identical helper in
 * tests/tools-impact.test.ts (twenty tasks assert on buildFixture's exact
 * contents, so it must not be touched or overloaded here).
 */
function writeLocalFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-debt-local-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

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
  // The shared fixture's `helper` has single-import, single-candidate call
  // sites, so no two edges ever land on the same path:line there -- an
  // inequality of "<=" against it would hold trivially even if dedup were
  // removed entirely. This dedicated fixture (adapted from the identical
  // ambiguous-collision pattern in tests/tools-impact.test.ts) gives one
  // call site a genuine fan-out: `shared` is exported by both a.ts and
  // b.ts; consumer.ts resolves imports to both (via helperA/helperB) and
  // calls the bare identifier `shared()`, which resolves ambiguously to
  // BOTH definitions -- two edges at one path:line. onlyA.ts's import
  // resolves uniquely, adding one more (distinct) location. So
  // references.length is 3 raw edges, but only 2 distinct locations.
  let ambStore: GraphStore

  beforeAll(async () => {
    const ambFixture = writeLocalFixture({
      'src/a.ts':
        'export function shared(): number {\n  return 1;\n}\n' +
        'export function helperA(): number {\n  return 0;\n}\n',
      'src/b.ts':
        'export function shared(): number {\n  return 2;\n}\n' +
        'export function helperB(): number {\n  return 0;\n}\n',
      'src/consumer.ts':
        'import { helperA } from "./a";\n' +
        'import { helperB } from "./b";\n' +
        'export function run(): number {\n  return shared();\n}\n',
      'src/onlyA.ts':
        'import { shared } from "./a";\n' +
        'export function callOnlyA(): number {\n  return shared();\n}\n',
    })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-debt-amb-')), 'index.db')
    await runColdIndex({ repoRoot: ambFixture, dbPath })
    ambStore = GraphStore.open(dbPath)
  })

  it('counts distinct locations, so totalReferences is strictly less than the raw edge list when one call site fans out', () => {
    const r = impactOf(ambStore, { symbol: 'shared', maxDepth: 3, limit: 100 })
    expect(r.totalReferences).toBeLessThan(r.references.length)
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
    // helper's only caller is OrderService.place (src/services/order.ts);
    // place's enclosing symbol is itself referenced by top-level code in
    // src/index.ts that isn't inside a resolvable symbol, so the reverse
    // walk from `helper` genuinely still has `place` on its frontier when
    // maxDepth 1 runs out of budget, and genuinely empties out by depth 2.
    // Confirmed empirically against this fixture before writing this
    // assertion, per review: maxDepth 1 -> depthLimited true, maxDepth 2+
    // -> depthLimited false, with an identical single-reference result set.
    const shallow = impactOf(store, { symbol: 'helper', maxDepth: 1, limit: 100, repoRoot: fixture })
    const deep = impactOf(store, { symbol: 'helper', maxDepth: 10, limit: 100, repoRoot: fixture })
    expect(deep.depthLimited).toBe(false)
    expect(shallow.depthLimited).toBe(true)
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
