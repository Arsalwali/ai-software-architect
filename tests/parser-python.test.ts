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
    // `.helper.helper` (not `.helper`): a from-import specifier names the
    // imported ITEM inside the module, the same shape Java and Rust
    // specifiers already have. See the `from-import specifiers` describe
    // below, and final-fixes.md item 4.
    expect(specs).toEqual(['.helper.helper', 'os'])
  })

  it('extracts call sites and attributes them to the enclosing symbol', () => {
    const calls = parser.parse('a.py', SOURCE).callSites
    expect(calls.find(c => c.name === 'helper')!.enclosingSymbol).toBe('place')
    expect(calls.find(c => c.name === 'Service')!.enclosingSymbol).toBe('standalone')
  })

  it('counts lines', () => {
    expect(parser.parse('a.py', SOURCE).loc).toBe(9)
  })

  // final-fixes.md item 4. `from pkg import service` names the MODULE
  // `pkg.service` -- Python binds the submodule for this form whenever one
  // exists -- but the import query captured only the `module_name` field,
  // so the specifier was the bare `pkg` and resolution landed on
  // `pkg/__init__.py`. The imported name has to reach the resolver, and the
  // only channel to it is the specifier itself, so the query now captures
  // the `name:` field as an @member and the parser joins the two. That
  // makes Python's stored specifier name an ITEM path -- exactly what
  // Java's `com.example.Helper` and Rust's `crate::helper::help` already
  // are -- and pythonResolver drops the trailing item when the full path
  // names no module, the same way those two resolvers already do.
  //
  // All node/field names below (`module_name`, `name`, `relative_import`,
  // `aliased_import`, `wildcard_import`, and the `!name` negated-field
  // predicate) were verified against tree-sitter-python.wasm by probe.
  describe('from-import specifiers carry the imported name', () => {
    const specs = (source: string): string[] =>
      parser.parse('a.py', source).imports.map(i => i.specifier).sort()

    it('joins the module and the imported name into one dotted specifier', () => {
      expect(specs('from pkg import service\n')).toEqual(['pkg.service'])
    })

    it('emits one specifier per name in a multi-name from-import', () => {
      expect(specs('from pkg import a, b\n')).toEqual(['pkg.a', 'pkg.b'])
    })

    it('uses the pre-alias name, not the alias, for an aliased from-import', () => {
      // `from pkg import service as svc` still names the module
      // `pkg.service`; the alias is a local binding and names no file.
      expect(specs('from pkg import service as svc\n')).toEqual(['pkg.service'])
    })

    it('leaves a wildcard from-import as the bare module name', () => {
      // `from pkg import *` has no `name:` field at all, so there is no
      // imported name to append -- the module itself is the whole target.
      expect(specs('from pkg import *\n')).toEqual(['pkg'])
    })

    it('does not double the separator for a bare relative from-import', () => {
      // `from . import thing` must be `.thing`, NOT `..thing` -- two dots
      // would climb to the PARENT package and resolve to a different file
      // entirely.
      expect(specs('from . import thing\n')).toEqual(['.thing'])
      expect(specs('from .. import other\n')).toEqual(['..other'])
    })

    it('leaves a plain `import x.y` statement untouched', () => {
      expect(specs('import os\nimport pkg.deep\n')).toEqual(['os', 'pkg.deep'])
    })
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

      const resolved = store.importsForFile(serviceId).find(i => i.rawSpecifier === '.helper.helper')!
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

  // final-fixes.md item 4, end to end. `runner.py` uses `from pkg import
  // helper`, the form the fixture previously never contained. `pkg/__init__.py`
  // is EMPTY, so resolving to it (the old behaviour) leaves `helper.helper(n)`
  // unresolved -- a wrong target here cannot masquerade as a right one.
  it('resolves `from pkg import submodule` to the submodule file, not the package __init__', async () => {
    const fixture = buildPythonFixture({ git: true })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-py-sub-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    const store = GraphStore.open(dbPath)
    try {
      const runnerId = store.fileIdByPath('runner.py')!
      const helperId = store.fileIdByPath('pkg/helper.py')!
      const initId = store.fileIdByPath('pkg/__init__.py')!

      const imp = store.importsForFile(runnerId).find(i => i.rawSpecifier === 'pkg.helper')!
      expect(imp.confidence).toBe('resolved')
      expect(imp.resolvedFileId).toBe(helperId)
      expect(imp.resolvedFileId).not.toBe(initId)

      const call = store.edgesInto(helperId).find(e => e.dstName === 'helper' && e.srcFileId === runnerId)!
      expect(call, 'runner.py -> pkg/helper.py call edge missing').toBeDefined()
      expect(call.confidence).toBe('heuristic')
    } finally {
      store.close()
    }
  })
})
