import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { getSymbol } from '../src/tools/symbol.js'
import { describeModule } from '../src/tools/module.js'
import { buildFixture } from './fixture-builder.js'
import type { ParsedFile, SourceSymbol } from '../src/types.js'

function symbolFile(path: string, symbols: SourceSymbol[]): ParsedFile {
  return { path, lang: 'typescript', contentHash: 'h-' + path, loc: 1, symbols, imports: [], callSites: [], errors: [] }
}

function exportedFn(name: string): SourceSymbol {
  return { name, kind: 'function', startLine: 1, endLine: 1, exported: true, signature: null, parentName: null }
}

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

  it('returns every match when a name is genuinely duplicated, rather than guessing', () => {
    // The shared fixture's `notify` has exactly one definition, so a test
    // built on it can never distinguish "returns every match" from "returns
    // one match and calls it a day" -- `totalMatches === matches.length` is
    // an identity that holds either way. Build a local store with a name
    // defined twice so the assertion can actually fail a regression.
    const s = GraphStore.open(':memory:')
    s.insertParsedFiles([
      symbolFile('a.ts', [exportedFn('dupSymbol')]),
      symbolFile('b.ts', [exportedFn('dupSymbol')]),
    ])
    const r = getSymbol(s, { name: 'dupSymbol', limit: 10 })
    expect(r.matches.length).toBeGreaterThan(1)
    expect(r.totalMatches).toBe(r.matches.length)
    expect(r.matches.map(m => m.path).sort()).toEqual(['a.ts', 'b.ts'])
    s.close()
  })

  it('truncates loudly with the true total when matches exceed the limit', () => {
    const s = GraphStore.open(':memory:')
    const files = Array.from({ length: 5 }, (_, i) => symbolFile(`dup${i}.ts`, [exportedFn('dup')]))
    s.insertParsedFiles(files)
    const r = getSymbol(s, { name: 'dup', limit: 2 })
    expect(r.matches).toHaveLength(2)
    expect(r.totalMatches).toBe(5)
    expect(r.truncated).toEqual({ returned: 2, total: 5 })
    s.close()
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
    // A genuinely absent path has no sub-modules either -- if a regression
    // made this branch always report the sub-module note, `subModules`
    // would still come back empty here, since nothing in the fixture is
    // nested under "src/nowhere". Asserting it stays empty is what makes
    // this test able to fail such a regression instead of just re-checking
    // the "no indexed files" wording in isolation.
    expect(r.subModules).toEqual([])
    expect(r.note).toMatch(/no indexed files/i)
  })

  it('reports files-live-below instead of "may not exist" when a directory has no direct files but real sub-modules', () => {
    // "src/parser/queries" style case: a directory that owns no files of
    // its own but has real children with files. The zero-direct-files
    // early return must not reuse the "may not exist" wording here -- that
    // would simultaneously name a real child directory and claim the
    // parent might not exist, which is a self-contradiction.
    const s = GraphStore.open(':memory:')
    s.insertParsedFiles([
      symbolFile('parent/child/a.ts', [exportedFn('a')]),
      symbolFile('parent/child/b.ts', [exportedFn('b')]),
    ])
    const r = describeModule(s, { path: 'parent', limit: 50 })
    expect(r.files).toEqual([])
    expect(r.subModules).toEqual(['parent/child'])
    expect(r.note).toBeDefined()
    expect(r.note).not.toMatch(/may not exist/i)
    expect(r.note).toMatch(/parent\/child/)
    // The note must carry the true count of files living below, not just
    // name the sub-module and leave the reader to guess how much is there.
    expect(r.note).toMatch(/2/)
    s.close()
  })

  it('names its sub-modules and warns that they are excluded, when a directory has them', () => {
    // "src" directly owns helper.ts and index.ts, but src/services is a
    // separate module in this same bucketing scheme -- describeModule('src')
    // must not silently look like a complete answer for the whole subtree,
    // the way get_repo_overview's coarser top-level grouping would suggest.
    const r = describeModule(store, { path: 'src', limit: 50 })
    expect(r.files).toEqual(['src/helper.ts', 'src/index.ts'])
    expect(r.subModules).toContain('src/services')
    expect(r.note).toBeDefined()
    expect(r.note).toMatch(/src\/services/)
  })

  it('reports no note and no sub-modules for a leaf module with no subdirectories', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    expect(r.subModules).toEqual([])
    expect(r.note).toBeUndefined()
  })

  it('truncates loudly with the true totals for both files and public surface when capped', () => {
    const s = GraphStore.open(':memory:')
    const files = Array.from({ length: 5 }, (_, i) => symbolFile(`mod/f${i}.ts`, [exportedFn(`sym${i}`)]))
    s.insertParsedFiles(files)
    const r = describeModule(s, { path: 'mod', limit: 2 })
    expect(r.files).toHaveLength(2)
    expect(r.truncatedFiles).toEqual({ returned: 2, total: 5 })
    expect(r.publicSurface).toHaveLength(2)
    expect(r.truncatedSurface).toEqual({ returned: 2, total: 5 })
    s.close()
  })
})
