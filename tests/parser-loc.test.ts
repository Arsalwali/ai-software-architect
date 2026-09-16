import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RepoParser } from '../src/parser/parser.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let parser: RepoParser
beforeAll(async () => { parser = await RepoParser.create() })

describe('ParsedFile.loc', () => {
  it('counts lines of a multi-line source', () => {
    expect(parser.parse('a.ts', 'const a = 1;\nconst b = 2;\nconst c = 3;\n').loc).toBe(3)
  })

  it('counts a single line with no trailing newline', () => {
    expect(parser.parse('a.ts', 'const a = 1;').loc).toBe(1)
  })

  it('reports 0 for an empty file', () => {
    expect(parser.parse('a.ts', '').loc).toBe(0)
  })

  it('counts lines for a file with no known language', () => {
    expect(parser.parse('README.md', '# one\n# two\n').loc).toBe(2)
  })
})

describe('files.loc persistence', () => {
  it('is non-zero for indexed source files', async () => {
    const fixture = buildFixture({ git: true })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-loc-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    const store = GraphStore.open(dbPath)
    expect(store.fileRow('src/services/order.ts')!.loc).toBeGreaterThan(0)
    expect(store.fileRow('README.md')!.loc).toBeGreaterThan(0)
    store.close()
  })
})
