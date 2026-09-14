import { describe, it, expect, beforeAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { IndexReport } from '../src/indexer/pipeline.js'
import { buildFixture } from './fixture-builder.js'
import { gitHeadCommit } from '../src/repo/repo-source.js'

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
    expect(report.filesIndexed).toBe(7)
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

  it('tags an unresolved external call and a heuristic local match with distinct tiers', () => {
    // Pins the exact bug this branch fixes: a zero-candidate call (console.log,
    // an external/builtin with no local symbol match at all) must carry
    // 'unresolved', never 'ambiguous' -- 'ambiguous' means several candidates
    // matched, which is a completely different, genuinely uncertain outcome.
    // Nothing asserted this distinction before, which is how it survived ten
    // reviews: `notify()`'s console.log call and `OrderService.place`'s call
    // to `helper` differ only in which tier they land on.
    const all = store.allEdges()
    const logCall = all.find(e => e.dstName === 'log' && e.dstSymbolId === null)!
    expect(logCall).toBeDefined()
    expect(logCall.confidence).toBe('unresolved')

    const helperId = store.fileIdByPath('src/helper.ts')!
    const helperCall = store.edgesInto(helperId).find(e => e.dstName === 'helper')!
    expect(helperCall).toBeDefined()
    expect(helperCall.confidence).toBe('heuristic')
  })

  it('writes head_commit only after a successful run, and clears it when a later run fails partway', async () => {
    // Half one: a successful run wrote the real head commit, not just any value.
    expect(store.getMeta('indexed_at')).toBeDefined()
    expect(store.getMeta('files_indexed')).toBe('7')
    const expectedHead = gitHeadCommit(fixture)
    expect(expectedHead).toBeTruthy()
    expect(store.getMeta('head_commit')).toBe(expectedHead)

    // Half two: a run that fails partway must leave head_commit cleared, not
    // stale from a prior success. Use a separate fixture/db so this doesn't
    // disturb state the other tests in this file depend on.
    const failFixture = buildFixture({ git: true })
    const failDb = join(mkdtempSync(join(tmpdir(), 'arch-')), 'index.db')

    await runColdIndex({ repoRoot: failFixture, dbPath: failDb })
    const succeeded = GraphStore.open(failDb)
    expect(succeeded.getMeta('head_commit')).toBeTruthy()
    succeeded.close()

    // A nonexistent repoRoot makes isGitRepo() false and the filesystem walk
    // throw ENOENT from readdirSync during discovery -- deterministically
    // after the pipeline's initial clear, and well before the final
    // head_commit write.
    await expect(
      runColdIndex({ repoRoot: join(failFixture, 'missing-repo'), dbPath: failDb }),
    ).rejects.toThrow()

    const afterFailure = GraphStore.open(failDb)
    expect(afterFailure.getMeta('head_commit')).toBe('')
    afterFailure.close()
  })

  it('leaves head_commit cleared when the run fails during edge persistence (phase 5)', async () => {
    // A failure-injection deliberately placed AFTER call resolution and
    // BEFORE store.insertEdges. This pins down exactly the ordering the
    // brief requires: head_commit must not be written until phase 5 (and
    // phase 6) have completed. An early-discovery failure (as used above)
    // can't distinguish "write after phase 5" from "write moved earlier but
    // still before phase 5" -- both positions sit after that early throw.
    // This test throws exactly at the phase-5 boundary, so it does.
    const failFixture = buildFixture({ git: true })
    const failDb = join(mkdtempSync(join(tmpdir(), 'arch-')), 'index.db')

    const spy = vi.spyOn(GraphStore.prototype, 'insertEdges').mockImplementation(() => {
      throw new Error('simulated phase-5 failure')
    })
    try {
      await expect(
        runColdIndex({ repoRoot: failFixture, dbPath: failDb }),
      ).rejects.toThrow('simulated phase-5 failure')
    } finally {
      spy.mockRestore()
    }

    const afterStore = GraphStore.open(failDb)
    expect(afterStore.getMeta('head_commit')).toBe('')
    afterStore.close()
  })

  it('drops a file and its edges once it disappears from the repo on a re-run', async () => {
    // This exercises store.clear(): insertParsedFiles only deletes rows for
    // paths present in the CURRENT run, so a file removed between runs is
    // never revisited by that per-path delete. Only clear() purges it.
    const twoRunFixture = buildFixture({ git: true })
    const twoRunDb = join(mkdtempSync(join(tmpdir(), 'arch-')), 'index.db')

    await runColdIndex({ repoRoot: twoRunFixture, dbPath: twoRunDb })
    const firstStore = GraphStore.open(twoRunDb)
    const notifyId = firstStore.fileIdByPath('src/services/notify.ts')
    expect(notifyId).toBeDefined()
    firstStore.close()

    rmSync(join(twoRunFixture, 'src/services/notify.ts'))

    await runColdIndex({ repoRoot: twoRunFixture, dbPath: twoRunDb })
    const secondStore = GraphStore.open(twoRunDb)

    expect(secondStore.fileIdByPath('src/services/notify.ts')).toBeUndefined()

    // SQLite reuses rowids once a table is emptied, so the old notifyId
    // number may coincidentally equal some OTHER file's new id after
    // clear() -- comparing against it directly would be a false signal.
    // Instead check every edge's endpoints resolve to a file that still
    // exists post-rebuild; a dangling reference to the deleted file would
    // fail this regardless of which raw id it happens to carry.
    const liveFileIds = new Set(
      secondStore.allFilePaths().map(p => secondStore.fileIdByPath(p)!),
    )
    const allEdges = secondStore.allEdges()
    for (const edge of allEdges) {
      expect(liveFileIds.has(edge.srcFileId)).toBe(true)
      if (edge.dstFileId !== null) expect(liveFileIds.has(edge.dstFileId)).toBe(true)
    }

    // The rebuild is coherent, not just missing rows: order.ts's call to the
    // now-gone `notify` becomes unresolved rather than referencing a dangling id.
    const orderId = secondStore.fileIdByPath('src/services/order.ts')!
    const notifyCall = allEdges.find(e => e.srcFileId === orderId && e.dstName === 'notify')!
    expect(notifyCall).toBeDefined()
    expect(notifyCall.dstSymbolId).toBeNull()

    secondStore.close()
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
