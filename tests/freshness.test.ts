import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { checkFreshness, ensureFresh, AUTO_REINDEX_THRESHOLD } from '../src/indexer/freshness.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string

beforeEach(async () => {
  fixture = buildFixture({ git: true })
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-fresh-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
})

describe('checkFreshness', () => {
  it('reports missing when there is no index', () => {
    const f = checkFreshness(fixture, join(mkdtempSync(join(tmpdir(), 'arch-none-')), 'index.db'))
    expect(f.state).toBe('missing')
  })

  it('reports current right after a cold index', () => {
    expect(checkFreshness(fixture, dbPath).state).toBe('current')
  })

  it('reports incomplete when the completion flag is cleared', () => {
    const store = GraphStore.open(dbPath)
    store.setMeta('index_complete', '')
    store.close()
    expect(checkFreshness(fixture, dbPath).state).toBe('incomplete')
  })

  it('reports stale with a count once a file changes', () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
    const f = checkFreshness(fixture, dbPath)
    expect(f.state).toBe('stale')
    expect(f.changedFiles).toBe(1)
  })

  it('reports current for a non-git repo that indexed successfully', async () => {
    const plain = buildFixture()
    const plainDb = join(mkdtempSync(join(tmpdir(), 'arch-plain-')), 'index.db')
    await runColdIndex({ repoRoot: plain, dbPath: plainDb })
    expect(checkFreshness(plain, plainDb).state).toBe('current')
  })
})

describe('ensureFresh', () => {
  it('absorbs a small delta inline and comes back current', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n + 5; }\n')
    const f = await ensureFresh(fixture, dbPath)
    expect(f.state).toBe('current')
    expect(checkFreshness(fixture, dbPath).state).toBe('current')
  })

  it('leaves a large delta labelled stale instead of blocking', async () => {
    for (let i = 0; i < AUTO_REINDEX_THRESHOLD + 5; i++) {
      writeFileSync(join(fixture, `src/gen${i}.ts`), `export function gen${i}(): number { return ${i}; }\n`)
    }
    const f = await ensureFresh(fixture, dbPath)
    expect(f.state).toBe('stale')
    expect(f.changedFiles).toBeGreaterThan(AUTO_REINDEX_THRESHOLD)
    // and it did NOT quietly reindex
    expect(checkFreshness(fixture, dbPath).state).toBe('stale')
  })

  it('rebuilds an incomplete index rather than serving from it', async () => {
    const store = GraphStore.open(dbPath)
    store.setMeta('index_complete', '')
    store.close()
    expect((await ensureFresh(fixture, dbPath)).state).toBe('current')
  })

  it('is a cheap no-op when nothing changed', async () => {
    const before = GraphStore.open(dbPath).getMeta('indexed_at')
    const f = await ensureFresh(fixture, dbPath)
    expect(f.state).toBe('current')
    expect(f.changedFiles).toBe(0)
  })
})
