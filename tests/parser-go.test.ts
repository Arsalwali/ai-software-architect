import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RepoParser } from '../src/parser/parser.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildGoFixture } from './fixtures-multilang.js'

const SERVICE_SOURCE =
  'package service\n\n' +
  'import "example.com/m/helper"\n\n' +
  'type Service struct{ N int }\n\n' +
  'func trim(s string) string { return s }\n\n' +
  'func (s *Service) Place() int {\n\treturn helper.Help(s.N)\n}\n'

const MAIN_SOURCE =
  'package main\n\n' +
  'import (\n\t"fmt"\n\t"example.com/m/service"\n)\n\n' +
  'func main() {\n\ts := service.Service{N: 2}\n\tfmt.Println(s.Place())\n}\n'

let parser: RepoParser
beforeAll(async () => { parser = await RepoParser.create() })

describe('go parsing', () => {
  it('recognises .go as go', () => {
    expect(parser.parse('a.go', SERVICE_SOURCE).lang).toBe('go')
  })

  it('extracts a struct type, a method and a function with their kinds', () => {
    const names = parser.parse('a.go', SERVICE_SOURCE).symbols.map(s => `${s.kind}:${s.name}`).sort()
    expect(names).toEqual(['function:trim', 'method:Place', 'type:Service'])
  })

  it('recognises a top-level function elsewhere in the package', () => {
    const symbols = parser.parse('main.go', MAIN_SOURCE).symbols
    expect(symbols).toEqual([
      expect.objectContaining({ name: 'main', kind: 'function', parentName: null }),
    ])
  })

  it('attributes a method to its receiver type', () => {
    const place = parser.parse('a.go', SERVICE_SOURCE).symbols.find(s => s.name === 'Place')!
    expect(place.kind).toBe('method')
    expect(place.parentName).toBe('Service')
  })

  it('exports by capitalisation alone: Service and Place are exported, trim is not', () => {
    const bySymbol = new Map(parser.parse('a.go', SERVICE_SOURCE).symbols.map(s => [s.name, s]))
    expect(bySymbol.get('Service')!.exported).toBe(true)
    expect(bySymbol.get('Place')!.exported).toBe(true)
    expect(bySymbol.get('trim')!.exported).toBe(false)
  })

  it('extracts the import specifier without its surrounding quotes', () => {
    const imports = parser.parse('a.go', SERVICE_SOURCE).imports
    expect(imports).toEqual([
      { specifier: 'example.com/m/helper', kind: 'static', line: 3 },
    ])
  })

  it('extracts multiple imports from an import block', () => {
    const specs = parser.parse('main.go', MAIN_SOURCE).imports.map(i => i.specifier).sort()
    expect(specs).toEqual(['example.com/m/service', 'fmt'])
  })

  it('attributes a call inside a method to that method', () => {
    const calls = parser.parse('a.go', SERVICE_SOURCE).callSites
    const call = calls.find(c => c.name === 'Help')!
    expect(call).toEqual({ name: 'Help', line: 10, enclosingSymbol: 'Place', kind: 'calls' })
  })

  it('attributes a call inside a top-level function to that function', () => {
    const calls = parser.parse('main.go', MAIN_SOURCE).callSites
    const place = calls.find(c => c.name === 'Place')!
    expect(place.enclosingSymbol).toBe('main')
    const println = calls.find(c => c.name === 'Println')!
    expect(println.enclosingSymbol).toBe('main')
  })

  it('counts lines', () => {
    expect(parser.parse('a.go', SERVICE_SOURCE).loc).toBe(11)
  })
})

describe('go produces a real graph', () => {
  it('resolves a cross-file import and a cross-file call edge', async () => {
    const fixture = buildGoFixture({ git: true })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-go-db-')), 'index.db')

    // repoRoot is threaded from here through resolveImport into goResolver
    // (see src/resolve/go.ts), which reads THIS fixture's go.mod from it —
    // no cwd trick needed, and this deliberately runs without touching
    // process.cwd() to prove the real, ordinary indexing path works.
    await runColdIndex({ repoRoot: fixture, dbPath })

    const store = GraphStore.open(dbPath)
    try {
      const serviceId = store.fileIdByPath('service/service.go')!
      const helperId = store.fileIdByPath('helper/helper.go')!

      const resolved = store.importsForFile(serviceId).find(i => i.rawSpecifier === 'example.com/m/helper')!
      expect(resolved.resolvedFileId).toBe(helperId)
      expect(resolved.confidence).toBe('resolved')

      const intoHelper = store.edgesInto(helperId)
      const call = intoHelper.find(e => e.dstName === 'Help')!
      expect(call).toBeDefined()
      expect(call.confidence).toBe('heuristic')
      expect(call.srcFileId).toBe(serviceId)
    } finally {
      store.close()
    }
  })

  // task-6-fixes-round2.md, Fix 3: goResolver deterministically resolves an
  // `imports` row to only the FIRST file in a package directory by sorted
  // path (aaa.go < zzz.go) -- verified below, UNCHANGED by this fix, since
  // one import row can only ever record one file. `multi.MultiFn` is
  // defined in `zzz.go`, the file that sorts SECOND, so this call could
  // only ever resolve if call resolution considers every file sharing the
  // resolved import's directory, not merely the one file the import row
  // itself points at.
  it('resolves a call to a symbol in a LATER-sorting file of a multi-file package', async () => {
    const fixture = buildGoFixture({ git: true })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-go-multi-db-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })

    const store = GraphStore.open(dbPath)
    try {
      const aaaId = store.fileIdByPath('multi/aaa.go')!
      const zzzId = store.fileIdByPath('multi/zzz.go')!
      const mainId = store.fileIdByPath('main.go')!

      // The import row itself: resolves to aaa.go, the sorted-first file --
      // this is goResolver's documented, unchanged behaviour, not a bug to
      // fix here. If this ever starts pointing at zzz.go instead, that is a
      // DIFFERENT change (to goResolver itself) and this assertion should
      // be revisited, not silently adjusted.
      const resolved = store.importsForFile(mainId).find(i => i.rawSpecifier === 'example.com/m/multi')!
      expect(resolved.resolvedFileId).toBe(aaaId)
      expect(resolved.confidence).toBe('resolved')

      // The call edge: must reach zzz.go's MultiFn, not stop at aaa.go
      // (which has no such symbol) and fall back to unresolved.
      const call = store.edgesInto(zzzId).find(e => e.dstName === 'MultiFn')!
      expect(call, 'multi.MultiFn call did not resolve into zzz.go').toBeDefined()
      expect(call.confidence).toBe('heuristic')
      expect(call.srcFileId).toBe(mainId)
    } finally {
      store.close()
    }
  })
})
