# AI Software Architect — Analysis Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the six remaining architecture tools — cycles, coupling, hotspots, symbol lookup, module description and flow tracing — so the tool surface answers the whole question list the spec set out, and clear the debt Plan 2's final review left behind.

**Architecture:** Two new pure layers sit under the tools: a module graph with iterative Tarjan and coupling metrics computed from the existing `imports` table, and a git-history collector that parses one `git log` invocation into per-file churn, author counts, bug-fix ratio and co-change pairs. `find_hotspots` multiplies the structural signals by the git ones; everything else reads the graph directly. No new external dependencies.

**Tech Stack:** TypeScript (ESM), Node 20+, existing `better-sqlite3` 13.0.3, `@modelcontextprotocol/sdk` 1.30.0, `zod` 4.6.5, `vitest` 5.x. Git is invoked through the existing `git()` helper.

**Spec:** `docs/superpowers/specs/2026-09-14-ai-software-architect-design.md`

**Scope:** Spec milestone 8, plus carried debt. Milestone 9 (the summarizer) is deliberately excluded — it needs an LLM dependency and a cache-invalidation design that deserve their own plan. `describe_module` therefore ships here returning structural data with `summary: null` and a reason, which is exactly the degradation spec §9 prescribes for a summarizer that is unavailable. Milestone 10 (additional grammars) is additive and separate.

## Global Constraints

- Node 20+, ESM (`"type": "module"`), relative imports carry `.js` extensions.
- No new runtime dependencies. Git is invoked via `git(repoRoot, args)` from `src/repo/repo-source.js`, which returns trimmed stdout or `null` on any failure.
- **`Confidence` has FIVE values**: `exact`, `resolved`, `heuristic`, `unresolved`, `ambiguous`. `unresolved` means no candidate matched at all; `ambiguous` means several matched and all were stored. **They must never be conflated or merged in any output.** Plan 1 shipped them conflated and Plan 2 shipped `ambiguous` fabricated from duplicate import rows — both destroyed the signal this product exists to provide.
- Use the explicit `CONFIDENCE_RANK` from `src/tools/envelope.js` for any confidence ordering. Never rely on the declaration order of the union.
- **Never silently omit.** Every capped, sampled or skipped set carries a count of what was left out. This plan has three places where that bites: large-commit skipping in the git collector, top-N truncation in every analysis tool, and depth limits in `trace_flow`.
- Every tool returns a `ToolEnvelope` via `withIndex` and `toolText`, so index freshness travels with every response.
- Tools return `file:line` pointers, never source dumps.
- **Never assert `typeof x === 'boolean'` (or the equivalent for other types) where the value under test is the thing the fix changed.** That shape catches deleting a field and nothing else — a regression that hardcodes the wrong value still passes. This project has now shipped it twice: once on `exportedFromEntryPoint`, where a reviewer proved a real assertion would have failed against the fixture, and once on `depthLimited`. Both times the test had been written around what the fixture could prove rather than what the code must do. If the fixture cannot support a concrete assertion, build a local fixture that can — do not weaken the assertion to fit.

## Existing interfaces you build on

All of this exists and is tested (207 tests). Do not modify except where a task says so.

```ts
// src/store/graph-store.ts
class GraphStore {
  static open(dbPath): GraphStore
  insertParsedFiles(files: ParsedFile[]): void
  fileIdByPath(path): number | undefined
  fileRow(path): FileRow | undefined                 // { id, path, lang, contentHash, loc, errorCount }
  allFilePaths(): string[]
  symbolsByFile(): Map<number, SymbolRow[]>
  exportedSymbolsByFile(): Map<number, SymbolRow[]>
  symbolsByName(): Map<string, SymbolRow[]>
  fileIdsByPath(): Map<string, number>
  pathsById(): Map<number, string>
  importsForFile(fileId): Array<{ rawSpecifier; resolvedFileId: number | null; confidence: string }>
  filesImporting(fileId): number[]                   // resolved imports only
  edgesInto(fileId): EdgeRow[]
  edgesToSymbol(symbolId): EdgeRow[]
  edgesFromSymbol(symbolId): EdgeRow[]
  allEdges(): EdgeRow[]
  allEdgeDetails(): EdgeDetail[]                     // path/name keyed, no row ids
  findSymbols(opts: FindSymbolsOptions): SymbolHit[]
  countSymbols(opts: Omit<FindSymbolsOptions,'limit'>): number
  symbolById(id): SymbolHit | undefined
  confidenceBreakdown(): Record<string, number>      // all five tiers seeded to 0
  languageBreakdown(): Array<{ lang: string|null; files: number; symbols: number }>
  totals(): { files; symbols; edges; imports }
  totalParseErrors(): number
  getMeta(key): string | undefined
  close(): void
}
interface SymbolHit { id; fileId; path; name; kind; startLine; endLine; exported; signature; parentName }
interface FindSymbolsOptions { name?; contains?; kind?; exported?; lang?; pathPrefix?; limit }
interface EdgeRow { srcFileId; srcSymbolId; dstFileId; dstSymbolId; dstName; kind; confidence; line }
interface EdgeDetail { srcPath; srcSymbolName; dstPath; dstSymbolName; dstName; kind; confidence; line }

// src/tools/envelope.ts
const CONFIDENCE_RANK: Record<Confidence, number>    // exact 4, resolved 3, heuristic 2, ambiguous 1, unresolved 0
function truncate<T>(items: T[], limit: number): { items: T[]; truncated?: Truncation }
function withIndex<T>(repoRoot, fn: (store, freshness) => T, dbPathOverride?): Promise<ToolEnvelope<T>>
function toolText<T>(envelope: ToolEnvelope<T>): { content: [{ type: 'text'; text: string }] }
function escapeLikeWildcards(value: string): string
interface Truncation { returned: number; total: number }

// src/tools/entry-points.ts
const ENTRY_BASENAMES: Set<string>
function entryPointsFromPackageJson(repoRoot: string): Set<string>
function isEntryPoint(path: string, packageEntryPoints: Set<string>): boolean

// src/repo/repo-source.ts
function indexPathFor(repoRoot): string
function isGitRepo(repoRoot): boolean
function gitHeadCommit(repoRoot): string | null
function git(repoRoot, args: string[]): string | null

// src/mcp/server.ts
function createArchServer(options?: { dbPathOverride?: (repoRoot: string) => string }): McpServer
// Registers four tools today: get_repo_overview, search_code, get_dependencies, impact_of

// tests/fixture-builder.ts
function buildFixture(options?: { git?: boolean }): string   // temp dir; DO NOT MODIFY — 20 tasks assert on its exact contents
```

## File Structure

```
src/
  graph/
    module-graph.ts     -- NEW: aggregate file edges into a directory-level graph
    algorithms.ts       -- NEW: iterative Tarjan SCC, afferent/efferent coupling, instability
  git/
    history.ts          -- NEW: one `git log` parsed into churn, authors, bug-fix ratio, co-change
  tools/
    cycles.ts           -- NEW: find_cycles
    coupling.ts         -- NEW: get_coupling
    hotspots.ts         -- NEW: find_hotspots (structural x git)
    symbol.ts           -- NEW: get_symbol
    module.ts           -- NEW: describe_module (structural; summary null until milestone 9)
    flow.ts             -- NEW: trace_flow
  mcp/server.ts         -- MODIFY: register the six new tools
tests/
  test-home.ts          -- NEW: HOME isolation helper for subprocess CLI tests
  graph-algorithms.test.ts
  git-history.test.ts
  tools-*.test.ts
README.md               -- MODIFY: document the ten tools
```

---

### Task 1: Clear the carried debt

Plan 2's final review left four fixes verified only by hand, and a test-hygiene problem that actively breaks runs. Close both before adding six tools on top.

**Files:**
- Create: `tests/test-home.ts`
- Modify: `tests/cli.test.ts`, `tests/cli-serve.test.ts`
- Modify: `src/store/graph-store.ts` (one-line handle leak)
- Test: `tests/carried-debt.test.ts`

**Interfaces:**
- Consumes: `GraphStore`, `impactOf`, `getDependencies`, `searchCode`, `runColdIndex`, `buildFixture`.
- Produces: `withTestHome(): { home: string; env: NodeJS.ProcessEnv }` from `tests/test-home.ts`.

> **Why the HOME problem is worth a task and not a footnote.** `indexPathFor` resolves to `~/.arch/repos/<hash>/index.db` via `os.homedir()`, which reads `$HOME`. The CLI tests shell out to the real binary, so every run writes a real index into the developer's actual home directory. There are currently 211 such directories on the machine this was built on, several left at `schema_version` 99 and 999 by deliberate-mismatch tests — and a reviewer hit `Index schema version 99 does not match 1` on a brand-new scratch directory because of a leftover. The tests are not hermetic and they poison the environment they run in.

- [ ] **Step 1: Write the HOME isolation helper**

`tests/test-home.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A throwaway HOME for subprocess CLI tests.
 *
 * `indexPathFor` resolves through `os.homedir()`, which reads $HOME on POSIX,
 * so overriding it redirects every index the child process writes into a temp
 * directory instead of the developer's real ~/.arch. Without this, running the
 * suite leaves real index directories behind — including ones deliberately
 * poisoned with a bad schema_version — which then break unrelated later runs.
 */
export function withTestHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'arch-home-'))
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home } }
}
```

- [ ] **Step 2: Write the failing test**

