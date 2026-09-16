import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { traceFlow } from '../src/tools/flow.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-flow-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('traceFlow', () => {
  it('walks forward from an entry symbol', () => {
    const r = traceFlow(store, { entry: 'place', maxDepth: 3, limit: 50 })
    expect(r.root).not.toBeNull()
    expect(r.root!.name).toBe('place')
    expect(r.root!.calls.length).toBeGreaterThan(0)
  })

  it('annotates each step with its file and whether it crosses a module boundary', () => {
    const r = traceFlow(store, { entry: 'place', maxDepth: 3, limit: 50 })
    const step = r.root!.calls.find(c => c.name === 'helper')!
    expect(step.path).toBe('src/helper.ts')
    expect(step.crossesModule).toBe(true)
    expect(step.confidence).toBe('heuristic')
  })

  it('reports an external call as unresolved without trying to expand it', () => {
    const r = traceFlow(store, { entry: 'notify', maxDepth: 3, limit: 50 })
    const external = r.root!.calls.find(c => c.name === 'log')!
    expect(external.confidence).toBe('unresolved')
    expect(external.path).toBeNull()
    expect(external.calls).toEqual([])
  })

  it('honours maxDepth and reports when it was cut off', () => {
    const shallow = traceFlow(store, { entry: 'place', maxDepth: 1, limit: 50 })
    expect(shallow.depthLimited).toBe(true)
    const deep = traceFlow(store, { entry: 'place', maxDepth: 10, limit: 50 })
    expect(deep.depthLimited).toBe(false)
  })

  it('explains an unknown entry rather than returning an empty tree', () => {
    const r = traceFlow(store, { entry: 'noSuchEntryPoint', maxDepth: 3, limit: 50 })
    expect(r.root).toBeNull()
    expect(r.note).toMatch(/not found/i)
  })

  it('marks a node already expanded elsewhere as repeated rather than expanding it twice', () => {
    const r = traceFlow(store, { entry: 'place', maxDepth: 10, limit: 100 })
    const seen = new Set<string>()
    const walk = (node: { name: string; path: string | null; repeated: boolean; calls: any[] }): void => {
      const key = `${node.path}:${node.name}`
      if (!node.repeated && node.path !== null) {
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
      for (const child of node.calls) walk(child)
    }
    walk(r.root!)
  })
})
