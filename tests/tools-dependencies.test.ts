import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { getDependencies, resolveTarget } from '../src/tools/dependencies.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-dep-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('resolveTarget', () => {
  it('recognises an exact file path', () => {
    expect(resolveTarget(store, 'src/helper.ts')).toMatchObject({ kind: 'file', resolved: 'src/helper.ts' })
  })

  it('recognises a directory as a module', () => {
    expect(resolveTarget(store, 'src/services')).toMatchObject({ kind: 'module', resolved: 'src/services' })
  })

  it('falls back to a symbol name', () => {
    expect(resolveTarget(store, 'helper')).toMatchObject({ kind: 'symbol', resolved: 'helper' })
  })

  it('reports every candidate when a symbol name is not unique', () => {
    const t = resolveTarget(store, 'notify')
    expect(t.kind).toBe('symbol')
    expect(Array.isArray(t.candidates)).toBe(true)
  })

  it('returns kind "unknown" for something that matches nothing', () => {
    expect(resolveTarget(store, 'nothing/at/all').kind).toBe('unknown')
  })
})

describe('getDependencies at file level', () => {
  it('direction out lists what a file imports', () => {
    const r = getDependencies(store, { target: 'src/services/order.ts', direction: 'out', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/helper.ts')
  })

  it('direction in lists what imports a file', () => {
    const r = getDependencies(store, { target: 'src/helper.ts', direction: 'in', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/services/order.ts')
  })

  it('respects depth', () => {
    const shallow = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 1, limit: 50 })
    const deep = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 3, limit: 50 })
    expect(deep.nodes.length).toBeGreaterThanOrEqual(shallow.nodes.length)
    expect(deep.nodes.map(n => n.path)).toContain('src/helper.ts')
  })

  it('never revisits a node, so a cycle terminates', () => {
    const r = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 10, limit: 100 })
    const paths = r.nodes.map(n => n.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('treats a module target as the union of its files', () => {
    const r = getDependencies(store, { target: 'src/services', direction: 'out', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/helper.ts')
  })
})

describe('getDependencies at symbol level', () => {
  it('direction in lists callers of a symbol with their confidence', () => {
    const r = getDependencies(store, { target: 'helper', direction: 'in', depth: 1, limit: 50 })
    expect(r.nodes.some(n => n.path === 'src/services/order.ts' && n.confidence === 'heuristic')).toBe(true)
  })

  it('filters by minConfidence using the explicit rank', () => {
    const all = getDependencies(store, { target: 'helper', direction: 'in', depth: 2, limit: 50 })
    const strict = getDependencies(store, { target: 'helper', direction: 'in', depth: 2, minConfidence: 'exact', limit: 50 })
    expect(strict.nodes.length).toBeLessThanOrEqual(all.nodes.length)
    expect(strict.nodes).toHaveLength(0)   // nothing emits `exact` yet
  })

  it('truncates loudly', () => {
    const r = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 5, limit: 1 })
    expect(r.nodes).toHaveLength(1)
    expect(r.truncated!.total).toBeGreaterThan(1)
  })
})