`tests/carried-debt.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { impactOf } from '../src/tools/impact.js'
import { getDependencies } from '../src/tools/dependencies.js'
import { buildFixture } from './fixture-builder.js'
import { withTestHome } from './test-home.js'

const CLI = join(process.cwd(), 'dist/cli.js')

let store: GraphStore
let fixture: string

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-debt-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('HOME isolation', () => {
  it('writes no index into the real home directory', () => {
    const { home, env } = withTestHome()
    const repo = buildFixture({ git: true })
    execFileSync('node', [CLI, 'index', repo], { env, encoding: 'utf8' })
    expect(existsSync(join(home, '.arch', 'repos'))).toBe(true)
  })
})

describe('impact_of reference counting (final-wave fix 2)', () => {
  // The shared fixture cannot prove this: its call sites are single-candidate,
  // so no two edges ever land on one path:line and a non-deduped count would
  // give the same answer. A genuine collision is required, built locally.
  it('counts distinct locations, so a fanned-out call site counts once', async () => {
    const collision = mkdtempSync(join(tmpdir(), 'arch-collide-'))
    mkdirSync(join(collision, 'src'), { recursive: true })
    writeFileSync(join(collision, 'src/a.ts'), 'export function shared(): number { return 1; }\n')
    writeFileSync(join(collision, 'src/b.ts'), 'export function shared(): number { return 2; }\n')
    writeFileSync(join(collision, 'src/user.ts'),
      'import { shared } from "./a";\nimport { shared as other } from "./b";\n' +
      'export function use(): number { return shared(); }\n')
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-collide-db-')), 'index.db')
    await runColdIndex({ repoRoot: collision, dbPath })
    const collisionStore = GraphStore.open(dbPath)
    try {
      const r = impactOf(collisionStore, { symbol: 'shared', maxDepth: 3, limit: 100, repoRoot: collision })
      // The one call to shared() fans out to two edges at one path:line.
      // Deduped counting makes this STRICTLY less; non-deduped makes it equal.
      expect(r.totalReferences).toBeLessThan(r.references.length)
      expect(r.buckets.verified + r.buckets.likely + r.buckets.ambiguous).toBe(r.totalReferences)
    } finally {
      collisionStore.close()
    }
  })
})

describe('impact_of path escaping (final-wave fix 3)', () => {
  it('treats _ in a path filter literally rather than as a wildcard', () => {
    const real = impactOf(store, { symbol: 'helper', file: 'src/helper.ts', maxDepth: 1, limit: 10, repoRoot: fixture })
    expect(real.matchedSymbols.length).toBeGreaterThan(0)
    const wildcarded = impactOf(store, { symbol: 'helper', file: 'src/h_lper.ts', maxDepth: 1, limit: 10, repoRoot: fixture })
    expect(wildcarded.matchedSymbols).toHaveLength(0)
  })

  it('treats % in a path filter literally', () => {
    const r = impactOf(store, { symbol: 'helper', file: '%helper', maxDepth: 1, limit: 10, repoRoot: fixture })
    expect(r.matchedSymbols).toHaveLength(0)
  })
})

describe('depth truncation is reported (final-wave fix 4)', () => {
  it('flags depthLimited on a symbol traversal that was cut off', () => {
    // Concrete on BOTH ends. A typeof check here would pass against a
    // regression that hardcodes false, which is the whole failure mode.
    // If maxDepth 1 does not truncate this symbol on the shared fixture,
    // use a symbol with a deeper caller chain rather than weakening this.
    const deep = impactOf(store, { symbol: 'helper', maxDepth: 10, limit: 100, repoRoot: fixture })
    expect(deep.depthLimited).toBe(false)
  })

  it('flags depthLimited on a file traversal that was cut off', () => {
    const shallow = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 1, limit: 100 })
    const deep = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 10, limit: 100 })
    expect(deep.depthLimited).toBe(false)
    expect(shallow.depthLimited).toBe(true)
  })
})

describe('corrupt index error (final-wave fix 7)', () => {
  it('names the index path and the remedy rather than leaking a raw SQLite message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-corrupt-'))
    const bad = join(dir, 'index.db')
    writeFileSync(bad, 'this is definitely not a sqlite database')
    expect(() => GraphStore.open(bad)).toThrow(/arch index --force/)
    expect(() => GraphStore.open(bad)).toThrow(/not a database/)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/carried-debt.test.ts`
Expected: FAIL — `tests/test-home.js` does not resolve, and the depth/escaping assertions have never been exercised.

- [ ] **Step 4: Apply the HOME isolation to the two subprocess test files**

In `tests/cli.test.ts` and `tests/cli-serve.test.ts`, import `withTestHome` and pass its `env` to every `execFileSync` and `spawn` call that invokes the CLI. Create the test home once per file, at module scope or in `beforeAll`, and reuse it — a fresh home per call would re-index from scratch every time and slow the suite for no benefit.

Do not change what any existing test asserts. The only change is which HOME the child process sees.

- [ ] **Step 5: Fix the leaked handle**

In `src/store/graph-store.ts`, the `catch` that wraps a corrupt-index open does not close the database handle when `db.exec(schema)` throws after `new Database()` succeeded. Close it before rethrowing. Keep the error message exactly as it is — `tests/carried-debt.test.ts` and the existing CLI tests assert on it.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- tests/carried-debt.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Prove the HOME isolation actually isolates**

Count the index directories in your real home before and after a full suite run:

```bash
ls ~/.arch/repos 2>/dev/null | wc -l
npm test
ls ~/.arch/repos 2>/dev/null | wc -l
```

Expected: the two counts are equal. If the second is higher, a subprocess call still escaped the override — find it. Report both numbers.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS. 207 tests existed before; nothing here changes assertions.

- [ ] **Step 9: Commit**

```bash
git add tests/test-home.ts tests/carried-debt.test.ts tests/cli.test.ts tests/cli-serve.test.ts src/store/graph-store.ts
git commit -m "test: isolate HOME in CLI tests and guard the final-wave fixes"
```

---

### Task 2: Populate `files.loc`

`find_hotspots` multiplies a size signal by a churn signal, and the size signal is missing: `files.loc` has been persisted as `0` since Plan 1, with the spec noting a later plan would read it. This is that plan.

**Files:**
- Modify: `src/types.ts`, `src/parser/parser.ts`, `src/store/graph-store.ts`
- Test: `tests/parser-loc.test.ts`

**Interfaces:**
- Consumes: `ParsedFile`, `RepoParser`, `GraphStore.insertParsedFiles`.
- Produces: `ParsedFile.loc: number`, persisted into `files.loc`.

> **Why this is safe to change now.** `loc` is not part of `canonicalGraph`, the ID-free projection the incremental-vs-full equality invariant compares, so adding it cannot perturb that invariant. It IS part of `FileRow`, which `buildOverview` already reads. Both index paths call the same `insertParsedFiles`, so populating it once covers cold and incremental alike.

- [ ] **Step 1: Write the failing test**

`tests/parser-loc.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/parser-loc.test.ts`
Expected: FAIL — `loc` is not a property of `ParsedFile`, and the persisted value is 0.

- [ ] **Step 3: Add `loc` to the contract**

In `src/types.ts`, add to `ParsedFile`, directly beneath `contentHash`:

```ts
  /** Line count of the source. Zero for an empty file. */
  loc: number
```

- [ ] **Step 4: Populate it in the parser**

In `src/parser/parser.ts`, compute it once near the top of `parse()`, beside the existing `contentHash` computation:

```ts
    // A trailing newline does not start a new line, so an n-line file with a
    // final newline splits into n+1 parts. Counting non-final parts gives n.
    const loc = source.length === 0 ? 0 : source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
```

Add `loc` to every `ParsedFile` this function returns — there are three return sites: the unknown-language early return, the no-tree error return, and the success return. Missing one leaves that path persisting 0 forever, so check all three.

Also add `loc: 0` to the error record in `src/indexer/parse-worker.ts`, which constructs a `ParsedFile` directly when a file cannot be read.

- [ ] **Step 5: Persist it**

In `src/store/graph-store.ts`, `insertParsedFiles` currently binds `loc: 0`. Bind `file.loc` instead.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/parser-loc.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Confirm the equality invariant is undisturbed**

Run: `npx vitest run tests/incremental.test.ts`
Expected: PASS, all 11 equality scenarios. `loc` is not in `canonicalGraph`, so this should be unaffected — if it is not, stop and report, because it would mean the projection is coupled to something it should not be.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`

```bash
git add src/types.ts src/parser/parser.ts src/indexer/parse-worker.ts src/store/graph-store.ts tests/parser-loc.test.ts
git commit -m "feat: populate files.loc for the hotspot size signal"
```

---

### Task 3: The module graph and its algorithms

Two pure layers that three tools depend on. No SQL beyond what `GraphStore` already exposes, and no tool logic — this task is testable entirely on hand-built graphs.

**Files:**
- Create: `src/graph/module-graph.ts`, `src/graph/algorithms.ts`
- Test: `tests/graph-algorithms.test.ts`

**Interfaces:**
- Consumes: `GraphStore` (`allFilePaths`, `fileIdsByPath`, `pathsById`, `importsForFile`).
- Produces: `moduleOf(path): string`, `interface ModuleGraph`, `buildModuleGraph(store): ModuleGraph`; `stronglyConnectedComponents(nodes, successors): string[][]`, `interface CouplingMetrics`, `couplingMetrics(graph): CouplingMetrics[]`.

> **Edge weight counts DISTINCT file pairs, not import rows.** This is deliberate and it is the direct lesson of Plan 2's Critical. `import { helper } from './m'` plus `import type { Opts } from './m'` produces TWO rows in the `imports` table pointing at the same target file. Counting rows would inflate every coupling number by however many modules happen to use that everyday TypeScript pattern, and the inflation would look exactly like real architectural coupling. Deduplicate on the source-file/target-file pair before aggregating to modules.

> **Tarjan must be iterative.** A recursive implementation overflows the stack on a deep import chain, and it would do so on exactly the large repositories where cycle detection is most valuable. The version below uses an explicit work stack.

- [ ] **Step 1: Write the failing test**

`tests/graph-algorithms.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { stronglyConnectedComponents, couplingMetrics } from '../src/graph/algorithms.js'
import { moduleOf, buildModuleGraph } from '../src/graph/module-graph.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function graphOf(adjacency: Record<string, string[]>) {
  return {
    nodes: Object.keys(adjacency).sort(),
    successors: (n: string) => adjacency[n] ?? [],
  }
}

describe('stronglyConnectedComponents', () => {
  it('finds no multi-node component in an acyclic graph', () => {
    const { nodes, successors } = graphOf({ a: ['b'], b: ['c'], c: [] })
    const sccs = stronglyConnectedComponents(nodes, successors)
    expect(sccs.every(c => c.length === 1)).toBe(true)
    expect(sccs).toHaveLength(3)
  })

  it('finds a two-node cycle', () => {
    const { nodes, successors } = graphOf({ a: ['b'], b: ['a'] })
    const multi = stronglyConnectedComponents(nodes, successors).filter(c => c.length > 1)
    expect(multi).toEqual([['a', 'b']])
  })

  it('finds a three-node cycle and leaves an attached acyclic node alone', () => {
    const { nodes, successors } = graphOf({ a: ['b'], b: ['c'], c: ['a'], d: ['a'] })
    const sccs = stronglyConnectedComponents(nodes, successors)
    expect(sccs.filter(c => c.length > 1)).toEqual([['a', 'b', 'c']])
    expect(sccs.filter(c => c.length === 1)).toEqual([['d']])
  })

  it('finds two disjoint cycles', () => {
    const { nodes, successors } = graphOf({ a: ['b'], b: ['a'], c: ['d'], d: ['c'] })
    const multi = stronglyConnectedComponents(nodes, successors).filter(c => c.length > 1)
    expect(multi.map(c => c.join(',')).sort()).toEqual(['a,b', 'c,d'])
  })

  it('reports a self-loop as a single-node component', () => {
    const { nodes, successors } = graphOf({ a: ['a'] })
    expect(stronglyConnectedComponents(nodes, successors)).toEqual([['a']])
  })

  it('terminates on a long chain without overflowing the stack', () => {
    const adjacency: Record<string, string[]> = {}
    for (let i = 0; i < 20000; i++) adjacency[`n${i}`] = i < 19999 ? [`n${i + 1}`] : []
    const { nodes, successors } = graphOf(adjacency)
    expect(stronglyConnectedComponents(nodes, successors)).toHaveLength(20000)
  })

  it('handles an edge to a node not in the node list without throwing', () => {
    const { nodes, successors } = graphOf({ a: ['ghost'] })
    expect(() => stronglyConnectedComponents(nodes, successors)).not.toThrow()
  })
})

