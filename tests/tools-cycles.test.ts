import { describe, it, expect } from 'vitest'
import { findCycles } from '../src/tools/cycles.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function store(files: string[], imports: Array<[string, string]>): GraphStore {
  const s = GraphStore.open(':memory:')
  s.insertParsedFiles(files.map((path): ParsedFile => ({
    path, lang: 'typescript', contentHash: 'h-' + path, loc: 1,
    symbols: [], imports: [], callSites: [], errors: [],
  })))
  const ids = s.fileIdsByPath()
  s.insertImports(imports.map(([from, to], i) => ({
    fileId: ids.get(from)!, rawSpecifier: './x', resolvedFileId: ids.get(to)!,
    kind: 'static', confidence: 'resolved' as const, line: i + 1,
  })))
  return s
}

describe('findCycles at module scope', () => {
  it('reports nothing for an acyclic graph', () => {
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts']])
    expect(findCycles(s, { scope: 'module', minSize: 2, limit: 10 }).cycles).toEqual([])
    s.close()
  })

  it('finds a two-module cycle and names its members', () => {
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts'], ['b/y.ts', 'a/x.ts']])
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 10 })
    expect(r.cycles).toHaveLength(1)
    expect(r.cycles[0].members).toEqual(['a', 'b'])
    expect(r.cycles[0].size).toBe(2)
    s.close()
  })

  it('ranks a larger cycle ahead of a smaller one', () => {
    const s = store(
      ['a/x.ts', 'b/y.ts', 'c/z.ts', 'd/p.ts', 'e/q.ts'],
      [['a/x.ts', 'b/y.ts'], ['b/y.ts', 'c/z.ts'], ['c/z.ts', 'a/x.ts'],
       ['d/p.ts', 'e/q.ts'], ['e/q.ts', 'd/p.ts']],
    )
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 10 })
    expect(r.cycles[0].size).toBe(3)
    expect(r.cycles[1].size).toBe(2)
    s.close()
  })

  it('honours minSize', () => {
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts'], ['b/y.ts', 'a/x.ts']])
    expect(findCycles(s, { scope: 'module', minSize: 3, limit: 10 }).cycles).toEqual([])
    s.close()
  })

  it('reports the true total when the list is capped', () => {
    const files: string[] = []
    const imports: Array<[string, string]> = []
    for (let i = 0; i < 4; i++) {
      files.push(`p${i}/a.ts`, `q${i}/b.ts`)
      imports.push([`p${i}/a.ts`, `q${i}/b.ts`], [`q${i}/b.ts`, `p${i}/a.ts`])
    }
    const s = store(files, imports)
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 2 })
    expect(r.cycles).toHaveLength(2)
    expect(r.totalCycles).toBe(4)
    expect(r.truncated).toEqual({ returned: 2, total: 4 })
    s.close()
  })

  it('does not report an acyclic node as a one-member cycle', () => {
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts']])
    expect(findCycles(s, { scope: 'module', minSize: 1, limit: 10 }).cycles).toEqual([])
    s.close()
  })
})

describe('findCycles at file scope', () => {
  it('finds a cycle between two files inside one module', () => {
    const s = store(['m/a.ts', 'm/b.ts'], [['m/a.ts', 'm/b.ts'], ['m/b.ts', 'm/a.ts']])
    const r = findCycles(s, { scope: 'file', minSize: 2, limit: 10 })
    expect(r.cycles[0].members).toEqual(['m/a.ts', 'm/b.ts'])
    s.close()
  })

  it('does not surface that same cycle at module scope, since it is intra-module', () => {
    const s = store(['m/a.ts', 'm/b.ts'], [['m/a.ts', 'm/b.ts'], ['m/b.ts', 'm/a.ts']])
    expect(findCycles(s, { scope: 'module', minSize: 2, limit: 10 }).cycles).toEqual([])
    s.close()
  })
})
