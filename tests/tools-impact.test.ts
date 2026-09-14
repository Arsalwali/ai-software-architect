import { describe, it, expect, beforeAll } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { impactOf } from '../src/tools/impact.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

/**
 * Writes an ad hoc repository into a fresh temp dir, independent of the
 * shared `buildFixture` fixture (tasks 1-7 assert on that one's exact
 * contents, so it must not be touched or overloaded for this task's
 * dedicated regression fixtures). No git init needed: the walkCandidates
 * discovery path already covers a plain, non-git directory tree elsewhere
 * in this suite.
 */
function writeLocalFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-imp-local-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-imp-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('impactOf', () => {
  it('finds the references to a symbol', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.references.some(ref => ref.path === 'src/services/order.ts')).toBe(true)
  })

  it('buckets by confidence and NEVER merges the buckets', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.buckets).toHaveProperty('verified')
    expect(r.buckets).toHaveProperty('likely')
    expect(r.buckets).toHaveProperty('ambiguous')
    expect(r.buckets.verified).toBe(0)            // nothing emits `exact` yet
    expect(r.buckets.likely).toBeGreaterThan(0)   // heuristic edges exist
    expect(r.buckets.verified + r.buckets.likely + r.buckets.ambiguous).toBe(r.totalReferences)
  })

  it('reports zero references for a symbol nobody calls, without throwing', () => {
    const r = impactOf(store, { symbol: 'unused', maxDepth: 3, limit: 50 })
    expect(r.totalReferences).toBe(0)
    expect(r.references).toEqual([])
  })

  it('groups references by module', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.byModule.some(m => m.module === 'src/services')).toBe(true)
  })

  it('does not flag exportedFromEntryPoint without a conventional name or a package.json declaration', () => {
    // OrderService lives in src/services/order.ts -- not a conventional
    // entry basename, and this fixture has no package.json, so this must
    // read false rather than true or some fuzzy "maybe". The genuine
    // positive case (both the conventional-name path and the
    // package.json-declared path) is covered by its own dedicated fixture
    // below, where it is actually reachable.
    const fromEntry = impactOf(store, { symbol: 'OrderService', maxDepth: 3, limit: 50 })
    expect(fromEntry.exportedFromEntryPoint).toBe(false)
    const internal = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(internal.exportedFromEntryPoint).toBe(false)
  })

  it('reports every candidate when the symbol name is not unique', () => {
    const r = impactOf(store, { symbol: 'notify', maxDepth: 3, limit: 50 })
    expect(r.matchedSymbols.length).toBeGreaterThanOrEqual(1)
    for (const m of r.matchedSymbols) expect(m).toHaveProperty('path')
  })

  it('reports a symbol that does not exist as unknown rather than as zero impact', () => {
    const r = impactOf(store, { symbol: 'noSuchSymbolAnywhere', maxDepth: 3, limit: 50 })
    expect(r.matchedSymbols).toEqual([])
    expect(r.note).toMatch(/not found/i)
  })

  it('terminates on a cycle', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 50, limit: 200 })
    const keys = r.references.map(ref => `${ref.path}:${ref.line}:${ref.symbolName}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('impactOf does not silently narrow the starting set', () => {
  // 25 files each export a distinct function named `dupSym` -- comfortably
  // more than the old hardcoded `limit: 20` on the `matches` query would
  // once have let through. Only the LAST one alphabetically (f24) has a
  // caller, so if the fix regresses back to a hardcoded cap, f24's
  // definition (and the reference to it) silently disappears before
  // `matchedSymbols`/`totalReferences`/`buckets` are even computed.
  const DUP_COUNT = 25
  let dupStore: GraphStore

  beforeAll(async () => {
    const files: Record<string, string> = {
      'src/caller.ts':
        'import { dupSym } from "./dupsym/f24";\n' +
        'export function useIt(): void {\n  dupSym();\n}\n',
    }
    for (let i = 0; i < DUP_COUNT; i++) {
      const n = String(i).padStart(2, '0')
      files[`src/dupsym/f${n}.ts`] = 'export function dupSym(): void {}\n'
    }
    const fixture = writeLocalFixture(files)
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-imp-dup-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    dupStore = GraphStore.open(dbPath)
  })

  it('reports every matched symbol, not just the first 20', () => {
    const r = impactOf(dupStore, { symbol: 'dupSym', maxDepth: 1, limit: 100 })
    expect(r.matchedSymbols.length).toBe(DUP_COUNT)
  })

  it('still finds the reference to the definition past the old cutoff', () => {
    const r = impactOf(dupStore, { symbol: 'dupSym', maxDepth: 1, limit: 100 })
    expect(r.references.some(ref => ref.path === 'src/caller.ts')).toBe(true)
    expect(r.totalReferences).toBeGreaterThan(0)
  })
})

describe('impactOf exportedFromEntryPoint, the reachable positive cases', () => {
  // A dedicated fixture, not the shared one: the shared fixture's index.ts
  // exports nothing, so there was previously no way for the positive case
  // to ever be true. This fixture gives both halves of the check something
  // real to find: a conventionally-named entry file, and a package.json
  // that declares a differently-named one.
  let entryStore: GraphStore
  let entryFixture: string

  beforeAll(async () => {
    entryFixture = writeLocalFixture({
      'src/index.ts': 'export function ConventionalEntry(): number {\n  return 1;\n}\n',
      'src/public.ts': 'export function DeclaredEntry(): number {\n  return 2;\n}\n',
      'src/internal.ts': 'export function NotAnEntry(): number {\n  return 3;\n}\n',
      'package.json': JSON.stringify({ name: 'entry-fixture', main: 'src/public.ts' }, null, 2),
    })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-imp-entry-')), 'index.db')
    await runColdIndex({ repoRoot: entryFixture, dbPath })
    entryStore = GraphStore.open(dbPath)
  })

  it('flags a symbol exported from a conventionally-named entry file', () => {
    const r = impactOf(entryStore, { symbol: 'ConventionalEntry', maxDepth: 1, limit: 10, repoRoot: entryFixture })
    expect(r.exportedFromEntryPoint).toBe(true)
  })

  it('flags a symbol exported from a file package.json declares as an entry point', () => {
    const r = impactOf(entryStore, { symbol: 'DeclaredEntry', maxDepth: 1, limit: 10, repoRoot: entryFixture })
    expect(r.exportedFromEntryPoint).toBe(true)
  })

  it('does not flag a symbol in neither category', () => {
    const r = impactOf(entryStore, { symbol: 'NotAnEntry', maxDepth: 1, limit: 10, repoRoot: entryFixture })
    expect(r.exportedFromEntryPoint).toBe(false)
  })
})

describe('impactOf ambiguous bucketing, a genuine name collision', () => {
  // Spec §10 calls for a deliberately ambiguous name collision fixture;
  // unmet since Plan 1. `shared` is exported by both a.ts and b.ts.
  // consumer.ts resolves imports to BOTH files (via unrelated names
  // helperA/helperB) and then calls the bare identifier `shared()`, which
  // resolveCallsForFile's candidate set treats as ambiguous between every
  // exported `shared` in a resolved-import target file -- genuinely fanned
  // out, not a trivial single-candidate case. onlyA.ts resolves an import
  // to ONLY a.ts, so its call to `shared()` resolves uniquely (heuristic),
  // giving both a real ambiguous and a real heuristic edge into the same
  // symbol pool to bucket.
  let ambStore: GraphStore

  beforeAll(async () => {
    const fixture = writeLocalFixture({
      'src/a.ts':
        'export function shared(): number {\n  return 1;\n}\n' +
        'export function helperA(): number {\n  return 0;\n}\n',
      'src/b.ts':
        'export function shared(): number {\n  return 2;\n}\n' +
        'export function helperB(): number {\n  return 0;\n}\n',
      'src/consumer.ts':
        'import { helperA } from "./a";\n' +
        'import { helperB } from "./b";\n' +
        'export function run(): number {\n  return shared();\n}\n',
      'src/onlyA.ts':
        'import { shared } from "./a";\n' +
        'export function callOnlyA(): number {\n  return shared();\n}\n',
    })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-imp-amb-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    ambStore = GraphStore.open(dbPath)
  })

  it('reports more than one matched candidate, proving the multi-candidate path', () => {
    const r = impactOf(ambStore, { symbol: 'shared', maxDepth: 3, limit: 50 })
    expect(r.matchedSymbols.length).toBeGreaterThanOrEqual(2)
  })

  it('buckets the genuinely ambiguous call as ambiguous, distinct from likely', () => {
    const r = impactOf(ambStore, { symbol: 'shared', maxDepth: 3, limit: 50 })
    expect(r.buckets.ambiguous).toBeGreaterThan(0)
    expect(r.buckets.likely).toBeGreaterThan(0)
    expect(r.buckets.verified + r.buckets.likely + r.buckets.ambiguous).toBe(r.totalReferences)
  })
})
