import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { computeChangeSet } from '../src/indexer/changeset.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string

beforeEach(async () => {
  fixture = buildFixture()
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-cs-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
})

function changeSet() {
  const store = GraphStore.open(dbPath)
  try {
    return computeChangeSet(fixture, store)
  } finally {
    store.close()
  }
}

describe('computeChangeSet', () => {
  it('reports nothing changed immediately after a cold index', () => {
    const cs = changeSet()
    expect(cs.changed).toEqual([])
    expect(cs.deleted).toEqual([])
    expect(cs.unchanged.length).toBeGreaterThan(0)
  })

  it('detects a modified file', () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number {\n  return n + 2;\n}\n')
    const cs = changeSet()
    expect(cs.changed).toEqual(['src/helper.ts'])
    expect(cs.deleted).toEqual([])
  })

  it('detects a new file', () => {
    writeFileSync(join(fixture, 'src/fresh.ts'), 'export function fresh(): void {}\n')
    const cs = changeSet()
    expect(cs.changed).toEqual(['src/fresh.ts'])
  })

  it('detects a deleted file', () => {
    rmSync(join(fixture, 'src/services/notify.ts'))
    const cs = changeSet()
    expect(cs.deleted).toEqual(['src/services/notify.ts'])
    expect(cs.changed).toEqual([])
  })

  it('treats a file that became skippable as deleted', () => {
    // Overwrite a source file with minified content; discovery now skips it,
    // so it must leave the graph rather than linger with stale symbols.
    writeFileSync(join(fixture, 'src/helper.ts'), '!function(){' + 'var a=1;'.repeat(200) + '}();\n')
    const cs = changeSet()
    expect(cs.deleted).toContain('src/helper.ts')
    expect(cs.changed).not.toContain('src/helper.ts')
  })

  it('carries the current skip classification through', () => {
    const cs = changeSet()
    expect(cs.skipped.some(s => s.reason === 'vendored')).toBe(true)
  })

  it('partitions every indexed and discovered path exactly once', () => {
    writeFileSync(join(fixture, 'src/fresh.ts'), 'export function fresh(): void {}\n')
    rmSync(join(fixture, 'src/services/notify.ts'))
    const cs = changeSet()
    const all = [...cs.changed, ...cs.unchanged, ...cs.deleted]
    expect(new Set(all).size).toBe(all.length)
    expect(all).toContain('src/fresh.ts')
    expect(all).toContain('src/services/notify.ts')
  })

  it('treats a file with invalid-UTF-8 bytes as unchanged once indexed', async () => {
    // Write raw bytes, not a JS string, so the invalid UTF-8 byte (0xE9,
    // a lone latin-1 'é') actually lands on disk instead of being
    // re-encoded as valid UTF-8 by the string round trip.
    writeFileSync(
      join(fixture, 'src/latin.ts'),
      Buffer.from([
        ...Buffer.from('// caf', 'utf8'),
        0xe9,
        ...Buffer.from('\nexport function latin(): void {}\n', 'utf8'),
      ]),
    )
    await runColdIndex({ repoRoot: fixture, dbPath })
    const cs = changeSet()
    expect(cs.unchanged).toContain('src/latin.ts')
    expect(cs.changed).not.toContain('src/latin.ts')
  })
})
