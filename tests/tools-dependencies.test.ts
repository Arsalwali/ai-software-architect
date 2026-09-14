import { describe, it, expect, beforeAll } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { getDependencies, resolveTarget } from '../src/tools/dependencies.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

/**
 * Ad hoc repository in a fresh temp dir, independent of the shared
 * `buildFixture` (tasks 1-7 assert on its exact contents). No git init
 * needed: plain non-git directories already go through the walkCandidates
 * discovery path elsewhere in this suite.
 */
function writeLocalFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-dep-local-'))
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
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-dep-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('resolveTarget', () => {
  it('recognises an exact file path', () => {
    expect(resolveTarget(store, 'src/helper.ts')).toMatchObject({ kind: 'file', resolved: 'src/helper.ts' })
  })

  it('recognises a directory as a module', () => {
    expect(resolveTarget(store, 'src/services')).toMatchObject({ kind: 'module', resolved: 'src/services' })
  })

  it('falls back to a symbol name', () => {
    expect(resolveTarget(store, 'helper')).toMatchObject({ kind: 'symbol', resolved: 'helper' })
  })

  it('reports every candidate when a symbol name is not unique', () => {
    const t = resolveTarget(store, 'notify')
    expect(t.kind).toBe('symbol')
    expect(Array.isArray(t.candidates)).toBe(true)
  })

  it('returns kind "unknown" for something that matches nothing', () => {
    expect(resolveTarget(store, 'nothing/at/all').kind).toBe('unknown')
  })
})

describe('getDependencies at file level', () => {
  it('direction out lists what a file imports', () => {
    const r = getDependencies(store, { target: 'src/services/order.ts', direction: 'out', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/helper.ts')
  })

  it('direction in lists what imports a file', () => {
    const r = getDependencies(store, { target: 'src/helper.ts', direction: 'in', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/services/order.ts')
  })

  it('respects depth', () => {
    const shallow = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 1, limit: 50 })
    const deep = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 3, limit: 50 })
    expect(deep.nodes.length).toBeGreaterThanOrEqual(shallow.nodes.length)
    expect(deep.nodes.map(n => n.path)).toContain('src/helper.ts')
  })

  it('never revisits a node, so a cycle terminates', () => {
    const r = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 10, limit: 100 })
    const paths = r.nodes.map(n => n.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('treats a module target as the union of its files', () => {
    const r = getDependencies(store, { target: 'src/services', direction: 'out', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/helper.ts')
  })

  it('minConfidence is not a silent no-op for a file target: a floor above "resolved" yields nothing', () => {
    const unfiltered = getDependencies(store, { target: 'src/services/order.ts', direction: 'out', depth: 1, limit: 50 })
    expect(unfiltered.nodes.length).toBeGreaterThan(0)

    const strict = getDependencies(
      store, { target: 'src/services/order.ts', direction: 'out', depth: 1, minConfidence: 'exact', limit: 50 },
    )
    expect(strict.nodes).toHaveLength(0)
  })

  it('minConfidence is not a silent no-op for a module target: a floor above "resolved" yields nothing', () => {
    const unfiltered = getDependencies(store, { target: 'src/services', direction: 'out', depth: 1, limit: 50 })
    expect(unfiltered.nodes.length).toBeGreaterThan(0)

    const strict = getDependencies(
      store, { target: 'src/services', direction: 'out', depth: 1, minConfidence: 'exact', limit: 50 },
    )
    expect(strict.nodes).toHaveLength(0)
  })
})

describe('getDependencies at symbol level', () => {
  it('direction in lists callers of a symbol with their confidence', () => {
    const r = getDependencies(store, { target: 'helper', direction: 'in', depth: 1, limit: 50 })
    expect(r.nodes.some(n => n.path === 'src/services/order.ts' && n.confidence === 'heuristic')).toBe(true)
  })

  it('filters by minConfidence using the explicit rank', () => {
    const all = getDependencies(store, { target: 'helper', direction: 'in', depth: 2, limit: 50 })
    const strict = getDependencies(store, { target: 'helper', direction: 'in', depth: 2, minConfidence: 'exact', limit: 50 })
    expect(strict.nodes.length).toBeLessThanOrEqual(all.nodes.length)
    expect(strict.nodes).toHaveLength(0)   // nothing emits `exact` yet
  })

  it('truncates loudly', () => {
    const r = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 5, limit: 1 })
    expect(r.nodes).toHaveLength(1)
    expect(r.truncated!.total).toBeGreaterThan(1)
  })
})

describe('resolveTarget and symbolLevel do not silently narrow the starting set', () => {
  // 25 files each export a distinct function literally named `dupSym` --
  // comfortably more than the old hardcoded `limit: 20` on the two
  // `findSymbols` calls in resolveTarget and symbolLevel would once have
  // let through. Only f24 (the last one alphabetically, so the first one
  // an off-by-one-safe cap would drop) has an actual caller.
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
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-dep-dup-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    dupStore = GraphStore.open(dbPath)
  })

  it('resolveTarget reports every candidate, not just the first 20', () => {
    const t = resolveTarget(dupStore, 'dupSym')
    expect(t.kind).toBe('symbol')
    expect(t.candidates).toHaveLength(DUP_COUNT)
  })

  it('symbolLevel BFS starts from every definition, so a caller of the 25th is not dropped', () => {
    const r = getDependencies(dupStore, { target: 'dupSym', direction: 'in', depth: 1, limit: 100 })
    expect(r.nodes.map(n => n.path)).toContain('src/caller.ts')
  })
})

describe('getDependencies minConfidence ordering, with a genuine ambiguous edge', () => {
  // Spec §10's required "deliberately ambiguous name collision" fixture,
  // dedicated to this test rather than the shared one. `shared` is
  // exported by both a.ts and b.ts; consumer.ts resolves imports to BOTH
  // (via unrelated names) and calls the bare identifier `shared()`, which
  // fans out to both candidates as `ambiguous`. onlyA.ts resolves an
  // import to ONLY a.ts, so its call to `shared()` resolves uniquely
  // (`heuristic`). That gives both tiers real edges into the same name to
  // filter between -- unlike the `exact` case above, which is zero
  // regardless of whether the rank ordering is even correct.
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
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-dep-amb-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    ambStore = GraphStore.open(dbPath)
  })

  it('a minConfidence of heuristic includes the heuristic edge and excludes the ambiguous ones', () => {
    const unfiltered = getDependencies(ambStore, { target: 'shared', direction: 'in', depth: 1, limit: 50 })
    expect(unfiltered.nodes.some(n => n.confidence === 'ambiguous')).toBe(true)
    expect(unfiltered.nodes.some(n => n.confidence === 'heuristic')).toBe(true)

    const strict = getDependencies(
      ambStore, { target: 'shared', direction: 'in', depth: 1, minConfidence: 'heuristic', limit: 50 },
    )
    expect(strict.nodes.length).toBeGreaterThan(0)
    expect(strict.nodes.every(n => n.confidence === 'heuristic')).toBe(true)
    expect(strict.nodes.some(n => n.confidence === 'ambiguous')).toBe(false)
    expect(strict.nodes.length).toBeLessThan(unfiltered.nodes.length)
  })
})
