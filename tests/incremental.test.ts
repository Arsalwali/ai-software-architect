import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { runIncrementalIndex } from '../src/indexer/incremental.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'
import { canonicalGraph } from './graph-snapshot.js'

let fixture: string
let dbPath: string

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'arch-inc-')), 'index.db')
}

beforeEach(async () => {
  fixture = buildFixture()
  dbPath = freshDb()
  await runColdIndex({ repoRoot: fixture, dbPath })
})

/** Full reindex of the CURRENT fixture state, into its own database. */
async function coldSnapshot(): Promise<string> {
  const other = freshDb()
  await runColdIndex({ repoRoot: fixture, dbPath: other })
  const store = GraphStore.open(other)
  try { return canonicalGraph(store) } finally { store.close() }
}

async function incrementalSnapshot(): Promise<string> {
  await runIncrementalIndex({ repoRoot: fixture, dbPath })
  const store = GraphStore.open(dbPath)
  try { return canonicalGraph(store) } finally { store.close() }
}

describe('the equality invariant', () => {
  it('matches a full reindex after a file body changes', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'),
      'export function helper(n: number): number {\n  return n + 99;\n}\nexport function unused(): void {}\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex after an exported symbol is RENAMED', async () => {
    // The sharpest case: order.ts calls helper(), so renaming it must turn a
    // heuristic edge into an unresolved one in BOTH build paths.
    writeFileSync(join(fixture, 'src/helper.ts'),
      'export function helperRenamed(n: number): number {\n  return n + 1;\n}\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex after a file is deleted', async () => {
    rmSync(join(fixture, 'src/services/notify.ts'))
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex after a file is added and imported', async () => {
    writeFileSync(join(fixture, 'src/extra.ts'), 'export function extra(): number {\n  return 7;\n}\n')
    writeFileSync(join(fixture, 'src/index.ts'),
      'import { OrderService } from "./services/order";\nimport { extra } from "./extra";\n\n' +
      'const service = new OrderService();\nservice.place(extra());\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex when a new export resolves a previously unresolved call', async () => {
    // notify.ts calls console.log; give order.ts a local `log` export and make
    // notify import it. Previously unresolved, now resolvable.
    writeFileSync(join(fixture, 'src/services/notify.ts'),
      'import { log } from "./logger";\nexport function notify(message: string): void {\n  log(message);\n}\n')
    writeFileSync(join(fixture, 'src/services/logger.ts'),
      'export function log(message: string): void {\n  void message;\n}\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex when a change creates an ambiguous collision', async () => {
    mkdirSync(join(fixture, 'src/dup'), { recursive: true })
    writeFileSync(join(fixture, 'src/dup/one.ts'), 'export function shared(): number { return 1; }\n')
    writeFileSync(join(fixture, 'src/dup/two.ts'), 'export function shared(): number { return 2; }\n')
    writeFileSync(join(fixture, 'src/dup/user.ts'),
      'import { shared } from "./one";\nimport { shared as other } from "./two";\n' +
      'export function use(): number { return shared(); }\n')
    const inc = await incrementalSnapshot()
    expect(inc).toBe(await coldSnapshot())
    expect(inc).toContain('|ambiguous|')
  })

  it('matches a full reindex across several successive edits', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
    await runIncrementalIndex({ repoRoot: fixture, dbPath })
    rmSync(join(fixture, 'src/services/notify.ts'))
    await runIncrementalIndex({ repoRoot: fixture, dbPath })
    writeFileSync(join(fixture, 'src/late.ts'), 'export function late(): void {}\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex when nothing changed at all', async () => {
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })
})

describe('runIncrementalIndex reporting', () => {
  it('reports how little it did on a no-op run', async () => {
    const report = await runIncrementalIndex({ repoRoot: fixture, dbPath })
    expect(report.changedFiles).toBe(0)
    expect(report.deletedFiles).toBe(0)
    expect(report.reparsedFiles).toBe(0)
    expect(report.fellBackToCold).toBe(false)
  })

  it('reparses the dilation, not the whole repo', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
    const report = await runIncrementalIndex({ repoRoot: fixture, dbPath })
    expect(report.changedFiles).toBe(1)
    // helper.ts plus order.ts, which imports it. Not the whole fixture.
    expect(report.reparsedFiles).toBe(2)
    expect(report.filesIndexed).toBeGreaterThan(report.reparsedFiles)
  })

  it('falls back to a cold index when the existing index is incomplete', async () => {
    const store = GraphStore.open(dbPath)
    store.setMeta('index_complete', '')
    store.close()
    const report = await runIncrementalIndex({ repoRoot: fixture, dbPath })
    expect(report.fellBackToCold).toBe(true)
    const after = GraphStore.open(dbPath)
    expect(after.getMeta('index_complete')).toBe('1')
    after.close()
  })

  it('falls back to a cold index when no index exists yet', async () => {
    const report = await runIncrementalIndex({ repoRoot: fixture, dbPath: freshDb() })
    expect(report.fellBackToCold).toBe(true)
  })

  it('clears the completion flags while running and restores them on success', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
    await runIncrementalIndex({ repoRoot: fixture, dbPath })
    const store = GraphStore.open(dbPath)
    expect(store.getMeta('index_complete')).toBe('1')
    store.close()
  })

  it('leaves the index marked incomplete when a run throws midway', async () => {
    const { GraphStore: GS } = await import('../src/store/graph-store.js')
    const spy = vi.spyOn(GS.prototype, 'insertEdges').mockImplementation(() => {
      throw new Error('injected failure at the edge-persist boundary')
    })
    try {
      writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
      await expect(runIncrementalIndex({ repoRoot: fixture, dbPath })).rejects.toThrow('injected failure')
    } finally {
      spy.mockRestore()
    }
    const store = GraphStore.open(dbPath)
    expect(store.getMeta('index_complete')).toBe('')
    store.close()
  })
})
