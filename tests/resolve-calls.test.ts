import { describe, it, expect, beforeAll } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveCallsForFile } from '../src/indexer/resolve-calls.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { SymbolRow } from '../src/store/graph-store.js'
import type { CallSite } from '../src/types.js'

function symbol(id: number, fileId: number, name: string, exported = true): SymbolRow {
  return { id, fileId, name, kind: 'function', startLine: 1, endLine: 2, exported }
}

// file 1 = caller.ts, file 2 = helper.ts, file 3 = other.ts
const localSymbols = [symbol(10, 1, 'localFn', false)]
const exportedByFile = new Map<number, SymbolRow[]>([
  [2, [symbol(20, 2, 'helper')]],
  [3, [symbol(30, 3, 'helper')]],
])

function call(name: string, enclosing: string | null = null): CallSite {
  return { name, line: 5, enclosingSymbol: enclosing, kind: 'calls' }
}

describe('resolveCallsForFile', () => {
  it('marks a single candidate as heuristic', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ dstSymbolId: 20, dstFileId: 2, confidence: 'heuristic' })
  })

  it('fans out to every candidate and marks them ambiguous', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2, 3],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(2)
    expect(edges.every(e => e.confidence === 'ambiguous')).toBe(true)
    expect(edges.map(e => e.dstSymbolId).sort()).toEqual([20, 30])
  })

  it('prefers a local declaration over imports and treats it as unambiguous', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols: [symbol(10, 1, 'helper', false)],
      importedFileIds: [2, 3],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ dstSymbolId: 10, confidence: 'heuristic' })
  })

  it('records an unresolved edge when nothing matches', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [],
      exportedByFile,
      callSites: [call('console')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      dstSymbolId: null, dstFileId: null, dstName: 'console', confidence: 'unresolved',
    })
  })

  it('attributes the edge to the enclosing symbol when there is one', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper', 'localFn')],
    })
    expect(edges[0].srcSymbolId).toBe(10)
  })

  it('leaves srcSymbolId null for a top-level call but always sets srcFileId', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper', null)],
    })
    expect(edges[0].srcSymbolId).toBeNull()
    expect(edges[0].srcFileId).toBe(1)
  })

  it('maps instantiation call sites to the instantiates edge kind', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [{ name: 'helper', line: 9, enclosingSymbol: null, kind: 'instantiates' }],
    })
    expect(edges[0].kind).toBe('instantiates')
  })
})

/**
 * Dedicated fixture written to its own temp dir -- NOT the shared
 * `buildFixture` from fixture-builder.ts, which ten other tasks assert on
 * the exact contents of.
 */
function writeLocalFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-resolve-dup-import-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

describe('Fix 1 regression: a duplicate import row must not manufacture a false ambiguity', () => {
  // `import { helper } from './m'` plus `import type { Opts } from './m'`
  // is an everyday TypeScript pattern -- two import declarations resolving
  // to the SAME file. pipeline.ts (and incremental.ts) push one entry per
  // raw import row into `importedFileIds`, so without deduplicating at
  // resolveCallsForFile's chokepoint, `m`'s single exported `helper` enters
  // `importedByName` twice, manufacturing `candidates.length === 2` and a
  // false `ambiguous` edge out of what is really one unambiguous candidate.
  // This is an end-to-end fixture (real cold index, real parser) rather
  // than a unit call into resolveCallsForFile directly, so it also proves
  // the parser and pipeline.ts genuinely produce two import rows for this
  // pattern -- not just that resolveCallsForFile's own dedup logic works
  // when handed a hand-built duplicate array.
  let store: GraphStore

  beforeAll(async () => {
    const fixture = writeLocalFixture({
      'src/m.ts':
        'export function helper(): number {\n  return 1;\n}\n' +
        'export interface Opts {\n  x: number;\n}\n',
      'src/caller.ts':
        'import { helper } from "./m";\n' +
        'import type { Opts } from "./m";\n\n' +
        'export function run(): number {\n  return helper();\n}\n',
    })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-resolve-dup-import-db-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    store = GraphStore.open(dbPath)
  })

  it('produces exactly one heuristic edge, not two ambiguous ones', () => {
    const callEdges = store.allEdgeDetails().filter(e => e.kind === 'calls' && e.dstName === 'helper')
    expect(callEdges).toHaveLength(1)
    expect(callEdges[0].confidence).toBe('heuristic')
    expect(callEdges.some(e => e.confidence === 'ambiguous')).toBe(false)
  })
})
