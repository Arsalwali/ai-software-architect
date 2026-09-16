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

describe('findCycles aggregationArtifact', () => {
  it('flags a module cycle manufactured by directory bucketing, with evidence for each hop', () => {
    // "root" bundles a leaf everything imports (types.ts) with an entry
    // point that imports into a subdirectory (entry.ts). That gives the
    // module graph edges root->sub and sub->root even though no file loops
    // back to itself: sub/a.ts -> root/types.ts is a dead end, and
    // root/entry.ts -> sub/a.ts -> root/types.ts never returns to entry.ts.
    const s = store(
      ['root/types.ts', 'root/entry.ts', 'sub/a.ts'],
      [['sub/a.ts', 'root/types.ts'], ['root/entry.ts', 'sub/a.ts']],
    )
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 10 })
    expect(r.cycles).toHaveLength(1)
    expect(r.cycles[0].members).toEqual(['root', 'sub'])
    expect(r.cycles[0].aggregationArtifact).toBe(true)

    const hops = r.cycles[0].hops!
    expect(hops.find(h => h.from === 'sub' && h.to === 'root')?.via)
      .toEqual([{ fromFile: 'sub/a.ts', toFile: 'root/types.ts' }])
    expect(hops.find(h => h.from === 'root' && h.to === 'sub')?.via)
      .toEqual([{ fromFile: 'root/entry.ts', toFile: 'sub/a.ts' }])

    // The evidence isn't just plausible-looking -- there really is no cycle
    // among the actual files, confirmed independently at file scope.
    expect(findCycles(s, { scope: 'file', minSize: 2, limit: 10 }).cycles).toEqual([])
    s.close()
  })

  it('does not let a self-importing file falsely flip aggregationArtifact to false', () => {
    // Same directory-bucketing artifact as above, plus a file that imports
    // itself (the real-world case is an index file with `import { x } from
    // '.'`, which `resolveImport` legitimately resolves back to the same
    // file). A self-edge is not a dependency between two distinct files, so
    // it must not count as file-level evidence of a real cycle -- if it
    // did, `aggregationArtifact` would flip to `false` (claiming a real
    // circular dependency) while the file-scope tool, built on the same
    // self-edge policy, still reports zero cycles.
    const s = store(
      ['root/types.ts', 'root/entry.ts', 'sub/a.ts'],
      [
        ['sub/a.ts', 'root/types.ts'],
        ['root/entry.ts', 'sub/a.ts'],
        ['root/entry.ts', 'root/entry.ts'],
      ],
    )
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 10 })
    expect(r.cycles).toHaveLength(1)
    expect(r.cycles[0].members).toEqual(['root', 'sub'])
    expect(r.cycles[0].aggregationArtifact).toBe(true)
    expect(findCycles(s, { scope: 'file', minSize: 2, limit: 10 }).cycles).toEqual([])
    s.close()
  })

  it('does not flag a genuine cross-module cycle as an artifact', () => {
    // Module A's file imports module B's file and vice versa: a real
    // file-to-file loop exists, not just a directory-bucketing coincidence.
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts'], ['b/y.ts', 'a/x.ts']])
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 10 })
    expect(r.cycles).toHaveLength(1)
    expect(r.cycles[0].aggregationArtifact).toBe(false)
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
