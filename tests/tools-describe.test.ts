import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { getSymbol } from '../src/tools/symbol.js'
import { describeModule } from '../src/tools/module.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-desc-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('getSymbol', () => {
  it('returns the definition site and signature', () => {
    const r = getSymbol(store, { name: 'helper', limit: 10 })
    expect(r.matches[0]).toMatchObject({ path: 'src/helper.ts', kind: 'function', exported: true })
    expect(r.matches[0].line).toBeGreaterThan(0)
  })

  it('reports caller and callee counts', () => {
    const r = getSymbol(store, { name: 'helper', limit: 10 })
    expect(r.matches[0].callerCount).toBeGreaterThan(0)
    // helper's body is `return n + 1` -- it makes no calls of its own, so
    // calleeCount must be asserted concretely. A bare `typeof ... === 'number'`
    // check would still pass a regression that hardcoded any number here.
    expect(r.matches[0].calleeCount).toBe(0)
  })

  it('returns every match when a name is not unique, rather than guessing', () => {
    const r = getSymbol(store, { name: 'notify', limit: 10 })
    expect(r.matches.length).toBeGreaterThanOrEqual(1)
    expect(r.totalMatches).toBe(r.matches.length)
  })

  it('explains an unknown symbol rather than returning an empty success', () => {
    const r = getSymbol(store, { name: 'noSuchSymbolAnywhere', limit: 10 })
    expect(r.matches).toEqual([])
    expect(r.note).toMatch(/not found/i)
  })

  it('treats an underscore in the file filter literally, not as a wildcard', () => {
    expect(getSymbol(store, { name: 'helper', file: 'src/h_lper.ts', limit: 10 }).matches).toEqual([])
    expect(getSymbol(store, { name: 'helper', file: 'src/helper.ts', limit: 10 }).matches.length).toBeGreaterThan(0)
  })
})

describe('describeModule', () => {
  it('lists the module files and its exported surface', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    expect(r.files).toContain('src/services/order.ts')
    expect(r.publicSurface.some(s => s.name === 'notify')).toBe(true)
  })

  it('reports dependencies and dependents with edge weights', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    expect(r.dependencies.some(d => d.module === 'src')).toBe(true)
    expect(r.dependents.some(d => d.module === 'src')).toBe(true)
  })

  it('reports coupling metrics for the module', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    // Fixture-derived, not incidental: src/services has exactly one distinct
    // resolved cross-module import out (order.ts -> src/helper.ts) and one in
    // (src/index.ts -> order.ts), so efferent=1, afferent=1 and
    // instability = efferent / (afferent + efferent) = 0.5. A bare
    // `typeof ... === 'number'` check would still pass a regression that
    // hardcoded any number here.
    expect(r.coupling).toMatchObject({ module: 'src/services', afferent: 1, efferent: 1, instability: 0.5 })
  })

  it('returns summary null with a reason, since the summarizer is not built yet', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    expect(r.summary).toBeNull()
    expect(r.summaryUnavailableReason).toMatch(/not.*(built|available|implemented)/i)
  })

  it('explains an unknown module rather than returning an empty success', () => {
    const r = describeModule(store, { path: 'src/nowhere', limit: 50 })
    expect(r.files).toEqual([])
    expect(r.note).toMatch(/no indexed files/i)
  })
})
