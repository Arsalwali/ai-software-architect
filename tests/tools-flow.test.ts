import { describe, it, expect, beforeAll } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { traceFlow } from '../src/tools/flow.js'
import { buildFixture } from './fixture-builder.js'

/**
 * Writes an ad hoc repository into a fresh temp dir, independent of the
 * shared `buildFixture` fixture (whose exact contents other tests assert
 * on, so it must not be touched or overloaded for this task's dedicated
 * regression fixtures). Mirrors tools-impact.test.ts's writeLocalFixture.
 * No git init needed: the walkCandidates discovery path already covers a
 * plain, non-git directory tree elsewhere in this suite.
 */
function writeLocalFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-flow-local-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

async function indexLocalFixture(files: Record<string, string>): Promise<GraphStore> {
  const fixture = writeLocalFixture(files)
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-flow-local-db-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  return GraphStore.open(dbPath)
}

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-flow-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('traceFlow', () => {
  it('walks forward from an entry symbol', () => {
    const r = traceFlow(store, { entry: 'place', maxDepth: 3, limit: 50 })
    expect(r.root).not.toBeNull()
    expect(r.root!.name).toBe('place')
    expect(r.root!.calls.length).toBeGreaterThan(0)
  })

  it('annotates each step with its file and whether it crosses a module boundary', () => {
    const r = traceFlow(store, { entry: 'place', maxDepth: 3, limit: 50 })
    const step = r.root!.calls.find(c => c.name === 'helper')!
    expect(step.path).toBe('src/helper.ts')
    expect(step.crossesModule).toBe(true)
    expect(step.confidence).toBe('heuristic')
  })

  it('reports an external call as unresolved without trying to expand it', () => {
    const r = traceFlow(store, { entry: 'notify', maxDepth: 3, limit: 50 })
    const external = r.root!.calls.find(c => c.name === 'log')!
    expect(external.confidence).toBe('unresolved')
    expect(external.path).toBeNull()
    expect(external.calls).toEqual([])
  })

  it('honours maxDepth and reports when it was cut off', () => {
    const shallow = traceFlow(store, { entry: 'place', maxDepth: 1, limit: 50 })
    expect(shallow.depthLimited).toBe(true)
    const deep = traceFlow(store, { entry: 'place', maxDepth: 10, limit: 50 })
    expect(deep.depthLimited).toBe(false)
  })

  it('explains an unknown entry rather than returning an empty tree', () => {
    const r = traceFlow(store, { entry: 'noSuchEntryPoint', maxDepth: 3, limit: 50 })
    expect(r.root).toBeNull()
    expect(r.note).toMatch(/not found/i)
  })

  it('marks a node already expanded elsewhere as repeated rather than expanding it twice', () => {
    const r = traceFlow(store, { entry: 'place', maxDepth: 10, limit: 100 })
    const seen = new Set<string>()
    const walk = (node: { name: string; path: string | null; repeated: boolean; calls: any[] }): void => {
      const key = `${node.path}:${node.name}`
      if (!node.repeated && node.path !== null) {
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
      for (const child of node.calls) walk(child)
    }
    walk(r.root!)
  })

  it('honours limit and reports when it was cut off', () => {
    // limit: 1 leaves no room for the root's own children, so the walk
    // must cut short immediately -- mirrors the maxDepth test above.
    const capped = traceFlow(store, { entry: 'place', maxDepth: 5, limit: 1 })
    expect(capped.limitReached).toBe(true)
    expect(capped.root!.calls).toEqual([])

    const roomy = traceFlow(store, { entry: 'place', maxDepth: 5, limit: 50 })
    expect(roomy.limitReached).toBe(false)
  })

  it('does not falsely label a second reference to a cut-short symbol as repeated', async () => {
    // Two different callers (callerA, callerB) reach the same target. The
    // FIRST one the walk reaches has its own expansion cut short before it
    // examines a single edge (maxDepth: 2 means target's own children,
    // computed one level deeper, immediately trip the depth guard). The
    // SECOND caller's edge to the same target must not claim `repeated:
    // true` -- that would tell a reader "the full expansion appears
    // elsewhere in this tree" when in fact target's real children
    // (deepThing) were never examined by either branch.
    //
    // This deliberately exercises the depth guard rather than the node
    // `limit`, even though the underlying bug (and fix) is the same code
    // path for both: `limit` cannot produce this scenario at all, because
    // it is a single counter shared across the WHOLE traversal that is
    // checked with `>=` before every node is created. The very first node
    // whose own creation pushes that counter to the limit is provably the
    // LAST node the entire walk will ever create -- the very next loop
    // check anywhere (including a sibling caller's turn one level up)
    // immediately breaks too. So a second, later sibling reaching the same
    // target could never be created once the first one's expansion has
    // been cut short by `limit`. `maxDepth`, by contrast, is evaluated
    // per branch, so callerB's branch is unaffected by callerA's cutoff --
    // which is exactly what is needed to observe a second occurrence next
    // to a genuinely unrealized first one.
    const local = await indexLocalFixture({
      'src/graph.ts': `
export function entry(): void {
  callerA();
  callerB();
}
export function callerA(): void {
  target();
}
export function callerB(): void {
  target();
}
export function target(): void {
  deepThing();
}
export function deepThing(): void {}
`,
    })
    try {
      const r = traceFlow(local, { entry: 'entry', maxDepth: 2, limit: 100 })
      expect(r.depthLimited).toBe(true)

      const callerA = r.root!.calls.find(c => c.name === 'callerA')!
      const callerB = r.root!.calls.find(c => c.name === 'callerB')!
      const targetViaA = callerA.calls.find(c => c.name === 'target')!
      const targetViaB = callerB.calls.find(c => c.name === 'target')!

      // Neither occurrence points at real detail: the first because its
      // own expansion was cut short before it ran, the second because it
      // is deliberately not claiming otherwise.
      expect(targetViaA.repeated).toBe(false)
      expect(targetViaA.calls).toEqual([])
      expect(targetViaB.repeated).toBe(false)
      expect(targetViaB.calls).toEqual([])
    } finally {
      local.close()
    }
  })

  it('terminates on genuine mutual recursion and marks the revisited call repeated', async () => {
    const local = await indexLocalFixture({
      'src/mutual.ts': `
export function a(): void {
  b();
}
export function b(): void {
  a();
}
`,
    })
    try {
      // Bounded low on purpose: this is the load-bearing termination
      // property, and a low maxDepth means that even a broken cycle guard
      // would fail this test's assertions quickly (via the independent
      // depth backstop) rather than hang the run.
      const r = traceFlow(local, { entry: 'a', maxDepth: 5, limit: 50 })
      expect(r.root!.name).toBe('a')

      const bNode = r.root!.calls.find(c => c.name === 'b')!
      expect(bNode.repeated).toBe(false)

      const secondA = bNode.calls.find(c => c.name === 'a')!
      expect(secondA.repeated).toBe(true)
      expect(secondA.calls).toEqual([])
    } finally {
      local.close()
    }
  })
})
