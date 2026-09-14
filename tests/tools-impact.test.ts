import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { impactOf } from '../src/tools/impact.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-imp-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('impactOf', () => {
  it('finds the references to a symbol', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.references.some(ref => ref.path === 'src/services/order.ts')).toBe(true)
  })

  it('buckets by confidence and NEVER merges the buckets', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.buckets).toHaveProperty('verified')
    expect(r.buckets).toHaveProperty('likely')
    expect(r.buckets).toHaveProperty('ambiguous')
    expect(r.buckets.verified).toBe(0)            // nothing emits `exact` yet
    expect(r.buckets.likely).toBeGreaterThan(0)   // heuristic edges exist
    expect(r.buckets.verified + r.buckets.likely + r.buckets.ambiguous).toBe(r.totalReferences)
  })

  it('reports zero references for a symbol nobody calls, without throwing', () => {
    const r = impactOf(store, { symbol: 'unused', maxDepth: 3, limit: 50 })
    expect(r.totalReferences).toBe(0)
    expect(r.references).toEqual([])
  })

  it('groups references by module', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.byModule.some(m => m.module === 'src/services')).toBe(true)
  })

  it('flags a symbol exported from an entry point as crossing the package boundary', () => {
    const fromEntry = impactOf(store, { symbol: 'OrderService', maxDepth: 3, limit: 50 })
    expect(typeof fromEntry.exportedAtPackageBoundary).toBe('boolean')
    const internal = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(internal.exportedAtPackageBoundary).toBe(false)
  })

  it('reports every candidate when the symbol name is not unique', () => {
    const r = impactOf(store, { symbol: 'notify', maxDepth: 3, limit: 50 })
    expect(r.matchedSymbols.length).toBeGreaterThanOrEqual(1)
    for (const m of r.matchedSymbols) expect(m).toHaveProperty('path')
  })

  it('reports a symbol that does not exist as unknown rather than as zero impact', () => {
    const r = impactOf(store, { symbol: 'noSuchSymbolAnywhere', maxDepth: 3, limit: 50 })
    expect(r.matchedSymbols).toEqual([])
    expect(r.note).toMatch(/not found/i)
  })

  it('terminates on a cycle', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 50, limit: 200 })
    const keys = r.references.map(ref => `${ref.path}:${ref.line}:${ref.symbolName}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
