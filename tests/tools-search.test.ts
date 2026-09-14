import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { searchCode } from '../src/tools/search.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore
let fixture: string

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-search-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('searchCode', () => {
  it('ranks an exact symbol match first', () => {
    const { hits } = searchCode(store, fixture, { query: 'helper', limit: 20 })
    expect(hits[0]).toMatchObject({ kind: 'symbol', symbolName: 'helper', path: 'src/helper.ts' })
  })

  it('returns file:line pointers rather than whole files', () => {
    const { hits } = searchCode(store, fixture, { query: 'helper', limit: 20 })
    for (const hit of hits) {
      expect(typeof hit.line).toBe('number')
      expect(hit.line).toBeGreaterThan(0)
      expect(hit.snippet.length).toBeLessThanOrEqual(200)
    }
  })

  it('finds text occurrences that are not symbol declarations', () => {
    const { hits } = searchCode(store, fixture, { query: 'placed', limit: 20 })
    expect(hits.some(h => h.kind === 'text' && h.path === 'src/services/order.ts')).toBe(true)
  })

  it('finds a partial symbol name', () => {
    const { hits } = searchCode(store, fixture, { query: 'Order', limit: 20 })
    expect(hits.some(h => h.symbolName === 'OrderService')).toBe(true)
  })

  it('filters by path prefix', () => {
    const { hits } = searchCode(store, fixture, { query: 'e', path: 'src/services', limit: 50 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(h => h.path.startsWith('src/services'))).toBe(true)
  })

  it('filters by symbol kind', () => {
    const { hits } = searchCode(store, fixture, { query: 'Order', kind: 'class', limit: 20 })
    expect(hits.every(h => h.kind === 'symbol' && h.symbolKind === 'class')).toBe(true)
  })

  it('truncates loudly with the true total', () => {
    const { hits, truncated } = searchCode(store, fixture, { query: 'e', limit: 2 })
    expect(hits).toHaveLength(2)
    expect(truncated!.returned).toBe(2)
    expect(truncated!.total).toBeGreaterThan(2)
  })

  it('never returns the same path and line twice', () => {
    const { hits } = searchCode(store, fixture, { query: 'helper', limit: 50 })
    const keys = hits.map(h => `${h.path}:${h.line}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('returns nothing for a query that matches nothing, without throwing', () => {
    const { hits } = searchCode(store, fixture, { query: 'zzzznotpresent', limit: 20 })
    expect(hits).toEqual([])
  })

  it('does not read files that were skipped at index time', () => {
    // node_modules and the minified bundle were skipped, so their contents
    // must be unreachable through search.
    const { hits } = searchCode(store, fixture, { query: 'module.exports', limit: 50 })
    expect(hits.every(h => !h.path.startsWith('node_modules/'))).toBe(true)
  })

  it('treats `_` and `%` in the query as literal characters, not SQL LIKE wildcards', () => {
    // `helper` contains no literal underscore or percent sign. Unescaped,
    // GraphStore.findSymbols's `contains` LIKE pattern would let `_` match
    // the 'p' in "helper" (single-char wildcard) and `%` match any run of
    // characters, producing a false hit. The full-text half can't produce
    // a false positive here either, since it uses plain string `includes`
    // on these literal needles, which no fixture file contains.
    expect(searchCode(store, fixture, { query: 'hel_er', limit: 20 }).hits).toEqual([])
    expect(searchCode(store, fixture, { query: 'h%r', limit: 20 }).hits).toEqual([])
  })
})

describe('searchCode truncation honesty', () => {
  // 13 distinct files, each exporting a function literally named `dup`, so
  // a query for `dup` has 13 real symbol matches. With `limit: 2` (and
  // SCAN_MULTIPLIER === 5 in src/tools/search.ts), symbolLimit is 10 — a
  // real count SQLite's own `LIMIT` would silently cut at 10 before the
  // rows ever reach searchCode's in-memory hits array. `truncated.total`
  // must still say 13, not 10: reporting the count that survived the SQL
  // LIMIT would be a wrong number smuggled out as an honest one.
  const DUP_COUNT = 13
  let dupStore: GraphStore
  let dupFixture: string

  beforeAll(async () => {
    dupFixture = buildFixture({ git: true })
    mkdirSync(join(dupFixture, 'src/dup'), { recursive: true })
    for (let i = 0; i < DUP_COUNT; i++) {
      writeFileSync(join(dupFixture, `src/dup/f${i}.ts`), 'export function dup(): void {}\n')
    }
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-search-dup-')), 'index.db')
    await runColdIndex({ repoRoot: dupFixture, dbPath })
    dupStore = GraphStore.open(dbPath)
  })

  it('reports the true total even when SQL LIMIT drops matches before they are counted', () => {
    // kind: 'function' isolates this to the symbol half (no full-text
    // contribution), so the total under test is exactly the one at risk.
    const { hits, truncated } = searchCode(dupStore, dupFixture, { query: 'dup', kind: 'function', limit: 2 })
    expect(hits).toHaveLength(2)
    expect(truncated!.returned).toBe(2)
    expect(truncated!.total).toBe(DUP_COUNT)
  })
})

describe('searchCode lang filtering', () => {
  let langStore: GraphStore
  let langFixture: string

  beforeAll(async () => {
    langFixture = buildFixture({ git: true })
    writeFileSync(join(langFixture, 'src/probe.ts'), 'export function langProbe(): void {}\n')
    writeFileSync(join(langFixture, 'src/probe.js'), 'export function langProbe() {}\n')
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-search-lang-')), 'index.db')
    await runColdIndex({ repoRoot: langFixture, dbPath })
    langStore = GraphStore.open(dbPath)
  })

  it('restricts symbol hits to the requested language', () => {
    // kind: 'function' isolates this to the symbol half (findSymbols),
    // which previously had no `lang` parameter at all -- `lang` was only
    // ever applied in the full-text loop, so a symbol-only query ignored
    // it completely.
    const both = searchCode(langStore, langFixture, { query: 'langProbe', kind: 'function', limit: 20 })
    expect(both.hits.some(h => h.path.endsWith('.ts'))).toBe(true)
    expect(both.hits.some(h => h.path.endsWith('.js'))).toBe(true)

    const tsOnly = searchCode(langStore, langFixture, {
      query: 'langProbe', kind: 'function', lang: 'typescript', limit: 20,
    })
    expect(tsOnly.hits.length).toBeGreaterThan(0)
    expect(tsOnly.hits.every(h => h.path.endsWith('.ts'))).toBe(true)
  })
})
