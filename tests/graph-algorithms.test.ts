import { describe, it, expect } from 'vitest'
import { stronglyConnectedComponents, couplingMetrics } from '../src/graph/algorithms.js'
import { moduleOf, buildModuleGraph } from '../src/graph/module-graph.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function graphOf(adjacency: Record<string, string[]>) {
  return {
    nodes: Object.keys(adjacency).sort(),
    successors: (n: string) => adjacency[n] ?? [],
  }
}

describe('stronglyConnectedComponents', () => {
  it('finds no multi-node component in an acyclic graph', () => {
    const { nodes, successors } = graphOf({ a: ['b'], b: ['c'], c: [] })
    const sccs = stronglyConnectedComponents(nodes, successors)
    expect(sccs.every(c => c.length === 1)).toBe(true)
    expect(sccs).toHaveLength(3)
  })

  it('finds a two-node cycle', () => {
    const { nodes, successors } = graphOf({ a: ['b'], b: ['a'] })
    const multi = stronglyConnectedComponents(nodes, successors).filter(c => c.length > 1)
    expect(multi).toEqual([['a', 'b']])
  })

  it('finds a three-node cycle and leaves an attached acyclic node alone', () => {
    const { nodes, successors } = graphOf({ a: ['b'], b: ['c'], c: ['a'], d: ['a'] })
    const sccs = stronglyConnectedComponents(nodes, successors)
    expect(sccs.filter(c => c.length > 1)).toEqual([['a', 'b', 'c']])
    expect(sccs.filter(c => c.length === 1)).toEqual([['d']])
  })

  it('finds two disjoint cycles', () => {
    const { nodes, successors } = graphOf({ a: ['b'], b: ['a'], c: ['d'], d: ['c'] })
    const multi = stronglyConnectedComponents(nodes, successors).filter(c => c.length > 1)
    expect(multi.map(c => c.join(',')).sort()).toEqual(['a,b', 'c,d'])
  })

  it('reports a self-loop as a single-node component', () => {
    const { nodes, successors } = graphOf({ a: ['a'] })
    expect(stronglyConnectedComponents(nodes, successors)).toEqual([['a']])
  })

  it('terminates on a long chain without overflowing the stack', () => {
    const adjacency: Record<string, string[]> = {}
    for (let i = 0; i < 20000; i++) adjacency[`n${i}`] = i < 19999 ? [`n${i + 1}`] : []
    const { nodes, successors } = graphOf(adjacency)
    expect(stronglyConnectedComponents(nodes, successors)).toHaveLength(20000)
  })

  it('handles an edge to a node not in the node list without throwing', () => {
    const { nodes, successors } = graphOf({ a: ['ghost'] })
    expect(() => stronglyConnectedComponents(nodes, successors)).not.toThrow()
  })
})

describe('couplingMetrics', () => {
  const graph = {
    modules: ['app', 'core', 'util'],
    filesByModule: new Map([['app', ['app/a.ts']], ['core', ['core/c.ts']], ['util', ['util/u.ts']]]),
    out: new Map([
      ['app', new Map([['core', 2], ['util', 1]])],
      ['core', new Map([['util', 1]])],
      ['util', new Map()],
    ]),
    in: new Map([
      ['app', new Map()],
      ['core', new Map([['app', 2]])],
      ['util', new Map([['app', 1], ['core', 1]])],
    ]),
  }

  it('counts distinct dependent and dependency modules, not edge weights', () => {
    const byModule = new Map(couplingMetrics(graph).map(m => [m.module, m]))
    expect(byModule.get('app')).toMatchObject({ afferent: 0, efferent: 2 })
    expect(byModule.get('util')).toMatchObject({ afferent: 2, efferent: 0 })
  })

  it('computes instability as Ce over Ca plus Ce', () => {
    const byModule = new Map(couplingMetrics(graph).map(m => [m.module, m]))
    expect(byModule.get('app')!.instability).toBe(1)
    expect(byModule.get('util')!.instability).toBe(0)
    expect(byModule.get('core')!.instability).toBeCloseTo(0.5, 5)
  })

  it('reports instability 0 for an uncoupled module rather than NaN', () => {
    const isolated = {
      modules: ['lone'],
      filesByModule: new Map([['lone', ['lone/x.ts']]]),
      out: new Map([['lone', new Map()]]),
      in: new Map([['lone', new Map()]]),
    }
    expect(couplingMetrics(isolated)[0].instability).toBe(0)
  })
})