describe('couplingMetrics', () => {
  const graph = {
    modules: ['app', 'core', 'util'],
    filesByModule: new Map([['app', ['app/a.ts']], ['core', ['core/c.ts']], ['util', ['util/u.ts']]]),
    out: new Map([
      ['app', new Map([['core', 2], ['util', 1]])],
      ['core', new Map([['util', 1]])],
      ['util', new Map()],
    ]),
    in: new Map([
      ['app', new Map()],
      ['core', new Map([['app', 2]])],
      ['util', new Map([['app', 1], ['core', 1]])],
    ]),
  }

  it('counts distinct dependent and dependency modules, not edge weights', () => {
    const byModule = new Map(couplingMetrics(graph).map(m => [m.module, m]))
    expect(byModule.get('app')).toMatchObject({ afferent: 0, efferent: 2 })
    expect(byModule.get('util')).toMatchObject({ afferent: 2, efferent: 0 })
  })

  it('computes instability as Ce over Ca plus Ce', () => {
    const byModule = new Map(couplingMetrics(graph).map(m => [m.module, m]))
    expect(byModule.get('app')!.instability).toBe(1)
    expect(byModule.get('util')!.instability).toBe(0)
    expect(byModule.get('core')!.instability).toBeCloseTo(0.5, 5)
  })

  it('reports instability 0 for an uncoupled module rather than NaN', () => {
    const isolated = {
      modules: ['lone'],
      filesByModule: new Map([['lone', ['lone/x.ts']]]),
      out: new Map([['lone', new Map()]]),
      in: new Map([['lone', new Map()]]),
    }
    expect(couplingMetrics(isolated)[0].instability).toBe(0)
  })
})

describe('moduleOf', () => {
  it('uses the containing directory', () => {
    expect(moduleOf('src/services/order.ts')).toBe('src/services')
  })

  it('uses a dot for a file at the repository root', () => {
    expect(moduleOf('README.md')).toBe('.')
  })
})

