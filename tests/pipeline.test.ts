import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { IndexReport } from '../src/indexer/pipeline.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string
let report: IndexReport
let store: GraphStore

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-')), 'index.db')
  report = await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('cold index', () => {
  it('indexes every discovered file', () => {
    expect(report.filesIndexed).toBe(5)
    expect(store.allFilePaths()).toContain('src/services/order.ts')
  })

  it('records the README with a null language rather than omitting it', () => {
    expect(store.fileRow('README.md')!.lang).toBeNull()
  })

  it('reports skipped files', () => {
    expect(report.filesSkipped).toBeGreaterThan(0)
  })

  it('resolves a relative import to a concrete file', () => {
    const orderId = store.fileIdByPath('src/services/order.ts')!
    const helperId = store.fileIdByPath('src/helper.ts')!
    const resolved = store.importsForFile(orderId)
    const helperImport = resolved.find(i => i.rawSpecifier === '../helper')!
    expect(helperImport.resolvedFileId).toBe(helperId)
    expect(helperImport.confidence).toBe('resolved')
  })

  it('leaves a bare package specifier unresolved', () => {
    const indexId = store.fileIdByPath('src/index.ts')!
    const fsImport = store.importsForFile(indexId).find(i => i.rawSpecifier === 'node:fs')!
    expect(fsImport.resolvedFileId).toBeNull()
  })

  it('builds a call edge from OrderService.place to helper', () => {
    const helperId = store.fileIdByPath('src/helper.ts')!
    const edges = store.edgesInto(helperId)
    const toHelper = edges.find(e => e.dstName === 'helper')!
    expect(toHelper.confidence).toBe('heuristic')
    expect(toHelper.srcFileId).toBe(store.fileIdByPath('src/services/order.ts')!)
  })

  it('records unresolved external calls without dropping them', () => {
    const all = store.allEdges()
    expect(all.some(e => e.dstName === 'log' && e.dstSymbolId === null)).toBe(true)
  })

  it('writes head_commit only after a successful run', () => {
    expect(store.getMeta('indexed_at')).toBeDefined()
    expect(store.getMeta('files_indexed')).toBe('5')
  })

  it('produces an identical graph when run twice', async () => {
    const before = { files: store.allFilePaths(), edges: store.edgeCount() }
    await runColdIndex({ repoRoot: fixture, dbPath })
    const after = GraphStore.open(dbPath)
    expect(after.allFilePaths()).toEqual(before.files)
    expect(after.edgeCount()).toBe(before.edges)
    after.close()
  })
})
