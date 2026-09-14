import { describe, it, expect } from 'vitest'
import { GraphStore, SCHEMA_VERSION } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function parsedFile(path: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path,
    lang: 'typescript',
    contentHash: 'hash-' + path,
    symbols: [],
    imports: [],
    callSites: [],
    errors: [],
    ...overrides,
  }
}

describe('GraphStore', () => {
  it('creates the schema and stamps a version', () => {
    const store = GraphStore.open(':memory:')
    expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
    store.close()
  })

  it('persists files and symbols, and links them', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([
      parsedFile('src/a.ts', {
        symbols: [{
          name: 'foo', kind: 'function', startLine: 1, endLine: 3,
          exported: true, signature: 'function foo()', parentName: null,
        }],
      }),
    ])

    const fileId = store.fileIdByPath('src/a.ts')
    expect(fileId).toBeDefined()

    const byName = store.symbolsByName()
    expect(byName.get('foo')).toHaveLength(1)
    expect(byName.get('foo')![0].fileId).toBe(fileId)
    expect(byName.get('foo')![0].exported).toBe(true)
    store.close()
  })

  it('records error counts and unknown languages', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([
      parsedFile('README.md', { lang: null }),
      parsedFile('src/b.ts', { errors: [{ line: 2, message: 'boom' }] }),
    ])
    expect(store.allFilePaths().sort()).toEqual(['README.md', 'src/b.ts'])
    expect(store.fileRow('src/b.ts')!.errorCount).toBe(1)
    expect(store.fileRow('README.md')!.lang).toBeNull()
    store.close()
  })

  it('groups exported symbols by file', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([
      parsedFile('src/a.ts', {
        symbols: [
          { name: 'pub', kind: 'function', startLine: 1, endLine: 1, exported: true, signature: null, parentName: null },
          { name: 'priv', kind: 'function', startLine: 2, endLine: 2, exported: false, signature: null, parentName: null },
        ],
      }),
    ])
    const fileId = store.fileIdByPath('src/a.ts')!
    expect(store.exportedSymbolsByFile().get(fileId)!.map(s => s.name)).toEqual(['pub'])
    store.close()
  })

  it('stores edges including unresolved ones', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([parsedFile('src/a.ts')])
    const fileId = store.fileIdByPath('src/a.ts')!
    store.insertEdges([
      { srcFileId: fileId, srcSymbolId: null, dstFileId: null, dstSymbolId: null,
        dstName: 'externalThing', kind: 'calls', confidence: 'ambiguous', line: 4 },
    ])
    expect(store.edgeCount()).toBe(1)
    store.close()
  })

  it('is idempotent on re-insert of the same path', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([
      parsedFile('src/a.ts', {
        symbols: [
          { name: 'keep', kind: 'function', startLine: 1, endLine: 1, exported: true, signature: null, parentName: null },
          { name: 'gone', kind: 'function', startLine: 2, endLine: 2, exported: false, signature: null, parentName: null },
        ],
      }),
    ])
    store.insertParsedFiles([
      parsedFile('src/a.ts', {
        symbols: [
          { name: 'keep', kind: 'function', startLine: 1, endLine: 1, exported: true, signature: null, parentName: null },
          { name: 'fresh', kind: 'function', startLine: 3, endLine: 3, exported: false, signature: null, parentName: null },
        ],
      }),
    ])
    expect(store.allFilePaths()).toEqual(['src/a.ts'])

    const fileId = store.fileIdByPath('src/a.ts')!
    expect(store.symbolsByFile().get(fileId)!.map(s => s.name).sort()).toEqual(['fresh', 'keep'])
    expect(store.symbolsByName().get('gone')).toBeUndefined()
    expect(store.symbolsByName().get('keep')).toHaveLength(1)
    expect(store.symbolsByName().get('fresh')).toHaveLength(1)
    store.close()
  })
})
