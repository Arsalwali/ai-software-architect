import { describe, it, expect } from 'vitest'
import { GraphStore } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function parsedFile(path: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path, lang: 'typescript', contentHash: 'hash-' + path,
    symbols: [], imports: [], callSites: [], errors: [], ...overrides,
  }
}

function seeded(): GraphStore {
  const store = GraphStore.open(':memory:')
  store.insertParsedFiles([
    parsedFile('src/a.ts', {
      symbols: [{ name: 'callerFn', kind: 'function', startLine: 1, endLine: 4, exported: false, signature: null, parentName: null }],
    }),
    parsedFile('src/b.ts', {
      symbols: [{ name: 'target', kind: 'function', startLine: 1, endLine: 2, exported: true, signature: null, parentName: null }],
    }),
  ])
  const a = store.fileIdByPath('src/a.ts')!
  const b = store.fileIdByPath('src/b.ts')!
  store.insertImports([
    { fileId: a, rawSpecifier: './b', resolvedFileId: b, kind: 'static', confidence: 'resolved', line: 1 },
  ])
  const callerId = store.symbolsByName().get('callerFn')![0].id
  const targetId = store.symbolsByName().get('target')![0].id
  store.insertEdges([
    { srcFileId: a, srcSymbolId: callerId, dstFileId: b, dstSymbolId: targetId,
      dstName: 'target', kind: 'calls', confidence: 'heuristic', line: 3 },
    { srcFileId: a, srcSymbolId: null, dstFileId: null, dstSymbolId: null,
      dstName: 'console', kind: 'calls', confidence: 'unresolved', line: 4 },
  ])
  return store
}

describe('contentHashByPath', () => {
  it('maps every indexed path to its stored hash', () => {
    const store = seeded()
    const hashes = store.contentHashByPath()
    expect(hashes.get('src/a.ts')).toBe('hash-src/a.ts')
    expect(hashes.size).toBe(2)
    store.close()
  })
})

describe('filesImporting', () => {
  it('returns files whose resolved imports point at the target', () => {
    const store = seeded()
    const a = store.fileIdByPath('src/a.ts')!
    const b = store.fileIdByPath('src/b.ts')!
    expect(store.filesImporting(b)).toEqual([a])
    expect(store.filesImporting(a)).toEqual([])
    store.close()
  })

  it('ignores unresolved imports', () => {
    const store = seeded()
    const a = store.fileIdByPath('src/a.ts')!
    store.insertImports([
      { fileId: a, rawSpecifier: 'react', resolvedFileId: null, kind: 'static', confidence: 'unresolved', line: 2 },
    ])
    expect(store.filesImporting(store.fileIdByPath('src/b.ts')!)).toEqual([a])
    store.close()
  })
})

describe('deleteFilesByPath', () => {
  it('removes the file and cascades its symbols and edges', () => {
    const store = seeded()
    store.deleteFilesByPath(['src/a.ts'])
    expect(store.fileIdByPath('src/a.ts')).toBeUndefined()
    expect(store.symbolsByName().get('callerFn')).toBeUndefined()
    expect(store.allEdges()).toHaveLength(0)
    store.close()
  })

  it('leaves edges pointing AT a deleted file present but unlinked', () => {
    const store = seeded()
    store.deleteFilesByPath(['src/b.ts'])
    const edges = store.allEdges()
    const toTarget = edges.find(e => e.dstName === 'target')!
    expect(toTarget.dstFileId).toBeNull()
    expect(toTarget.dstSymbolId).toBeNull()
    store.close()
  })

  it('is a no-op for an unknown path', () => {
    const store = seeded()
    store.deleteFilesByPath(['src/nope.ts'])
    expect(store.allFilePaths()).toHaveLength(2)
    store.close()
  })
})

describe('allEdgeDetails', () => {
  it('expresses edges as paths and names rather than row ids', () => {
    const store = seeded()
    const details = store.allEdgeDetails()
    const resolved = details.find(d => d.dstName === 'target')!
    expect(resolved).toMatchObject({
      srcPath: 'src/a.ts', srcSymbolName: 'callerFn',
      dstPath: 'src/b.ts', dstSymbolName: 'target',
      kind: 'calls', confidence: 'heuristic', line: 3,
    })
    const external = details.find(d => d.dstName === 'console')!
    expect(external).toMatchObject({
      srcPath: 'src/a.ts', srcSymbolName: null,
      dstPath: null, dstSymbolName: null, confidence: 'unresolved',
    })
    store.close()
  })
})

describe('id and path maps', () => {
  it('round-trip each other', () => {
    const store = seeded()
    const ids = store.fileIdsByPath()
    const paths = store.pathsById()
    expect(paths.get(ids.get('src/a.ts')!)).toBe('src/a.ts')
    expect(ids.size).toBe(2)
    store.close()
  })
})
