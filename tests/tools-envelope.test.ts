import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { CONFIDENCE_RANK, truncate, withIndex, toolText } from '../src/tools/envelope.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string

beforeEach(async () => {
  fixture = buildFixture({ git: true })
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-env-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
})

describe('CONFIDENCE_RANK', () => {
  it('ranks ambiguous above unresolved, because ambiguous names real candidates', () => {
    expect(CONFIDENCE_RANK.ambiguous).toBeGreaterThan(CONFIDENCE_RANK.unresolved)
    expect(CONFIDENCE_RANK.exact).toBeGreaterThan(CONFIDENCE_RANK.heuristic)
    expect(CONFIDENCE_RANK.heuristic).toBeGreaterThan(CONFIDENCE_RANK.ambiguous)
  })

  it('assigns a rank to every confidence value', () => {
    for (const c of ['exact', 'resolved', 'heuristic', 'unresolved', 'ambiguous'] as const) {
      expect(typeof CONFIDENCE_RANK[c]).toBe('number')
    }
  })
})

describe('truncate', () => {
  it('returns everything and no marker when under the limit', () => {
    expect(truncate([1, 2, 3], 10)).toEqual({ items: [1, 2, 3] })
  })

  it('truncates loudly, reporting the TRUE total', () => {
    const r = truncate([1, 2, 3, 4, 5], 2)
    expect(r.items).toEqual([1, 2])
    expect(r.truncated).toEqual({ returned: 2, total: 5 })
  })

  it('handles an exact-limit list without claiming truncation', () => {
    expect(truncate([1, 2], 2).truncated).toBeUndefined()
  })
})

describe('withIndex', () => {
  it('wraps a result with the index status', async () => {
    const env = await withIndex(fixture, () => ({ hello: 'world' }), dbPath)
    expect(env.result).toEqual({ hello: 'world' })
    expect(env.index.state).toBe('current')
    expect(env.index.repoRoot).toBe(fixture)
  })

  it('absorbs a small delta so the tool sees a current index', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n + 3; }\n')
    const env = await withIndex(fixture, store => store.allFilePaths().length, dbPath)
    expect(env.index.state).toBe('current')
    expect(typeof env.result).toBe('number')
  })

  it('closes the store even when the callback throws', async () => {
    await expect(withIndex(fixture, () => { throw new Error('boom') }, dbPath)).rejects.toThrow('boom')
    // A leaked handle would make this second open fail or hang.
    const env = await withIndex(fixture, () => 'ok', dbPath)
    expect(env.result).toBe('ok')
  })
})

describe('toolText', () => {
  it('serializes an envelope into MCP text content', async () => {
    const env = await withIndex(fixture, () => ({ n: 1 }), dbPath)
    const payload = toolText(env)
    expect(payload.content[0].type).toBe('text')
    const parsed = JSON.parse(payload.content[0].text)
    expect(parsed.result).toEqual({ n: 1 })
    expect(parsed.index.state).toBe('current')
  })
})

describe('store queries for tools', () => {
  it('breaks edges down by confidence without merging unresolved into ambiguous', () => {
    const store = GraphStore.open(dbPath)
    const breakdown = store.confidenceBreakdown()
    expect(breakdown.unresolved).toBeGreaterThan(0)
    expect(breakdown).not.toHaveProperty('ambiguous_or_unresolved')
    expect(Object.keys(breakdown).sort()).toEqual(
      ['ambiguous', 'exact', 'heuristic', 'resolved', 'unresolved'],
    )
    store.close()
  })

  it('counts files and symbols per language, including the null-language bucket', () => {
    const store = GraphStore.open(dbPath)
    const langs = store.languageBreakdown()
    expect(langs.some(l => l.lang === 'typescript')).toBe(true)
    expect(langs.some(l => l.lang === null)).toBe(true)   // README.md
    store.close()
  })

  it('reports repository totals', () => {
    const store = GraphStore.open(dbPath)
    const t = store.totals()
    expect(t.files).toBeGreaterThan(0)
    expect(t.symbols).toBeGreaterThan(0)
    expect(t.edges).toBeGreaterThan(0)
    store.close()
  })

  it('finds symbols by exact and partial name, with the owning path', () => {
    const store = GraphStore.open(dbPath)
    const exact = store.findSymbols({ name: 'helper', limit: 10 })
    expect(exact[0]).toMatchObject({ name: 'helper', path: 'src/helper.ts' })
    const partial = store.findSymbols({ contains: 'help', limit: 10 })
    expect(partial.map(s => s.name)).toContain('helper')
    store.close()
  })

  it('filters found symbols by kind and exported flag', () => {
    const store = GraphStore.open(dbPath)
    expect(store.findSymbols({ contains: 'Order', kind: 'class', limit: 10 })
      .every(s => s.kind === 'class')).toBe(true)
    expect(store.findSymbols({ contains: 'helper', exported: true, limit: 10 })
      .every(s => s.exported)).toBe(true)
    store.close()
  })

  it('returns the edges arriving at a symbol', () => {
    const store = GraphStore.open(dbPath)
    const helperSymbol = store.findSymbols({ name: 'helper', limit: 1 })[0]
    const inbound = store.edgesToSymbol(helperSymbol.id)
    expect(inbound.length).toBeGreaterThan(0)
    expect(inbound.every(e => e.dstSymbolId === helperSymbol.id)).toBe(true)
    store.close()
  })
})