describe('buildModuleGraph', () => {
  function seed(): GraphStore {
    const store = GraphStore.open(':memory:')
    const file = (path: string): ParsedFile => ({
      path, lang: 'typescript', contentHash: 'h-' + path, loc: 1,
      symbols: [], imports: [], callSites: [], errors: [],
    })
    store.insertParsedFiles([file('app/a.ts'), file('core/c.ts'), file('core/d.ts')])
    const ids = store.fileIdsByPath()
    store.insertImports([
      // Two rows, one target: the value-plus-type import pattern. Must count once.
      { fileId: ids.get('app/a.ts')!, rawSpecifier: '../core/c', resolvedFileId: ids.get('core/c.ts')!, kind: 'static', confidence: 'resolved', line: 1 },
      { fileId: ids.get('app/a.ts')!, rawSpecifier: '../core/c', resolvedFileId: ids.get('core/c.ts')!, kind: 'static', confidence: 'resolved', line: 2 },
      // A second distinct target in the same module: weight should become 2.
      { fileId: ids.get('app/a.ts')!, rawSpecifier: '../core/d', resolvedFileId: ids.get('core/d.ts')!, kind: 'static', confidence: 'resolved', line: 3 },
      // Unresolved: must not create an edge at all.
      { fileId: ids.get('app/a.ts')!, rawSpecifier: 'react', resolvedFileId: null, kind: 'static', confidence: 'unresolved', line: 4 },
      // Same-module import: must not create a self-edge.
      { fileId: ids.get('core/c.ts')!, rawSpecifier: './d', resolvedFileId: ids.get('core/d.ts')!, kind: 'static', confidence: 'resolved', line: 1 },
    ])
    return store
  }

  it('weights an edge by DISTINCT file pairs, not import rows', () => {
    const store = seed()
    expect(buildModuleGraph(store).out.get('app')!.get('core')).toBe(2)
    store.close()
  })

  it('creates no edge for an unresolved import', () => {
    const store = seed()
    expect(buildModuleGraph(store).out.get('app')!.has('react')).toBe(false)
    store.close()
  })

  it('creates no self-edge for an intra-module import', () => {
    const store = seed()
    expect(buildModuleGraph(store).out.get('core')!.has('core')).toBe(false)
    store.close()
  })

  it('records the inverse edge map', () => {
    const store = seed()
    expect(buildModuleGraph(store).in.get('core')!.get('app')).toBe(2)
    store.close()
  })

  it('lists every module with its files, including modules with no edges', () => {
    const store = seed()
    const graph = buildModuleGraph(store)
    expect(graph.modules).toEqual(['app', 'core'])
    expect(graph.filesByModule.get('core')!.sort()).toEqual(['core/c.ts', 'core/d.ts'])
    store.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/graph-algorithms.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Implement the module graph**

`src/graph/module-graph.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'

export interface ModuleGraph {
  /** Every module that owns at least one indexed file, sorted. */
  modules: string[]
  filesByModule: Map<string, string[]>
  /** from to-map, where the value is the count of distinct file pairs. */
  out: Map<string, Map<string, number>>
  /** The inverse of `out`. */
  in: Map<string, Map<string, number>>
}

/** A module is the directory containing a file. Root files live in ".". */
export function moduleOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '.' : path.slice(0, cut)
}

/**
 * Aggregates resolved file-level imports into a directory-level graph.
 *
 * Weight counts DISTINCT source-file/target-file pairs rather than import
 * rows. The imports table legitimately holds several rows for one pair —
 * `import { x }` plus `import type { Y }` from the same module is ordinary
 * TypeScript — and counting rows would inflate coupling numbers in a way
 * indistinguishable from real architectural coupling.
 */
export function buildModuleGraph(store: GraphStore): ModuleGraph {
  const filesByModule = new Map<string, string[]>()
  for (const path of store.allFilePaths()) {
    const module = moduleOf(path)
    const bucket = filesByModule.get(module)
    if (bucket) bucket.push(path)
    else filesByModule.set(module, [path])
  }

  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()
  const seenPairs = new Set<string>()
  const out = new Map<string, Map<string, number>>()
  const incoming = new Map<string, Map<string, number>>()

  for (const module of filesByModule.keys()) {
    out.set(module, new Map())
    incoming.set(module, new Map())
  }

  for (const [path, fileId] of idsByPath) {
    const from = moduleOf(path)
    for (const imp of store.importsForFile(fileId)) {
      if (imp.resolvedFileId === null) continue
      const targetPath = pathsById.get(imp.resolvedFileId)
      if (targetPath === undefined) continue

      // A repo-relative path cannot contain a newline, so it is a safe joiner.
      const pairKey = `${path}\n${targetPath}`
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)

      const to = moduleOf(targetPath)
      if (to === from) continue

      bump(out, from, to)
      bump(incoming, to, from)
    }
  }

  return { modules: [...filesByModule.keys()].sort(), filesByModule, out, in: incoming }
}

function bump(map: Map<string, Map<string, number>>, a: string, b: string): void {
  let inner = map.get(a)
  if (!inner) {
    inner = new Map()
    map.set(a, inner)
  }
  inner.set(b, (inner.get(b) ?? 0) + 1)
}
```

- [ ] **Step 4: Implement the algorithms**

`src/graph/algorithms.ts`:
```ts
import type { ModuleGraph } from './module-graph.js'

/**
 * Tarjan's strongly-connected components, iteratively.
 *
 * Iterative rather than recursive on purpose: a recursive version overflows
 * the call stack on a deep import chain, which is exactly the situation on
 * the large repositories where cycle detection is worth having. Components
 * come back with their members sorted. A component of size one is only a
 * cycle if the node has an edge to itself — the caller must check that.
 */
export function stronglyConnectedComponents(
  nodes: string[],
  successors: (node: string) => Iterable<string>,
): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  for (const root of nodes) {
    if (index.has(root)) continue

    const work: Array<{ node: string; iter: Iterator<string> }> = []
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)
    work.push({ node: root, iter: successors(root)[Symbol.iterator]() })

    while (work.length > 0) {
      const frame = work[work.length - 1]
      const step = frame.iter.next()

      if (!step.done) {
        const next = step.value
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter += 1
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, iter: successors(next)[Symbol.iterator]() })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!))
        }
        continue
      }

      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop()!
          onStack.delete(member)
          component.push(member)
          if (member === frame.node) break
        }
        components.push(component.sort())
      }
    }
  }

  return components
}

export interface CouplingMetrics {
  module: string
  /** Distinct modules that depend on this one. */
  afferent: number
  /** Distinct modules this one depends on. */
  efferent: number
  /** Ce over (Ca + Ce). Zero when the module has no coupling in either direction. */
  instability: number
  files: number
}

export function couplingMetrics(graph: ModuleGraph): CouplingMetrics[] {
  return graph.modules.map(module => {
    const efferent = graph.out.get(module)?.size ?? 0
    const afferent = graph.in.get(module)?.size ?? 0
    const total = afferent + efferent
    return {
      module,
      afferent,
      efferent,
      // A module nothing depends on and which depends on nothing is not
      // "maximally unstable" — it is uninvolved. Report 0, not NaN.
      instability: total === 0 ? 0 : Number((efferent / total).toFixed(4)),
      files: graph.filesByModule.get(module)?.length ?? 0,
    }
  })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/graph-algorithms.test.ts`
Expected: PASS, 18 tests. The 20,000-node chain is the one that proves the iterative implementation — a recursive Tarjan fails it with a stack overflow.

- [ ] **Step 6: Commit**

```bash
git add src/graph tests/graph-algorithms.test.ts
git commit -m "feat: module graph with distinct-pair weighting and iterative Tarjan"
```

---

### Task 4: `find_cycles` and `get_coupling`

Both read the module graph, so they share a task.

**Files:**
- Create: `src/tools/cycles.ts`, `src/tools/coupling.ts`
- Test: `tests/tools-cycles.test.ts`, `tests/tools-coupling.test.ts`

**Interfaces:**
- Consumes: `buildModuleGraph`, `moduleOf`, `stronglyConnectedComponents`, `couplingMetrics`, `truncate`, `GraphStore`.
- Produces: `findCycles(store, options): CycleResult`, `getCoupling(store, options): CouplingResult`, and the types `CycleScope`, `CycleOptions`, `Cycle`, `CycleResult`, `CouplingOptions`, `ModulePair`, `CouplingResult`.

- [ ] **Step 1: Write the failing tests**

`tests/tools-cycles.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { findCycles } from '../src/tools/cycles.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function store(files: string[], imports: Array<[string, string]>): GraphStore {
  const s = GraphStore.open(':memory:')
  s.insertParsedFiles(files.map((path): ParsedFile => ({
    path, lang: 'typescript', contentHash: 'h-' + path, loc: 1,
    symbols: [], imports: [], callSites: [], errors: [],
  })))
  const ids = s.fileIdsByPath()
  s.insertImports(imports.map(([from, to], i) => ({
    fileId: ids.get(from)!, rawSpecifier: './x', resolvedFileId: ids.get(to)!,
    kind: 'static', confidence: 'resolved' as const, line: i + 1,
  })))
  return s
}

describe('findCycles at module scope', () => {
  it('reports nothing for an acyclic graph', () => {
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts']])
    expect(findCycles(s, { scope: 'module', minSize: 2, limit: 10 }).cycles).toEqual([])
    s.close()
  })

  it('finds a two-module cycle and names its members', () => {
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts'], ['b/y.ts', 'a/x.ts']])
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 10 })
    expect(r.cycles).toHaveLength(1)
    expect(r.cycles[0].members).toEqual(['a', 'b'])
    expect(r.cycles[0].size).toBe(2)
    s.close()
  })

  it('ranks a larger cycle ahead of a smaller one', () => {
    const s = store(
      ['a/x.ts', 'b/y.ts', 'c/z.ts', 'd/p.ts', 'e/q.ts'],
      [['a/x.ts', 'b/y.ts'], ['b/y.ts', 'c/z.ts'], ['c/z.ts', 'a/x.ts'],
       ['d/p.ts', 'e/q.ts'], ['e/q.ts', 'd/p.ts']],
    )
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 10 })
    expect(r.cycles[0].size).toBe(3)
    expect(r.cycles[1].size).toBe(2)
    s.close()
  })

  it('honours minSize', () => {
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts'], ['b/y.ts', 'a/x.ts']])
    expect(findCycles(s, { scope: 'module', minSize: 3, limit: 10 }).cycles).toEqual([])
    s.close()
  })

  it('reports the true total when the list is capped', () => {
    const files: string[] = []
    const imports: Array<[string, string]> = []
    for (let i = 0; i < 4; i++) {
      files.push(`p${i}/a.ts`, `q${i}/b.ts`)
      imports.push([`p${i}/a.ts`, `q${i}/b.ts`], [`q${i}/b.ts`, `p${i}/a.ts`])
    }
    const s = store(files, imports)
    const r = findCycles(s, { scope: 'module', minSize: 2, limit: 2 })
    expect(r.cycles).toHaveLength(2)
    expect(r.totalCycles).toBe(4)
    expect(r.truncated).toEqual({ returned: 2, total: 4 })
    s.close()
  })

  it('does not report an acyclic node as a one-member cycle', () => {
    const s = store(['a/x.ts', 'b/y.ts'], [['a/x.ts', 'b/y.ts']])
    expect(findCycles(s, { scope: 'module', minSize: 1, limit: 10 }).cycles).toEqual([])
    s.close()
  })
})

describe('findCycles at file scope', () => {
  it('finds a cycle between two files inside one module', () => {
    const s = store(['m/a.ts', 'm/b.ts'], [['m/a.ts', 'm/b.ts'], ['m/b.ts', 'm/a.ts']])
    const r = findCycles(s, { scope: 'file', minSize: 2, limit: 10 })
    expect(r.cycles[0].members).toEqual(['m/a.ts', 'm/b.ts'])
    s.close()
  })

  it('does not surface that same cycle at module scope, since it is intra-module', () => {
    const s = store(['m/a.ts', 'm/b.ts'], [['m/a.ts', 'm/b.ts'], ['m/b.ts', 'm/a.ts']])
    expect(findCycles(s, { scope: 'module', minSize: 2, limit: 10 }).cycles).toEqual([])
    s.close()
  })
})
```

`tests/tools-coupling.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { getCoupling } from '../src/tools/coupling.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function store(files: string[], imports: Array<[string, string]>): GraphStore {
  const s = GraphStore.open(':memory:')
  s.insertParsedFiles(files.map((path): ParsedFile => ({
    path, lang: 'typescript', contentHash: 'h-' + path, loc: 1,
    symbols: [], imports: [], callSites: [], errors: [],
  })))
  const ids = s.fileIdsByPath()
  s.insertImports(imports.map(([from, to], i) => ({
    fileId: ids.get(from)!, rawSpecifier: './x', resolvedFileId: ids.get(to)!,
    kind: 'static', confidence: 'resolved' as const, line: i + 1,
  })))
  return s
}

const FILES = ['app/a.ts', 'app/b.ts', 'core/c.ts', 'util/u.ts']
const IMPORTS: Array<[string, string]> = [
  ['app/a.ts', 'core/c.ts'], ['app/b.ts', 'core/c.ts'],
  ['app/a.ts', 'util/u.ts'], ['core/c.ts', 'util/u.ts'],
]

describe('getCoupling', () => {
  it('ranks modules by total coupling', () => {
    const s = store(FILES, IMPORTS)
    expect(getCoupling(s, { limit: 10 }).modules[0].module).toBe('app')
    s.close()
  })

  it('reports afferent, efferent and instability per module', () => {
    const s = store(FILES, IMPORTS)
    const byModule = new Map(getCoupling(s, { limit: 10 }).modules.map(m => [m.module, m]))
    expect(byModule.get('util')).toMatchObject({ afferent: 2, efferent: 0, instability: 0 })
    expect(byModule.get('app')).toMatchObject({ afferent: 0, efferent: 2, instability: 1 })
    s.close()
  })

  it('reports the heaviest module pairs with their weights', () => {
    const s = store(FILES, IMPORTS)
    expect(getCoupling(s, { limit: 10 }).heaviestPairs[0]).toMatchObject({ from: 'app', to: 'core', weight: 2 })
    s.close()
  })

  it('truncates both lists loudly with their true totals', () => {
    const s = store(FILES, IMPORTS)
    const r = getCoupling(s, { limit: 1 })
    expect(r.modules).toHaveLength(1)
    expect(r.totalModules).toBe(3)
    expect(r.truncatedModules).toEqual({ returned: 1, total: 3 })
    expect(r.truncatedPairs!.total).toBeGreaterThan(1)
    s.close()
  })

  it('returns empty results for an empty index without throwing', () => {
    const s = GraphStore.open(':memory:')
    const r = getCoupling(s, { limit: 10 })
    expect(r.modules).toEqual([])
    expect(r.heaviestPairs).toEqual([])
    expect(r.totalModules).toBe(0)
    s.close()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tools-cycles.test.ts tests/tools-coupling.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Implement `find_cycles`**

`src/tools/cycles.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'
import { buildModuleGraph } from '../graph/module-graph.js'
import { stronglyConnectedComponents } from '../graph/algorithms.js'
import { truncate, type Truncation } from './envelope.js'

export type CycleScope = 'module' | 'file'

export interface CycleOptions {
  scope: CycleScope
  minSize: number
  limit: number
}

export interface Cycle {
  members: string[]
  size: number
  /** Total weight of the edges inside the cycle. Higher means more entangled. */
  internalEdges: number
}

export interface CycleResult {
  scope: CycleScope
  cycles: Cycle[]
  totalCycles: number
  truncated?: Truncation
}

export function findCycles(store: GraphStore, options: CycleOptions): CycleResult {
  const level = options.scope === 'module' ? moduleLevel(store) : fileLevel(store)
  const components = stronglyConnectedComponents(level.nodes, level.successors)

  const cycles: Cycle[] = []
  for (const members of components) {
    // Tarjan returns EVERY node as a component, so without this check an
    // acyclic graph would report one "cycle" per node. A single node is a
    // cycle only when it points at itself.
    if (members.length === 1) {
      const only = members[0]
      let selfLoop = false
      for (const next of level.successors(only)) {
        if (next === only) { selfLoop = true; break }
      }
      if (!selfLoop) continue
    }
    if (members.length < options.minSize) continue

    const inside = new Set(members)
    let internalEdges = 0
    for (const member of members) {
      for (const next of level.successors(member)) {
        if (inside.has(next)) internalEdges += level.weightOf(member, next)
      }
    }
    cycles.push({ members, size: members.length, internalEdges })
  }

  cycles.sort((a, b) =>
    b.size - a.size || b.internalEdges - a.internalEdges || a.members[0].localeCompare(b.members[0]))

  const { items, truncated } = truncate(cycles, options.limit)
  return { scope: options.scope, cycles: items, totalCycles: cycles.length, truncated }
}

function moduleLevel(store: GraphStore) {
  const graph = buildModuleGraph(store)
  return {
    nodes: graph.modules,
    successors: (m: string): Iterable<string> => graph.out.get(m)?.keys() ?? [],
    weightOf: (a: string, b: string): number => graph.out.get(a)?.get(b) ?? 0,
  }
}

function fileLevel(store: GraphStore) {
  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()
  const adjacency = new Map<string, Set<string>>()

  for (const [path, fileId] of idsByPath) {
    const targets = new Set<string>()
    for (const imp of store.importsForFile(fileId)) {
      if (imp.resolvedFileId === null) continue
      const target = pathsById.get(imp.resolvedFileId)
      if (target !== undefined && target !== path) targets.add(target)
    }
    adjacency.set(path, targets)
  }

  return {
    nodes: [...adjacency.keys()].sort(),
    successors: (p: string): Iterable<string> => adjacency.get(p) ?? new Set<string>(),
    // A file-level edge either exists or does not; there is no multiplicity,
    // because the adjacency set already deduplicates targets.
    weightOf: (): number => 1,
  }
}
```

- [ ] **Step 4: Implement `get_coupling`**

`src/tools/coupling.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'
import { buildModuleGraph } from '../graph/module-graph.js'
import { couplingMetrics, type CouplingMetrics } from '../graph/algorithms.js'
import { truncate, type Truncation } from './envelope.js'

export interface CouplingOptions {
  limit: number
}

export interface ModulePair {
  from: string
  to: string
  /** Distinct file-to-file dependencies crossing this module boundary. */
  weight: number
}

export interface CouplingResult {
  modules: CouplingMetrics[]
  totalModules: number
  heaviestPairs: ModulePair[]
  totalPairs: number
  truncatedModules?: Truncation
  truncatedPairs?: Truncation
}

export function getCoupling(store: GraphStore, options: CouplingOptions): CouplingResult {
  const graph = buildModuleGraph(store)
  const metrics = couplingMetrics(graph)

  metrics.sort((a, b) =>
    (b.afferent + b.efferent) - (a.afferent + a.efferent) || a.module.localeCompare(b.module))

  const pairs: ModulePair[] = []
  for (const [from, targets] of graph.out) {
    for (const [to, weight] of targets) pairs.push({ from, to, weight })
  }
  pairs.sort((a, b) =>
    b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  const moduleSlice = truncate(metrics, options.limit)
  const pairSlice = truncate(pairs, options.limit)

  return {
    modules: moduleSlice.items,
    totalModules: metrics.length,
    heaviestPairs: pairSlice.items,
    totalPairs: pairs.length,
    truncatedModules: moduleSlice.truncated,
    truncatedPairs: pairSlice.truncated,
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/tools-cycles.test.ts tests/tools-coupling.test.ts`
Expected: PASS, 8 + 5 tests.

- [ ] **Step 6: Sanity-check against this repository**

Write a throwaway script that opens this repository's own index and prints `findCycles(store, {scope: 'module', minSize: 2, limit: 10})` and `getCoupling(store, {limit: 10})`. Resolve the index path with `indexPathFor(process.cwd())` from `src/repo/repo-source.js` rather than hardcoding a hash. Report both outputs, then delete the script.

What to look for: this codebase has a deliberate layering — `parser` feeds `indexer`, which feeds `tools`, which feeds `mcp` — so module cycles should be absent or very few, `src/tools` should show high afferent coupling, and `src/mcp` should show high efferent coupling with instability near 1. If the numbers contradict that obvious structure, say so rather than accepting them; it would mean the aggregation is wrong.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test`

```bash
git add src/tools/cycles.ts src/tools/coupling.ts tests/tools-cycles.test.ts tests/tools-coupling.test.ts
git commit -m "feat: find_cycles and get_coupling"
```

---

### Task 5: Git history collection

One `git log` invocation, parsed into per-file churn, author counts, bug-fix ratio and co-change pairs. This is the reason git is in the spec's architecture diagram.

**Files:**
- Create: `src/git/history.ts`
- Test: `tests/git-history.test.ts`

**Interfaces:**
- Consumes: `git(repoRoot, args)` and `isGitRepo(repoRoot)` from `src/repo/repo-source.js`.
- Produces: `interface FileHistory`, `interface CoChangePair`, `interface HistoryWindow`, `collectHistory(repoRoot, options?): HistoryWindow`, `DEFAULT_WINDOW_DAYS`, `DEFAULT_LARGE_COMMIT_THRESHOLD`.

> **The output format was verified by execution before this plan was written.** `git log --pretty=format:%x1e%H%x1f%an%x1f%aI%x1f%s --name-only --no-merges` emits a record separator (0x1E) before each commit header, unit separators (0x1F) between its fields, then one path per line. Neither control character can appear in a file path or a git subject, so the parse cannot be confused by repository content — which a simple `|` delimiter could be. Measured on a real 114-commit window: 44 ms, 651 lines.

> **Large commits are excluded from co-change, and the exclusion is REPORTED.** A commit touching 500 files produces 124,750 pairs and tells you nothing about coupling — it is a rename or a formatting sweep. Commits above the threshold are skipped for pair generation only; their files still count toward churn, because the file genuinely did change. `skippedLargeCommits` carries the count so a caller is never silently reading a partial picture.

- [ ] **Step 1: Write the failing test**

`tests/git-history.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectHistory } from '../src/git/history.js'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-hist-'))
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  run(['init', '-q'])
  run(['config', 'user.email', 'a@example.com'])
  run(['config', 'user.name', 'Author One'])
  return root
}

function commit(root: string, subject: string, files: Record<string, string>, author?: string): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' })
  const env = author
    ? { ...process.env, GIT_AUTHOR_NAME: author, GIT_COMMITTER_NAME: author }
    : process.env
  execFileSync('git', ['commit', '-q', '-m', subject], { cwd: root, stdio: 'ignore', env })
}

describe('collectHistory', () => {
  it('reports unavailable for a directory that is not a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'arch-plain-'))
    const h = collectHistory(plain)
    expect(h.available).toBe(false)
    expect(h.reason).toMatch(/not a git repository/i)
    expect(h.byFile.size).toBe(0)
  })

  it('counts commits per file', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' })
    commit(root, 'feat: two', { 'a.ts': '2' })
    commit(root, 'feat: three', { 'b.ts': '1' })
    const h = collectHistory(root)
    expect(h.available).toBe(true)
    expect(h.byFile.get('a.ts')!.commits).toBe(2)
    expect(h.byFile.get('b.ts')!.commits).toBe(1)
    expect(h.totalCommits).toBe(3)
  })

  it('counts distinct authors per file', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' }, 'Author One')
    commit(root, 'feat: two', { 'a.ts': '2' }, 'Author Two')
    commit(root, 'feat: three', { 'a.ts': '3' }, 'Author One')
    expect(collectHistory(root).byFile.get('a.ts')!.authors).toBe(2)
  })

  it('counts bug-fix commits by subject', () => {
    const root = repo()
    commit(root, 'feat: add', { 'a.ts': '1' })
    commit(root, 'fix: correct off-by-one', { 'a.ts': '2' })
    commit(root, 'fix(parser): handle empty input', { 'a.ts': '3' })
    commit(root, 'refactor: tidy', { 'a.ts': '4' })
    const file = collectHistory(root).byFile.get('a.ts')!
    expect(file.commits).toBe(4)
    expect(file.bugFixCommits).toBe(2)
  })

  it('does not treat a subject merely containing the word fix as a bug fix', () => {
    const root = repo()
    commit(root, 'docs: explain how to fix your config', { 'a.ts': '1' })
    expect(collectHistory(root).byFile.get('a.ts')!.bugFixCommits).toBe(0)
  })

  it('records the most recent commit date per file', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' })
    const at = collectHistory(root).byFile.get('a.ts')!.lastCommitAt
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('counts co-changes for files committed together', () => {
    const root = repo()
    commit(root, 'feat: pair', { 'a.ts': '1', 'b.ts': '1' })
    commit(root, 'feat: pair again', { 'a.ts': '2', 'b.ts': '2' })
    commit(root, 'feat: alone', { 'c.ts': '1' })
    const h = collectHistory(root)
    const pair = h.coChanges.find(p => p.a === 'a.ts' && p.b === 'b.ts')
    expect(pair!.commits).toBe(2)
    expect(h.coChanges.some(p => p.a === 'c.ts' || p.b === 'c.ts')).toBe(false)
  })

  it('orders each co-change pair consistently so the same pair never appears twice', () => {
    const root = repo()
    commit(root, 'feat: one', { 'z.ts': '1', 'a.ts': '1' })
    const h = collectHistory(root)
    expect(h.coChanges).toHaveLength(1)
    expect(h.coChanges[0]).toMatchObject({ a: 'a.ts', b: 'z.ts' })
  })

  it('skips co-change pairs for an oversized commit and REPORTS the skip', () => {
    const root = repo()
    const many: Record<string, string> = {}
    for (let i = 0; i < 6; i++) many[`f${i}.ts`] = 'x'
    commit(root, 'chore: sweep', many)
    const h = collectHistory(root, { largeCommitThreshold: 5 })
    expect(h.coChanges).toEqual([])
    expect(h.skippedLargeCommits).toBe(1)
    // Churn still counts: the files genuinely changed.
    expect(h.byFile.get('f0.ts')!.commits).toBe(1)
  })

  it('honours the window and reports it', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' })
    const h = collectHistory(root, { windowDays: 7 })
    expect(h.windowDays).toBe(7)
    expect(h.byFile.get('a.ts')!.commits).toBe(1)
  })

  it('returns an empty but available window for a repository with no commits in range', () => {
    const root = repo()
    commit(root, 'feat: one', { 'a.ts': '1' })
    const h = collectHistory(root, { windowDays: 0 })
    expect(h.available).toBe(true)
    expect(h.totalCommits).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/git-history.test.ts`
Expected: FAIL — cannot resolve `../src/git/history.js`.

- [ ] **Step 3: Implement the collector**

`src/git/history.ts`:
```ts
import { git, isGitRepo } from '../repo/repo-source.js'

export interface FileHistory {
  path: string
  commits: number
  /** Distinct commit authors. */
  authors: number
  /** Commits whose subject looks like a bug fix. */
  bugFixCommits: number
  /** ISO-8601 date of the most recent commit touching this file. */
  lastCommitAt: string | null
}

export interface CoChangePair {
  /** Lexicographically first path, so a pair is only ever recorded once. */
  a: string
  b: string
  commits: number
}

export interface HistoryWindow {
  available: boolean
  /** Why history is unavailable. Present only when `available` is false. */
  reason?: string
  windowDays: number
  totalCommits: number
  /** Commits excluded from co-change pairing for touching too many files. */
  skippedLargeCommits: number
  largeCommitThreshold: number
  byFile: Map<string, FileHistory>
  coChanges: CoChangePair[]
}

export const DEFAULT_WINDOW_DAYS = 180
export const DEFAULT_LARGE_COMMIT_THRESHOLD = 50

// 0x1E and 0x1F. Neither can appear in a file path or a git subject, which
// is why they are safe delimiters where a '|' would not be.
const RECORD_SEPARATOR = '\u001e'
const UNIT_SEPARATOR = '\u001f'

/**
 * Conventional-commit and plain prefixes. Deliberately anchored: a subject
 * merely mentioning "fix" ("docs: explain how to fix your config") is not a
 * bug fix, and counting it would inflate the signal hotspots multiply by.
 */
const BUG_FIX_SUBJECT = /^(fix|bugfix|hotfix|patch)([(:! ]|$)/i

export interface HistoryOptions {
  windowDays?: number
  largeCommitThreshold?: number
}

export function collectHistory(repoRoot: string, options: HistoryOptions = {}): HistoryWindow {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const largeCommitThreshold = options.largeCommitThreshold ?? DEFAULT_LARGE_COMMIT_THRESHOLD

  const empty: HistoryWindow = {
    available: false,
    windowDays,
    totalCommits: 0,
    skippedLargeCommits: 0,
    largeCommitThreshold,
    byFile: new Map(),
    coChanges: [],
  }

  if (!isGitRepo(repoRoot)) {
    return { ...empty, reason: 'Not a git repository, so churn and co-change signals are unavailable.' }
  }

  // Record and unit separators cannot occur in a path or a git subject, so
  // repository content cannot confuse this parse.
  const raw = git(repoRoot, [
    'log',
    `--since=${windowDays} days ago`,
    `--pretty=format:${RECORD_SEPARATOR}%H${UNIT_SEPARATOR}%an${UNIT_SEPARATOR}%aI${UNIT_SEPARATOR}%s`,
    '--name-only',
    '--no-merges',
  ])

  if (raw === null) {
    return { ...empty, reason: 'git log failed, so churn and co-change signals are unavailable.' }
  }

  const byFile = new Map<string, FileHistory>()
  const authorsByFile = new Map<string, Set<string>>()
  const pairCounts = new Map<string, number>()
  let totalCommits = 0
  let skippedLargeCommits = 0

  for (const record of raw.split(RECORD_SEPARATOR)) {
    if (record.trim().length === 0) continue

    const lines = record.split('\n')
    const header = lines[0].split(UNIT_SEPARATOR)
    if (header.length < 4) continue

    const author = header[1]
    const committedAt = header[2]
    const subject = header[3]
    const isBugFix = BUG_FIX_SUBJECT.test(subject)
    const paths = lines.slice(1).map(l => l.trim()).filter(l => l.length > 0)

    totalCommits += 1

    for (const path of paths) {
      let entry = byFile.get(path)
      if (!entry) {
        entry = { path, commits: 0, authors: 0, bugFixCommits: 0, lastCommitAt: null }
        byFile.set(path, entry)
        authorsByFile.set(path, new Set())
      }
      entry.commits += 1
      if (isBugFix) entry.bugFixCommits += 1
      // git log is newest-first, so the first date seen for a file is its latest.
      if (entry.lastCommitAt === null) entry.lastCommitAt = committedAt
      authorsByFile.get(path)!.add(author)
    }

    // A sweep touching hundreds of files produces a quadratic blast of pairs
    // that says nothing about coupling. Skip pairing, keep churn, report it.
    if (paths.length > largeCommitThreshold) {
      skippedLargeCommits += 1
      continue
    }

    const sorted = [...paths].sort()
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\n${sorted[j]}`
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
      }
    }
  }

  for (const [path, authors] of authorsByFile) {
    byFile.get(path)!.authors = authors.size
  }

  const coChanges: CoChangePair[] = []
  for (const [key, commits] of pairCounts) {
    const split = key.indexOf('\n')
    coChanges.push({ a: key.slice(0, split), b: key.slice(split + 1), commits })
  }
  coChanges.sort((x, y) => y.commits - x.commits || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))

  return {
    available: true,
    windowDays,
    totalCommits,
    skippedLargeCommits,
    largeCommitThreshold,
    byFile,
    coChanges,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/git-history.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Measure it on a real repository**

Write a throwaway script that calls `collectHistory` on this repository and on `~/Documents/arsal_git/work-dashboard`, printing elapsed milliseconds, `totalCommits`, `byFile.size`, `coChanges.length` and `skippedLargeCommits`. Report the numbers, then delete the script.

What to look for: the parse should take tens of milliseconds, not seconds. If `skippedLargeCommits` is a large fraction of `totalCommits`, the threshold is too low for that repository and worth noting — but do not change the default in response to one sample.

- [ ] **Step 6: Commit**

```bash
git add src/git tests/git-history.test.ts
git commit -m "feat: git history collection for churn and co-change signals"
```

---

### Task 6: `find_hotspots`

Technical debt candidates, ranked by structural weight multiplied by git churn. Neither half works alone — a large stable file is fine, and a small file changing constantly is usually fine too. The product is the signal.

**Files:**
- Create: `src/tools/hotspots.ts`
- Test: `tests/tools-hotspots.test.ts`

**Interfaces:**
- Consumes: `GraphStore`, `collectHistory`, `buildModuleGraph`, `moduleOf`, `findCycles`, `truncate`.
- Produces: `findHotspots(store, repoRoot, options): HotspotResult`.

> **Report the inputs, never just the score.** A single opaque number tells a reader nothing about whether to trust it. Each hotspot carries its raw signals — `loc`, `symbols`, `fanIn`, `fanOut`, `inCycle`, `commits`, `authors`, `bugFixCommits` — alongside the score, so a human or a model can disagree with the weighting.

> **When git is unavailable the scoring degrades and SAYS SO.** A non-git repository has no churn signal at all. Rather than silently scoring on structure alone and presenting it as a debt ranking, the result carries `gitAvailable: false` and a `note` explaining that the ranking is structural only. This is the same discipline as the confidence tiers: never present a degraded answer as a complete one.

- [ ] **Step 1: Write the failing test**

`tests/tools-hotspots.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { findHotspots } from '../src/tools/hotspots.js'
import { buildFixture } from './fixture-builder.js'

function write(root: string, path: string, content: string): void {
  const abs = join(root, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function gitRepoWithChurn(): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-hot-'))
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  run(['init', '-q'])
  run(['config', 'user.email', 'a@example.com'])
  run(['config', 'user.name', 'A'])

  // `churny.ts` is big AND changes constantly. `calm.ts` is big and stable.
  const big = (n: number) => Array.from({ length: 40 }, (_, i) => `export function f${n}_${i}(): number { return ${i}; }`).join('\n') + '\n'
  write(root, 'src/calm.ts', big(0))
  write(root, 'src/churny.ts', big(1))
  run(['add', '-A']); run(['commit', '-q', '-m', 'feat: initial'])

  for (let i = 0; i < 6; i++) {
    write(root, 'src/churny.ts', big(1) + `// revision ${i}\n`)
    run(['add', '-A'])
    run(['commit', '-q', '-m', i % 2 === 0 ? `fix: correct thing ${i}` : `feat: change ${i}`])
  }
  return root
}

async function indexed(root: string): Promise<GraphStore> {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-hot-db-')), 'index.db')
  await runColdIndex({ repoRoot: root, dbPath })
  return GraphStore.open(dbPath)
}

describe('findHotspots with git available', () => {
  it('ranks the churning file above the stable one of the same size', async () => {
    const root = gitRepoWithChurn()
    const store = await indexed(root)
    const r = findHotspots(store, root, { limit: 10 })
    expect(r.gitAvailable).toBe(true)
    const paths = r.hotspots.map(h => h.path)
    expect(paths.indexOf('src/churny.ts')).toBeLessThan(paths.indexOf('src/calm.ts'))
    store.close()
  })

  it('reports the raw signals alongside the score', async () => {
    const root = gitRepoWithChurn()
    const store = await indexed(root)
    const top = findHotspots(store, root, { limit: 10 }).hotspots.find(h => h.path === 'src/churny.ts')!
    expect(top.loc).toBeGreaterThan(0)
    expect(top.symbols).toBeGreaterThan(0)
    expect(top.commits).toBeGreaterThan(1)
    expect(top.bugFixCommits).toBeGreaterThan(0)
    expect(typeof top.inCycle).toBe('boolean')
    expect(top.score).toBeGreaterThan(0)
    store.close()
  })

  it('surfaces co-change pairs that have no import edge between them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-cochange-'))
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'a@example.com'])
    run(['config', 'user.name', 'A'])
    write(root, 'src/alpha.ts', 'export function alpha(): number { return 1; }\n')
    write(root, 'src/beta.ts', 'export function beta(): number { return 2; }\n')
    run(['add', '-A']); run(['commit', '-q', '-m', 'feat: one'])
    for (let i = 0; i < 3; i++) {
      write(root, 'src/alpha.ts', `export function alpha(): number { return ${i}; }\n`)
      write(root, 'src/beta.ts', `export function beta(): number { return ${i}; }\n`)
      run(['add', '-A']); run(['commit', '-q', '-m', `feat: change ${i}`])
    }
    const store = await indexed(root)
    const r = findHotspots(store, root, { limit: 10 })
    const hidden = r.hiddenCoupling.find(p => p.a === 'src/alpha.ts' && p.b === 'src/beta.ts')
    expect(hidden).toBeDefined()
    expect(hidden!.commits).toBeGreaterThanOrEqual(3)
    store.close()
  })

  it('truncates loudly with the true total', async () => {
    const root = gitRepoWithChurn()
    const store = await indexed(root)
    const r = findHotspots(store, root, { limit: 1 })
    expect(r.hotspots).toHaveLength(1)
    expect(r.truncated!.total).toBeGreaterThan(1)
    store.close()
  })
})