describe('moduleOf', () => {
  it('uses the containing directory', () => {
    expect(moduleOf('src/services/order.ts')).toBe('src/services')
  })

  it('uses a dot for a file at the repository root', () => {
    expect(moduleOf('README.md')).toBe('.')
  })
})

describe('buildModuleGraph', () => {
  function seed(): GraphStore {
    const store = GraphStore.open(':memory:')
    const file = (path: string): ParsedFile => ({
      path, lang: 'typescript', contentHash: 'h-' + path, loc: 1,
      symbols: [], imports: [], callSites: [], errors: [],
    })
    store.insertParsedFiles([file('app/a.ts'), file('core/c.ts'), file('core/d.ts')])
    const ids = store.fileIdsByPath()
    store.insertImports([
      // Two rows, one target: the value-plus-type import pattern. Must count once.
      { fileId: ids.get('app/a.ts')!, rawSpecifier: '../core/c', resolvedFileId: ids.get('core/c.ts')!, kind: 'static', confidence: 'resolved', line: 1 },
      { fileId: ids.get('app/a.ts')!, rawSpecifier: '../core/c', resolvedFileId: ids.get('core/c.ts')!, kind: 'static', confidence: 'resolved', line: 2 },
      // A second distinct target in the same module: weight should become 2.
      { fileId: ids.get('app/a.ts')!, rawSpecifier: '../core/d', resolvedFileId: ids.get('core/d.ts')!, kind: 'static', confidence: 'resolved', line: 3 },
      // Unresolved: must not create an edge at all.
      { fileId: ids.get('app/a.ts')!, rawSpecifier: 'react', resolvedFileId: null, kind: 'static', confidence: 'unresolved', line: 4 },
      // Same-module import: must not create a self-edge.
      { fileId: ids.get('core/c.ts')!, rawSpecifier: './d', resolvedFileId: ids.get('core/d.ts')!, kind: 'static', confidence: 'resolved', line: 1 },
    ])
    return store
  }

  it('weights an edge by DISTINCT file pairs, not import rows', () => {
    const store = seed()
    expect(buildModuleGraph(store).out.get('app')!.get('core')).toBe(2)
    store.close()
  })

  it('contributes no outgoing module edges for a file whose only import is unresolved', () => {
    // Asserting `.has('react')` is false (the old version of this test)
    // is vacuous: `moduleOf` builds every key in `out` from a resolved
    // TARGET path, so a raw specifier like "react" could never appear as a
    // key regardless of whether the unresolved-import guard exists at all.
    // The guard actually controls something else: whether a file whose
    // only import is unresolved gets any outgoing edge at all. Assert that
    // directly, on a file with no other import to accidentally satisfy it.
    const store = GraphStore.open(':memory:')
    const file = (path: string): ParsedFile => ({
      path, lang: 'typescript', contentHash: 'h-' + path, loc: 1,
      symbols: [], imports: [], callSites: [], errors: [],
    })
    store.insertParsedFiles([file('solo/a.ts')])
    const ids = store.fileIdsByPath()
    store.insertImports([
      { fileId: ids.get('solo/a.ts')!, rawSpecifier: 'react', resolvedFileId: null, kind: 'static', confidence: 'unresolved', line: 1 },
    ])
    const graph = buildModuleGraph(store)
    expect(graph.out.get('solo')).toEqual(new Map())
    store.close()
  })

  it('creates no self-edge for an intra-module import', () => {
    const store = seed()
    expect(buildModuleGraph(store).out.get('core')!.has('core')).toBe(false)
    store.close()
  })

  it('records the inverse edge map', () => {
    const store = seed()
    expect(buildModuleGraph(store).in.get('core')!.get('app')).toBe(2)
    store.close()
  })

  it('lists every module with its files, including modules with no edges', () => {
    const store = seed()
    const graph = buildModuleGraph(store)
    expect(graph.modules).toEqual(['app', 'core'])
    expect(graph.filesByModule.get('core')!.sort()).toEqual(['core/c.ts', 'core/d.ts'])
    store.close()
  })
})
