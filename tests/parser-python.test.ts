import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RepoParser } from '../src/parser/parser.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildPythonFixture } from './fixtures-multilang.js'

const SOURCE =
  'from .helper import helper\n' +
  'import os\n' +
  '\n' +
  'class Service:\n' +
  '    def place(self, n):\n' +
  '        return helper(n)\n' +
  '\n' +
  'def standalone(x):\n' +
  '    return Service().place(x)\n'

let parser: RepoParser
beforeAll(async () => { parser = await RepoParser.create() })

describe('python parsing', () => {
  it('recognises .py as python', () => {
    expect(parser.parse('a.py', SOURCE).lang).toBe('python')
  })

  it('extracts classes and functions', () => {
    const names = parser.parse('a.py', SOURCE).symbols.map(s => `${s.kind}:${s.name}`).sort()
    expect(names).toEqual(['class:Service', 'function:standalone', 'method:place'])
  })

  it('marks a function inside a class as a method and attributes it to the class', () => {
    const place = parser.parse('a.py', SOURCE).symbols.find(s => s.name === 'place')!
    expect(place.kind).toBe('method')
    expect(place.parentName).toBe('Service')
  })

  it('leaves a module-level function as a function with no parent', () => {
    const standalone = parser.parse('a.py', SOURCE).symbols.find(s => s.name === 'standalone')!
    expect(standalone.kind).toBe('function')
    expect(standalone.parentName).toBeNull()
  })

  it('extracts both relative and absolute imports', () => {
    const specs = parser.parse('a.py', SOURCE).imports.map(i => i.specifier).sort()
    expect(specs).toEqual(['.helper', 'os'])
  })

  it('extracts call sites and attributes them to the enclosing symbol', () => {
    const calls = parser.parse('a.py', SOURCE).callSites
    expect(calls.find(c => c.name === 'helper')!.enclosingSymbol).toBe('place')
    expect(calls.find(c => c.name === 'Service')!.enclosingSymbol).toBe('standalone')
  })

  it('counts lines', () => {
    expect(parser.parse('a.py', SOURCE).loc).toBe(9)
  })
})

describe('python produces a real graph', () => {
  it('resolves a cross-file import and a cross-file call edge', async () => {
    const fixture = buildPythonFixture({ git: true })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-py-db-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    const store = GraphStore.open(dbPath)
    try {
      const serviceId = store.fileIdByPath('pkg/service.py')!
      const helperId = store.fileIdByPath('pkg/helper.py')!

      const resolved = store.importsForFile(serviceId).find(i => i.rawSpecifier === '.helper')!
      expect(resolved.resolvedFileId).toBe(helperId)
      expect(resolved.confidence).toBe('resolved')

      const intoHelper = store.edgesInto(helperId)
      const call = intoHelper.find(e => e.dstName === 'helper')!
      expect(call.confidence).toBe('heuristic')
      expect(call.srcFileId).toBe(serviceId)
    } finally {
      store.close()
    }
  })
})