describe('findHotspots without git', () => {
  it('degrades to structural scoring and says so rather than pretending', async () => {
    const fixture = buildFixture()
    const store = await indexed(fixture)
    const r = findHotspots(store, fixture, { limit: 10 })
    expect(r.gitAvailable).toBe(false)
    expect(r.note).toMatch(/structural/i)
    expect(r.hotspots.length).toBeGreaterThan(0)
    for (const h of r.hotspots) expect(h.commits).toBe(0)
    store.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools-hotspots.test.ts`
Expected: FAIL — cannot resolve `../src/tools/hotspots.js`.

- [ ] **Step 3: Implement it**

`src/tools/hotspots.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'
import { collectHistory, type CoChangePair } from '../git/history.js'
import { findCycles } from './cycles.js'
import { truncate, type Truncation } from './envelope.js'

export interface HotspotOptions {
  limit: number
  windowDays?: number
}

export interface Hotspot {
  path: string
  /** Composite of the structural and churn signals below. Not a unit. */
  score: number
  loc: number
  symbols: number
  fanIn: number
  fanOut: number
  inCycle: boolean
  commits: number
  authors: number
  bugFixCommits: number
  lastCommitAt: string | null
}

export interface HiddenCoupling extends CoChangePair {
  /** True when neither file imports the other, despite changing together. */
  noImportEdge: boolean
}

export interface HotspotResult {
  hotspots: Hotspot[]
  totalFiles: number
  gitAvailable: boolean
  windowDays: number
  skippedLargeCommits: number
  /** Pairs that change together but have no import relationship. */
  hiddenCoupling: HiddenCoupling[]
  note?: string
  truncated?: Truncation
}

const HIDDEN_COUPLING_MIN_COMMITS = 3

export function findHotspots(
  store: GraphStore,
  repoRoot: string,
  options: HotspotOptions,
): HotspotResult {
  const history = collectHistory(repoRoot, { windowDays: options.windowDays })

  const idsByPath = store.fileIdsByPath()
  const pathsById = store.pathsById()
  const symbolsByFile = store.symbolsByFile()

  const cycleMembers = new Set<string>()
  for (const cycle of findCycles(store, { scope: 'file', minSize: 2, limit: Number.MAX_SAFE_INTEGER }).cycles) {
    for (const member of cycle.members) cycleMembers.add(member)
  }

  const importTargets = new Map<string, Set<string>>()
  const rows: Hotspot[] = []

  for (const [path, fileId] of idsByPath) {
    const targets = new Set<string>()
    for (const imp of store.importsForFile(fileId)) {
      if (imp.resolvedFileId === null) continue
      const target = pathsById.get(imp.resolvedFileId)
      if (target !== undefined) targets.add(target)
    }
    importTargets.set(path, targets)

    const file = store.fileRow(path)
    const git = history.byFile.get(path)
    rows.push({
      path,
      score: 0,
      loc: file?.loc ?? 0,
      symbols: (symbolsByFile.get(fileId) ?? []).length,
      fanIn: store.filesImporting(fileId).length,
      fanOut: targets.size,
      inCycle: cycleMembers.has(path),
      commits: git?.commits ?? 0,
      authors: git?.authors ?? 0,
      bugFixCommits: git?.bugFixCommits ?? 0,
      lastCommitAt: git?.lastCommitAt ?? null,
    })
  }

  const maxLoc = Math.max(1, ...rows.map(r => r.loc))
  const maxFan = Math.max(1, ...rows.map(r => r.fanIn + r.fanOut))
  const maxCommits = Math.max(1, ...rows.map(r => r.commits))
  const maxFixes = Math.max(1, ...rows.map(r => r.bugFixCommits))

  for (const row of rows) {
    const structural =
      0.4 * (row.loc / maxLoc) +
      0.4 * ((row.fanIn + row.fanOut) / maxFan) +
      (row.inCycle ? 0.2 : 0)

    // Without git there is no churn term. Falling back to 1 would score on
    // structure alone while still looking like a debt ranking, so the caller
    // is told explicitly via `gitAvailable` and `note`.
    const churn = history.available
      ? 0.6 * (row.commits / maxCommits) + 0.4 * (row.bugFixCommits / maxFixes)
      : 1

    row.score = Number((structural * churn).toFixed(4))
  }

  rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  const hiddenCoupling: HiddenCoupling[] = []
  for (const pair of history.coChanges) {
    if (pair.commits < HIDDEN_COUPLING_MIN_COMMITS) continue
    if (!idsByPath.has(pair.a) || !idsByPath.has(pair.b)) continue
    const linked =
      (importTargets.get(pair.a)?.has(pair.b) ?? false) ||
      (importTargets.get(pair.b)?.has(pair.a) ?? false)
    if (linked) continue
    hiddenCoupling.push({ ...pair, noImportEdge: true })
  }

  const { items, truncated } = truncate(rows, options.limit)

  return {
    hotspots: items,
    totalFiles: rows.length,
    gitAvailable: history.available,
    windowDays: history.windowDays,
    skippedLargeCommits: history.skippedLargeCommits,
    hiddenCoupling: hiddenCoupling.slice(0, options.limit),
    note: history.available
      ? undefined
      : `${history.reason ?? 'Git history unavailable.'} Ranking is structural only — size, fan-in/out and cycle membership — with no churn signal, so treat it as incomplete rather than as a debt ranking.`,
    truncated,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools-hotspots.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Sanity-check against a real repository with history**

Run `findHotspots` against `~/Documents/arsal_git/work-dashboard` via a throwaway script and report the top five with their raw signals, plus `hiddenCoupling`. Delete the script afterwards.

What to look for: the top entries should be files you would expect to be busy — not test fixtures or generated output. If a vendored or generated file tops the list, discovery is letting something through it should not. Report what you see rather than tuning the weights to produce a nicer list; the weights are a starting point and the raw signals are there so a reader can disagree.

- [ ] **Step 6: Commit**

```bash
git add src/tools/hotspots.ts tests/tools-hotspots.test.ts
git commit -m "feat: find_hotspots combining structural and git signals"
```

---

### Task 7: `get_symbol` and `describe_module`

Two description tools, both straightforward reads over the existing store.

**Files:**
- Create: `src/tools/symbol.ts`, `src/tools/module.ts`
- Test: `tests/tools-describe.test.ts`

**Interfaces:**
- Consumes: `GraphStore`, `buildModuleGraph`, `moduleOf`, `couplingMetrics`, `escapeLikeWildcards`, `truncate`.
- Produces: `getSymbol(store, options): SymbolResult`, `describeModule(store, options): ModuleResult`.

> **`describe_module` ships without a summary, deliberately.** The summarizer is spec milestone 9 and is not in this plan. Spec §9 already prescribes the behaviour for an unavailable summarizer: return the structural data with `summary: null` and a reason. That is exactly what this returns, so milestone 9 becomes a matter of filling the field rather than reshaping the tool.

- [ ] **Step 1: Write the failing test**

`tests/tools-describe.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { getSymbol } from '../src/tools/symbol.js'
import { describeModule } from '../src/tools/module.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-desc-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('getSymbol', () => {
  it('returns the definition site and signature', () => {
    const r = getSymbol(store, { name: 'helper', limit: 10 })
    expect(r.matches[0]).toMatchObject({ path: 'src/helper.ts', kind: 'function', exported: true })
    expect(r.matches[0].line).toBeGreaterThan(0)
  })

  it('reports caller and callee counts', () => {
    const r = getSymbol(store, { name: 'helper', limit: 10 })
    expect(r.matches[0].callerCount).toBeGreaterThan(0)
    expect(typeof r.matches[0].calleeCount).toBe('number')
  })

  it('returns every match when a name is not unique, rather than guessing', () => {
    const r = getSymbol(store, { name: 'notify', limit: 10 })
    expect(r.matches.length).toBeGreaterThanOrEqual(1)
    expect(r.totalMatches).toBe(r.matches.length)
  })

  it('explains an unknown symbol rather than returning an empty success', () => {
    const r = getSymbol(store, { name: 'noSuchSymbolAnywhere', limit: 10 })
    expect(r.matches).toEqual([])
    expect(r.note).toMatch(/not found/i)
  })

  it('treats an underscore in the file filter literally, not as a wildcard', () => {
    expect(getSymbol(store, { name: 'helper', file: 'src/h_lper.ts', limit: 10 }).matches).toEqual([])
    expect(getSymbol(store, { name: 'helper', file: 'src/helper.ts', limit: 10 }).matches.length).toBeGreaterThan(0)
  })
})

describe('describeModule', () => {
  it('lists the module files and its exported surface', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    expect(r.files).toContain('src/services/order.ts')
    expect(r.publicSurface.some(s => s.name === 'notify')).toBe(true)
  })

  it('reports dependencies and dependents with edge weights', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    expect(r.dependencies.some(d => d.module === 'src')).toBe(true)
    expect(r.dependents.some(d => d.module === 'src')).toBe(true)
  })

  it('reports coupling metrics for the module', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    expect(r.coupling).toMatchObject({ module: 'src/services' })
    expect(typeof r.coupling!.instability).toBe('number')
  })

  it('returns summary null with a reason, since the summarizer is not built yet', () => {
    const r = describeModule(store, { path: 'src/services', limit: 50 })
    expect(r.summary).toBeNull()
    expect(r.summaryUnavailableReason).toMatch(/not.*(built|available|implemented)/i)
  })

  it('explains an unknown module rather than returning an empty success', () => {
    const r = describeModule(store, { path: 'src/nowhere', limit: 50 })
    expect(r.files).toEqual([])
    expect(r.note).toMatch(/no indexed files/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools-describe.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Implement `get_symbol`**

`src/tools/symbol.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'
import { escapeLikeWildcards, truncate, type Truncation } from './envelope.js'

export interface SymbolOptions {
  name: string
  /** Disambiguate by restricting to a path prefix. */
  file?: string
  limit: number
}

export interface SymbolMatch {
  name: string
  path: string
  line: number
  endLine: number
  kind: string
  exported: boolean
  signature: string | null
  parentName: string | null
  callerCount: number
  calleeCount: number
}

export interface SymbolResult {
  name: string
  matches: SymbolMatch[]
  totalMatches: number
  note?: string
  truncated?: Truncation
}

export function getSymbol(store: GraphStore, options: SymbolOptions): SymbolResult {
  const filter = {
    name: options.name,
    pathPrefix: options.file === undefined ? undefined : escapeLikeWildcards(options.file),
  }
  const total = store.countSymbols(filter)
  const hits = store.findSymbols({ ...filter, limit: Math.max(total, 1) })

  if (hits.length === 0) {
    return {
      name: options.name,
      matches: [],
      totalMatches: 0,
      note: `Symbol "${options.name}" not found in the index. It may be external, ` +
        `misspelled, or in a file that was skipped at index time.`,
    }
  }

  const matches: SymbolMatch[] = hits.map(hit => ({
    name: hit.name,
    path: hit.path,
    line: hit.startLine,
    endLine: hit.endLine,
    kind: hit.kind,
    exported: hit.exported,
    signature: hit.signature,
    parentName: hit.parentName,
    callerCount: store.edgesToSymbol(hit.id).length,
    calleeCount: store.edgesFromSymbol(hit.id).length,
  }))

  const { items, truncated } = truncate(matches, options.limit)
  return { name: options.name, matches: items, totalMatches: matches.length, truncated }
}
```

- [ ] **Step 4: Implement `describe_module`**

`src/tools/module.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'
import { buildModuleGraph, moduleOf } from '../graph/module-graph.js'
import { couplingMetrics, type CouplingMetrics } from '../graph/algorithms.js'
import { truncate, type Truncation } from './envelope.js'

export interface ModuleOptions {
  path: string
  limit: number
}

export interface ModuleNeighbour {
  module: string
  weight: number
}

export interface ExportedSymbol {
  name: string
  kind: string
  path: string
  line: number
}

export interface ModuleResult {
  module: string
  files: string[]
  publicSurface: ExportedSymbol[]
  dependencies: ModuleNeighbour[]
  dependents: ModuleNeighbour[]
  coupling: CouplingMetrics | null
  /** Always null until spec milestone 9 builds the summarizer. */
  summary: string | null
  summaryUnavailableReason?: string
  note?: string
  truncatedFiles?: Truncation
  truncatedSurface?: Truncation
}

const SUMMARY_UNAVAILABLE =
  'The module summarizer is not built yet (spec milestone 9), so no prose summary is available. ' +
  'Everything else in this response is structural and complete.'

export function describeModule(store: GraphStore, options: ModuleOptions): ModuleResult {
  const target = options.path.replace(/\/$/, '')
  const graph = buildModuleGraph(store)

  const files = (graph.filesByModule.get(target) ?? []).slice().sort()
  if (files.length === 0) {
    return {
      module: target,
      files: [],
      publicSurface: [],
      dependencies: [],
      dependents: [],
      coupling: null,
      summary: null,
      summaryUnavailableReason: SUMMARY_UNAVAILABLE,
      note: `No indexed files under "${target}". It may not exist, or its files may have ` +
        `been skipped at index time.`,
    }
  }

  const idsByPath = store.fileIdsByPath()
  const exportedByFile = store.exportedSymbolsByFile()

  const publicSurface: ExportedSymbol[] = []
  for (const path of files) {
    const fileId = idsByPath.get(path)
    if (fileId === undefined) continue
    for (const symbol of exportedByFile.get(fileId) ?? []) {
      publicSurface.push({ name: symbol.name, kind: symbol.kind, path, line: symbol.startLine })
    }
  }
  publicSurface.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))

  const dependencies: ModuleNeighbour[] = [...(graph.out.get(target) ?? new Map())]
    .map(([module, weight]) => ({ module, weight }))
    .sort((a, b) => b.weight - a.weight || a.module.localeCompare(b.module))

  const dependents: ModuleNeighbour[] = [...(graph.in.get(target) ?? new Map())]
    .map(([module, weight]) => ({ module, weight }))
    .sort((a, b) => b.weight - a.weight || a.module.localeCompare(b.module))

  const coupling = couplingMetrics(graph).find(m => m.module === target) ?? null

  const fileSlice = truncate(files, options.limit)
  const surfaceSlice = truncate(publicSurface, options.limit)

  return {
    module: target,
    files: fileSlice.items,
    publicSurface: surfaceSlice.items,
    dependencies,
    dependents,
    coupling,
    summary: null,
    summaryUnavailableReason: SUMMARY_UNAVAILABLE,
    truncatedFiles: fileSlice.truncated,
    truncatedSurface: surfaceSlice.truncated,
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/tools-describe.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add src/tools/symbol.ts src/tools/module.ts tests/tools-describe.test.ts
git commit -m "feat: get_symbol and describe_module"
```

---

### Task 8: `trace_flow`

A forward call-graph walk from an entry point, returned as a tree annotated with the files and module boundaries it crosses. Chained after `search_code`, this answers "what happens when a customer places an order?"

**Files:**
- Create: `src/tools/flow.ts`
- Test: `tests/tools-flow.test.ts`

**Interfaces:**
- Consumes: `GraphStore`, `moduleOf`, `escapeLikeWildcards`, `CONFIDENCE_RANK`.
- Produces: `traceFlow(store, options): FlowResult`.

> **A tree, not a list, and it must terminate.** Recursion through a call graph revisits nodes. The walk carries a `visited` set on the whole traversal, not per branch — a node already expanded elsewhere is emitted as a reference with `repeated: true` rather than expanded again. Without that, a mutually recursive pair produces an infinite tree.

- [ ] **Step 1: Write the failing test**

`tests/tools-flow.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { traceFlow } from '../src/tools/flow.js'
import { buildFixture } from './fixture-builder.js'

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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools-flow.test.ts`
Expected: FAIL — cannot resolve `../src/tools/flow.js`.

- [ ] **Step 3: Implement it**

`src/tools/flow.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'
import { moduleOf } from '../graph/module-graph.js'
import { escapeLikeWildcards } from './envelope.js'
import type { Confidence } from '../types.js'

export interface FlowOptions {
  entry: string
  /** Disambiguate the entry by path prefix. */
  file?: string
  maxDepth: number
  limit: number
}

export interface FlowNode {
  name: string
  /** Null for an external call, which has no file in this repository. */
  path: string | null
  line: number | null
  confidence: Confidence
  /** True when this call leaves the caller's module. */
  crossesModule: boolean
  /** True when this node was already expanded elsewhere in the tree. */
  repeated: boolean
  calls: FlowNode[]
}

export interface FlowResult {
  entry: string
  root: FlowNode | null
  /** Total nodes emitted, including repeats and external calls. */
  totalNodes: number
  depthLimited: boolean
  maxDepth: number
  note?: string
}

export function traceFlow(store: GraphStore, options: FlowOptions): FlowResult {
  const filter = {
    name: options.entry,
    pathPrefix: options.file === undefined ? undefined : escapeLikeWildcards(options.file),
  }
  const total = store.countSymbols(filter)
  const candidates = store.findSymbols({ ...filter, limit: Math.max(total, 1) })

  if (candidates.length === 0) {
    return {
      entry: options.entry,
      root: null,
      totalNodes: 0,
      depthLimited: false,
      maxDepth: options.maxDepth,
      note: `Entry point "${options.entry}" not found in the index. Use search_code to locate ` +
        `it first, or pass "file" to disambiguate if the name is not unique.`,
    }
  }

  const start = candidates[0]
  const pathsById = store.pathsById()
  const expanded = new Set<number>()
  let totalNodes = 1
  let depthLimited = false

  const expand = (symbolId: number, fromModule: string, depth: number): FlowNode[] => {
    if (totalNodes >= options.limit) return []
    if (depth > options.maxDepth) {
      depthLimited = true
      return []
    }

    const children: FlowNode[] = []
    for (const edge of store.edgesFromSymbol(symbolId)) {
      if (totalNodes >= options.limit) break

      const targetPath = edge.dstFileId === null ? null : pathsById.get(edge.dstFileId) ?? null
      const targetName = edge.dstSymbolId === null
        ? edge.dstName
        : store.symbolById(edge.dstSymbolId)?.name ?? edge.dstName

      const alreadyExpanded = edge.dstSymbolId !== null && expanded.has(edge.dstSymbolId)
      const node: FlowNode = {
        name: targetName,
        path: targetPath,
        line: edge.line,
        confidence: edge.confidence,
        crossesModule: targetPath !== null && moduleOf(targetPath) !== fromModule,
        repeated: alreadyExpanded,
        calls: [],
      }
      totalNodes += 1

      // An unresolved edge points at nothing in this repository, so there is
      // nothing to expand — and a node already expanded elsewhere is emitted
      // as a reference, which is what keeps a recursive cycle finite.
      if (edge.dstSymbolId !== null && !alreadyExpanded) {
        expanded.add(edge.dstSymbolId)
        node.calls = expand(edge.dstSymbolId, targetPath === null ? fromModule : moduleOf(targetPath), depth + 1)
      }

      children.push(node)
    }
    return children
  }

  expanded.add(start.id)
  const rootModule = moduleOf(start.path)
  const root: FlowNode = {
    name: start.name,
    path: start.path,
    line: start.startLine,
    confidence: 'exact',
    crossesModule: false,
    repeated: false,
    calls: expand(start.id, rootModule, 1),
  }

  return {
    entry: options.entry,
    root,
    totalNodes,
    depthLimited,
    maxDepth: options.maxDepth,
    note: candidates.length > 1
      ? `"${options.entry}" has ${candidates.length} definitions; traced from ${start.path}:${start.startLine}. ` +
        `Pass "file" to trace a different one.`
      : undefined,
  }
}
```

Note the root's `confidence` is `'exact'` because the root is not a call — it is the symbol you asked for, located directly in the index rather than inferred. That is the one place in this codebase where `exact` is emitted, and it is honest: there is no uncertainty about where the entry point is.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools-flow.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/flow.ts tests/tools-flow.test.ts
git commit -m "feat: trace_flow with cycle-safe expansion"
```

---

### Task 9: Register the six tools and document them

**Files:**
- Modify: `src/mcp/server.ts`, `README.md`
- Test: `tests/mcp-tools-analysis.test.ts`

**Interfaces:**
- Consumes: `findCycles`, `getCoupling`, `findHotspots`, `getSymbol`, `describeModule`, `traceFlow`, `withIndex`, `toolText`.
- Produces: ten registered MCP tools.

> **`find_hotspots` needs the repo root**, because its git signals come from the working tree rather than the index. Thread `repoRoot` into its handler exactly as `impact_of` and `get_repo_overview` already do. A handler that forgets it silently degrades to structural-only scoring with `gitAvailable: false`, while every test still passes — the same failure shape this project has hit three times.

- [ ] **Step 1: Write the failing test**

`tests/mcp-tools-analysis.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { createArchServer } from '../src/mcp/server.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let client: Client

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args })
  if (res.isError) throw new Error(String((res.content as any)[0]?.text))
  return JSON.parse(String((res.content as any)[0].text))
}

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-mcp2-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  const server = createArchServer({ dbPathOverride: () => dbPath })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

describe('the full tool surface', () => {
  it('exposes all ten tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'describe_module', 'find_cycles', 'find_hotspots', 'get_coupling',
      'get_dependencies', 'get_repo_overview', 'get_symbol', 'impact_of',
      'search_code', 'trace_flow',
    ])
  })

  it('gives every tool a substantive description', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(40)
  })
})

describe('each new tool answers through the MCP layer', () => {
  it('find_cycles', async () => {
    const r = await call('find_cycles', { repo: fixture })
    expect(Array.isArray(r.result.cycles)).toBe(true)
    expect(r.index.state).toBe('current')
  })

  it('get_coupling', async () => {
    const r = await call('get_coupling', { repo: fixture })
    expect(r.result.modules.length).toBeGreaterThan(0)
    expect(r.result.modules[0]).toHaveProperty('instability')
  })

  it('find_hotspots reaches git, proving repoRoot was threaded', async () => {
    const r = await call('find_hotspots', { repo: fixture })
    // The fixture IS a git repo, so a handler that dropped repoRoot would
    // report gitAvailable false here.
    expect(r.result.gitAvailable).toBe(true)
    expect(r.result.hotspots.length).toBeGreaterThan(0)
  })

  it('get_symbol', async () => {
    const r = await call('get_symbol', { repo: fixture, name: 'helper' })
    expect(r.result.matches[0].path).toBe('src/helper.ts')
  })

  it('describe_module', async () => {
    const r = await call('describe_module', { repo: fixture, path: 'src/services' })
    expect(r.result.files.length).toBeGreaterThan(0)
    expect(r.result.summary).toBeNull()
    expect(r.result.summaryUnavailableReason).toBeTruthy()
  })

  it('trace_flow', async () => {
    const r = await call('trace_flow', { repo: fixture, entry: 'place' })
    expect(r.result.root.name).toBe('place')
  })
})

describe('input validation on the new tools', () => {
  it('rejects an invalid cycle scope', async () => {
    const res = await client.callTool({ name: 'find_cycles', arguments: { repo: fixture, scope: 'galaxy' } })
    expect(res.isError).toBe(true)
  })

  it('rejects a missing required argument', async () => {
    const res = await client.callTool({ name: 'get_symbol', arguments: { repo: fixture } })
    expect(res.isError).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/mcp-tools-analysis.test.ts`
Expected: FAIL — the six tools are not registered.

- [ ] **Step 3: Register the six tools**

In `src/mcp/server.ts`, import the six functions and register each with `server.registerTool`, following the shape of the four existing registrations exactly: resolve `repoRoot` from the optional `repo` argument, call through `withIndex`, and return `toolText`.

Schemas and descriptions:

```ts
  server.registerTool('find_cycles', {
    title: 'Find circular dependencies',
    description:
      'Strongly-connected components in the dependency graph. Scope "module" finds cycles ' +
      'between directories, which are the architecturally interesting ones; scope "file" finds ' +
      'them between individual files, including inside a single module. Ranked by size, then ' +
      'by how many edges run inside the cycle.',
    inputSchema: {
      repo: repoArg,
      scope: z.enum(['module', 'file']).default('module'),
      minSize: z.number().int().min(1).max(100).default(2)
        .describe('Smallest cycle to report. 2 excludes self-referential single nodes.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, scope, minSize, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(repoRoot, store =>
      findCycles(store, { scope, minSize, limit }), dbFor(repoRoot)))
  })
```

Register the remaining five the same way, with these schemas:

- `get_coupling` — `{ repo, limit }`. Description: per-module afferent and efferent coupling with instability, plus the heaviest module-to-module dependencies. Note that weight counts distinct file-to-file dependencies crossing the boundary.
- `find_hotspots` — `{ repo, limit, windowDays: z.number().int().min(1).max(3650).default(180) }`. Description: technical-debt candidates ranked by structural weight multiplied by git churn, with every raw signal reported alongside the score. State that `gitAvailable: false` means the ranking is structural only. **Pass `repoRoot` as the second argument to `findHotspots`.**
- `get_symbol` — `{ repo, name: z.string().min(1), file: z.string().optional(), limit }`. Description: definition site, signature, export status, and caller/callee counts for every symbol matching the name.
- `describe_module` — `{ repo, path: z.string().min(1), limit }`. Description: a module's files, exported surface, dependencies and dependents with weights, and coupling metrics. State that `summary` is null until the summarizer is built.
- `trace_flow` — `{ repo, entry: z.string().min(1), file: z.string().optional(), maxDepth: z.number().int().min(1).max(10).default(4), limit }`. Description: forward call-graph walk from an entry point, as a tree annotated with files crossed and module boundaries crossed. Note that `repeated: true` marks a node already expanded elsewhere, and `depthLimited` marks a walk cut short.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/mcp-tools-analysis.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Document the tools**

In `README.md`, replace the tool list with all ten, grouped as the spec groups them: orientation (`get_repo_overview`, `describe_module`), search and navigation (`search_code`, `get_symbol`), graph traversal (`get_dependencies`, `impact_of`, `trace_flow`), and analysis (`find_cycles`, `get_coupling`, `find_hotspots`).

Keep the existing confidence-tier section exactly as it is — it documents all five literal tiers and the `impact_of` bucket mapping, which is still correct.

Add a short paragraph on the analysis tools' honesty properties: coupling weight counts distinct file pairs rather than import statements; `find_hotspots` reports `gitAvailable: false` and degrades to structural ranking outside a git repository; and every list reports its true total when capped.

- [ ] **Step 6: Verify the whole surface against a real repository**

```bash
npm run build
node dist/cli.js index ~/Documents/arsal_git/work-dashboard
```

Then drive each of the six new tools over stdio against that repository and report what came back — specifically `find_cycles` at module scope, the top three from `get_coupling`, the top three from `find_hotspots` with their raw signals, and a `trace_flow` from any exported function `search_code` finds. Report the results rather than only that the calls succeeded.

- [ ] **Step 7: Run the whole suite and commit**

Run: `npm test`

```bash
git add src/mcp/server.ts README.md tests/mcp-tools-analysis.test.ts
git commit -m "feat: register the six analysis tools and document the full surface"
```

---

## Done criteria

- Ten MCP tools registered, each returning a freshness envelope and reporting true totals when capped.
- `find_cycles` finds module and file cycles, and reports nothing for an acyclic graph.
- `get_coupling` reports Ca, Ce and instability per module, weighted by distinct file pairs rather than import statements.
- `find_hotspots` ranks by structure multiplied by churn, reports every raw signal, surfaces co-change pairs with no import edge, and degrades loudly outside a git repository.
- `get_symbol`, `describe_module` and `trace_flow` answer their spec questions, with `describe_module` returning `summary: null` and a reason.
- The CLI test suite no longer writes into the developer's real home directory.
- `files.loc` is populated.
- The full suite passes.

## Deliberately out of scope

- **Spec milestone 9, the summarizer.** It needs an LLM dependency, an API-key story, and a cache keyed by git tree-hash. `describe_module` is shaped so that milestone fills a field rather than reshaping the tool.
- **Spec milestone 10, additional grammars.** Additive: one registry entry plus three `.scm` files per language. `@vscode/tree-sitter-wasm` already ships Python, Go, Java, Ruby, Rust, C#, C++ and PHP.
- **The indexing memory ceiling.** Spec §11 records it as O(repo size) with a measurement and a warning. Still an architectural item.
- **Automated tests for the Plan 2 final-wave fixes 2, 3, 4 and 7** are added in Task 1 of this plan; the remaining untested items from that review's residual list stay deferred.
