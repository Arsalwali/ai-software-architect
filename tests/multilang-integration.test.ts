import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { getCoupling } from '../src/tools/coupling.js'
import { impactOf } from '../src/tools/impact.js'
import { traceFlow, type FlowNode } from '../src/tools/flow.js'
import {
  buildPythonFixture, buildGoFixture, buildJavaFixture, buildRustFixture,
} from './fixtures-multilang.js'

/**
 * The finding this whole plan exists to prevent: a language with grammars
 * but no resolver reports "no dependencies, no cycles, no coupling" -- a
 * confident wrong answer. Per-language resolver tests (resolve-python.test.ts
 * etc.) prove the resolver in isolation; this file proves the ANALYSIS
 * TOOLS -- the things a user actually calls -- see what the resolver
 * produced. Table-driven so a fifth language is one more row, and so a
 * failure names the language in its test title rather than hiding inside a
 * shared assertion.
 *
 * Symbol/entry names deliberately differ per language (`Help`/`help`/
 * `helper`, `Place`/`place`) because each fixture uses that language's own
 * export convention (Go capitalises, Python/Java/Rust don't) -- see
 * fixtures-multilang.ts's own comments on each fixture.
 */
interface LangCase {
  lang: string
  build: (options?: { git?: boolean }) => string
  /** The helper function/method every fixture defines, in that language's own casing. */
  helperSymbol: string
  /** The file defining helperSymbol. */
  helperPath: string
  /** The file whose `place`/`Place` method calls helperSymbol -- one directory away from helperPath. */
  callerPath: string
  /** The `place`/`Place` entry method traceFlow walks from. */
  entrySymbol: string
}

const CASES: LangCase[] = [
  {
    lang: 'python',
    build: buildPythonFixture,
    helperSymbol: 'helper',
    helperPath: 'pkg/helper.py',
    callerPath: 'pkg/service.py',
    entrySymbol: 'place',
  },
  {
    lang: 'go',
    build: buildGoFixture,
    helperSymbol: 'Help',
    helperPath: 'helper/helper.go',
    callerPath: 'service/service.go',
    entrySymbol: 'Place',
  },
  {
    lang: 'java',
    build: buildJavaFixture,
    helperSymbol: 'help',
    helperPath: 'src/main/java/com/example/Helper.java',
    callerPath: 'src/main/java/com/example/Service.java',
    entrySymbol: 'place',
  },
  {
    lang: 'rust',
    build: buildRustFixture,
    helperSymbol: 'help',
    helperPath: 'src/helper.rs',
    callerPath: 'src/service.rs',
    entrySymbol: 'place',
  },
]

/**
 * Every import row across the WHOLE index. GraphStore only exposes imports
 * per-file (`importsForFile`), so this flattens across every indexed file --
 * anything less would silently only check one file's imports and miss the
 * cross-file one the fixture is built around.
 */
function allImports(store: GraphStore): Array<{ resolvedFileId: number | null; confidence: string }> {
  const rows: Array<{ resolvedFileId: number | null; confidence: string }> = []
  for (const fileId of store.fileIdsByPath().values()) {
    rows.push(...store.importsForFile(fileId))
  }
  return rows
}

/** Every node in a traceFlow tree, root included, depth-first. */
function flatten(node: FlowNode | null): FlowNode[] {
  if (!node) return []
  const out: FlowNode[] = [node]
  for (const child of node.calls) out.push(...flatten(child))
  return out
}

