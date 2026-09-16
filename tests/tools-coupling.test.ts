import { describe, it, expect } from 'vitest'
import { getCoupling } from '../src/tools/coupling.js'
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

const FILES = ['app/a.ts', 'app/b.ts', 'core/c.ts', 'util/u.ts']
const IMPORTS: Array<[string, string]> = [
  ['app/a.ts', 'core/c.ts'], ['app/b.ts', 'core/c.ts'],
  ['app/a.ts', 'util/u.ts'], ['core/c.ts', 'util/u.ts'],
]

describe('getCoupling', () => {
  it('ranks modules by total coupling', () => {
    const s = store(FILES, IMPORTS)
    expect(getCoupling(s, { limit: 10 }).modules[0].module).toBe('app')
    s.close()
  })

  it('reports afferent, efferent and instability per module', () => {
    const s = store(FILES, IMPORTS)
    const byModule = new Map(getCoupling(s, { limit: 10 }).modules.map(m => [m.module, m]))
    expect(byModule.get('util')).toMatchObject({ afferent: 2, efferent: 0, instability: 0 })
    expect(byModule.get('app')).toMatchObject({ afferent: 0, efferent: 2, instability: 1 })
    s.close()
  })

  it('reports the heaviest module pairs with their weights', () => {
    const s = store(FILES, IMPORTS)
    expect(getCoupling(s, { limit: 10 }).heaviestPairs[0]).toMatchObject({ from: 'app', to: 'core', weight: 2 })
    s.close()
  })

  it('truncates both lists loudly with their true totals', () => {
    const s = store(FILES, IMPORTS)
    const r = getCoupling(s, { limit: 1 })
    expect(r.modules).toHaveLength(1)
    expect(r.totalModules).toBe(3)
    expect(r.truncatedModules).toEqual({ returned: 1, total: 3 })
    expect(r.truncatedPairs!.total).toBeGreaterThan(1)
    s.close()
  })

  it('returns empty results for an empty index without throwing', () => {
    const s = GraphStore.open(':memory:')
    const r = getCoupling(s, { limit: 10 })
    expect(r.modules).toEqual([])
    expect(r.heaviestPairs).toEqual([])
    expect(r.totalModules).toBe(0)
    s.close()
  })
})
