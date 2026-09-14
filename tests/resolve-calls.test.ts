import { describe, it, expect } from 'vitest'
import { resolveCallsForFile } from '../src/indexer/resolve-calls.js'
import type { SymbolRow } from '../src/store/graph-store.js'
import type { CallSite } from '../src/types.js'

function symbol(id: number, fileId: number, name: string, exported = true): SymbolRow {
  return { id, fileId, name, kind: 'function', startLine: 1, endLine: 2, exported }
}

// file 1 = caller.ts, file 2 = helper.ts, file 3 = other.ts
const localSymbols = [symbol(10, 1, 'localFn', false)]
const exportedByFile = new Map<number, SymbolRow[]>([
  [2, [symbol(20, 2, 'helper')]],
  [3, [symbol(30, 3, 'helper')]],
])

function call(name: string, enclosing: string | null = null): CallSite {
  return { name, line: 5, enclosingSymbol: enclosing, kind: 'calls' }
}

describe('resolveCallsForFile', () => {
  it('marks a single candidate as heuristic', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ dstSymbolId: 20, dstFileId: 2, confidence: 'heuristic' })
  })

  it('fans out to every candidate and marks them ambiguous', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2, 3],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(2)
    expect(edges.every(e => e.confidence === 'ambiguous')).toBe(true)
    expect(edges.map(e => e.dstSymbolId).sort()).toEqual([20, 30])
  })

  it('prefers a local declaration over imports and treats it as unambiguous', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols: [symbol(10, 1, 'helper', false)],
      importedFileIds: [2, 3],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ dstSymbolId: 10, confidence: 'heuristic' })
  })

  it('records an unresolved edge when nothing matches', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [],
      exportedByFile,
      callSites: [call('console')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      dstSymbolId: null, dstFileId: null, dstName: 'console', confidence: 'ambiguous',
    })
  })

  it('attributes the edge to the enclosing symbol when there is one', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper', 'localFn')],
    })
    expect(edges[0].srcSymbolId).toBe(10)
  })

  it('leaves srcSymbolId null for a top-level call but always sets srcFileId', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper', null)],
    })
    expect(edges[0].srcSymbolId).toBeNull()
    expect(edges[0].srcFileId).toBe(1)
  })

  it('maps instantiation call sites to the instantiates edge kind', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [{ name: 'helper', line: 9, enclosingSymbol: null, kind: 'instantiates' }],
    })
    expect(edges[0].kind).toBe('instantiates')
  })
})