describe('multi-language integration: the analysis tools see what each resolver produced', () => {
  const stores = new Map<string, GraphStore>()

  beforeAll(async () => {
    for (const c of CASES) {
      const root = c.build({ git: true })
      const dbPath = join(mkdtempSync(join(tmpdir(), `arch-ml-${c.lang}-`)), 'index.db')
      await runColdIndex({ repoRoot: root, dbPath })
      stores.set(c.lang, GraphStore.open(dbPath))
    }
  })

  afterAll(() => {
    for (const s of stores.values()) s.close()
  })

  // Claim 1: symbols exist -- a language that indexes files but extracts
  // nothing would still pass a naive file-count check.
  it.each(CASES)('$lang: extracts symbols, not merely indexes files', ({ lang }) => {
    const store = stores.get(lang)!
    expect(store.totals().symbols).toBeGreaterThan(0)
    const row = store.languageBreakdown().find(r => r.lang === lang)
    expect(row, `languageBreakdown has no row for lang=${lang}`).toBeDefined()
    expect(row!.symbols).toBeGreaterThan(0)
  })

  // Claim 2: a cross-file import actually resolved to a file in the repo --
  // the assertion the brief says fails today for all four languages before
  // Tasks 2-5 land a resolver.
  it.each(CASES)('$lang: a cross-file import resolves to a file id', ({ lang }) => {
    const store = stores.get(lang)!
    const imports = allImports(store)
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.some(i => i.resolvedFileId !== null)).toBe(true)
  })

  // Claim 3: a cross-file CALL edge exists at heuristic confidence -- not
  // merely that SOME edge exists, since an unresolved edge always does
  // regardless of whether the resolver works.
  it.each(CASES)('$lang: a cross-file call edge exists at heuristic confidence', ({ lang }) => {
    const store = stores.get(lang)!
    const crossFileHeuristicCalls = store.allEdgeDetails().filter(e =>
      e.kind === 'calls' && e.confidence === 'heuristic' && e.dstPath !== null && e.dstPath !== e.srcPath)
    expect(crossFileHeuristicCalls.length).toBeGreaterThan(0)
  })

  // Claim 4: the MODULE graph has a real edge. Without this, find_cycles and
  // get_coupling are dead for the language even though symbols look healthy
  // -- the module graph is built from resolved imports, a different code
  // path from the file-level edges claim 3 checks.
  it.each(CASES)('$lang: get_coupling reports a module with non-zero efferent coupling', ({ lang }) => {
    const store = stores.get(lang)!
    const coupling = getCoupling(store, { limit: 50 })
    expect(coupling.modules.some(m => m.efferent > 0)).toBe(true)
  })

  // Claim 5: impact_of finds a cross-file reference to the helper symbol
  // each fixture defines, from the file that calls it.
  it.each(CASES)('$lang: impact_of finds a cross-file reference to the helper symbol', ({ lang, helperSymbol, callerPath }) => {
    const store = stores.get(lang)!
    const r = impactOf(store, { symbol: helperSymbol, maxDepth: 5, limit: 50 })
    expect(r.matchedSymbols.length, `no symbol named ${helperSymbol} matched for ${lang}`).toBeGreaterThan(0)
    expect(r.references.some(ref => ref.path === callerPath)).toBe(true)
  })

  // Claim 6: trace_flow crosses a file boundary -- a node whose path differs
  // from the root's, proving the call graph walk actually follows a
  // resolved cross-file edge rather than stopping at the entry file.
  it.each(CASES)('$lang: trace_flow crosses a file boundary from the entry point', ({ lang, entrySymbol, callerPath }) => {
    const store = stores.get(lang)!
    const r = traceFlow(store, { entry: entrySymbol, maxDepth: 5, limit: 50 })
    expect(r.root, `entry point ${entrySymbol} not found for ${lang}: ${r.note}`).not.toBeNull()
    expect(r.root!.path).toBe(callerPath)
    const nodes = flatten(r.root)
    expect(nodes.some(n => n.path !== null && n.path !== callerPath)).toBe(true)
  })

  // The regression-guard negative (Ruling 5): `unresolved` and `ambiguous`
  // must stay distinct. A language whose breakdown is ENTIRELY `unresolved`
  // is the exact wrong answer this plan exists to prevent, but a healthy
  // `ambiguous` row (Java: multiple source roots; Rust: mod.rs/plain-file
  // collisions) must not be treated as a failure -- so this only asserts
  // that unresolved edges are not the WHOLE population, never that the
  // breakdown contains solely resolved/heuristic.
  it.each(CASES)('$lang: confidence breakdown is not entirely unresolved', ({ lang }) => {
    const store = stores.get(lang)!
    const breakdown = store.confidenceBreakdown()
    const totalEdges = store.totals().edges
    expect(totalEdges).toBeGreaterThan(0)
    expect(breakdown.unresolved).toBeLessThan(totalEdges)
  })
})
