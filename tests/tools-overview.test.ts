import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { buildOverview } from '../src/tools/overview.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-ov-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('buildOverview', () => {
  it('reports totals', () => {
    const o = buildOverview(store)
    expect(o.totals.files).toBeGreaterThan(0)
    expect(o.totals.symbols).toBeGreaterThan(0)
    expect(o.totals.edges).toBeGreaterThan(0)
  })

  it('reports languages including files with no known language', () => {
    const o = buildOverview(store)
    expect(o.languages.find(l => l.lang === 'typescript')!.files).toBeGreaterThan(0)
    expect(o.languages.some(l => l.lang === null)).toBe(true)
  })

  it('reports the confidence breakdown WITHOUT merging unresolved into ambiguous', () => {
    const o = buildOverview(store)
    expect(o.edgeConfidence.unresolved).toBeGreaterThan(0)
    expect(o.edgeConfidence).toHaveProperty('ambiguous')
    expect(o.edgeConfidence).toHaveProperty('heuristic')
  })

  it('states plainly what fraction of call edges resolved to a target', () => {
    const o = buildOverview(store)
    expect(o.resolvedFraction).toBeGreaterThanOrEqual(0)
    expect(o.resolvedFraction).toBeLessThanOrEqual(1)
  })

  it('lists top-level modules with their file and symbol counts', () => {
    const o = buildOverview(store)
    const src = o.modules.find(m => m.path === 'src')!
    expect(src.files).toBeGreaterThan(0)
    expect(src.symbols).toBeGreaterThan(0)
  })

  it('surfaces the skip breakdown by reason', () => {
    const o = buildOverview(store)
    expect(o.skipped.total).toBeGreaterThan(0)
    expect(Object.keys(o.skipped.byReason).length).toBeGreaterThan(0)
  })

  it('reports parse errors from the per-file counts', () => {
    const o = buildOverview(store)
    expect(o.filesWithParseErrors).toBe(0)
  })

  it('detects entry points', () => {
    const o = buildOverview(store)
    expect(o.entryPoints).toContain('src/index.ts')
  })
})
