import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { getCoupling } from '../src/tools/coupling.js'
import { impactOf } from '../src/tools/impact.js'
import { traceFlow, type FlowNode } from '../src/tools/flow.js'
import { buildOverview } from '../src/tools/overview.js'
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
 *
 * task-6-fixes-round2.md, Fix 1: a reviewer killed each language's import
 * resolver in turn and re-ran this gate. For Go and Java, several claims
 * STAYED GREEN with the resolver dead, because `Helper.java`/`Service.java`
 * (Java) and, less severely, generic "any cross-file edge" checks (Go) are
 * ALSO satisfiable by `src/indexer/same-package.ts`'s same-directory
 * fallback -- a mechanism that is correctly independent of import
 * resolution, but which means "some cross-file heuristic edge exists" no
 * longer proves the IMPORT/FQN resolver specifically works. Fix: for Go and
 * Java, `helperSymbol`/`helperPath`/`entrySymbol` below are pinned to a pair
 * that crosses a DIRECTORY boundary on both ends (`service/` -> `helper/`
 * for Go; `com/example` -> `com/example/util` for Java via
 * `Service.label()` -> `StringUtil.greet()`, NOT `Service.place()` ->
 * `Helper.help()`, which shares `Service.java`'s own directory with
 * `Helper.java` and is exactly the pair the same-package fallback can cover
 * for). Go's original `Help`/`service.go`/`helper.go`/`Place` pair was
 * ALREADY cross-directory-safe (verified empirically below); only Java's
 * needed to change.
 */
interface LangCase {
  lang: string
  build: (options?: { git?: boolean }) => string
  /** The helper function/method every fixture defines, in that language's own casing. */
  helperSymbol: string
  /** The file defining helperSymbol. */
  helperPath: string
  /** The file whose entry method calls helperSymbol -- a DIFFERENT directory from helperPath, for every language (see the class doc above on why that matters for Go/Java). */
  callerPath: string
  /** The entry method traceFlow walks from. */
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
    // Pinned to Service.label() -> StringUtil.greet() (com/example ->
    // com/example/util), NOT Service.place() -> Helper.help() -- see the
    // class doc above. `Service.java` is still the caller, just via a
    // different one of its own methods.
    helperSymbol: 'greet',
    helperPath: 'src/main/java/com/example/util/StringUtil.java',
    callerPath: 'src/main/java/com/example/Service.java',
    entrySymbol: 'label',
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
 * (srcPath, dstName) pairs whose edge is satisfiable by
 * `src/indexer/same-package.ts`'s same-directory fallback ALONE, with no
 * import involved at all -- Go's `single/two.go` -> `help` and Java's
 * `Service.java` -> `help` (the ORIGINAL Service.place()/Helper.help() pair,
 * same-directory) and `Worker.java` -> `internal`. Claim 7 below excludes
 * these when computing its confidence breakdown, precisely because they
 * would otherwise mask a fully-dead import/FQN resolver -- the exact
 * coverage loss task-6-fixes-round2.md Fix 1 found.
 */
const SAME_DIRECTORY_ONLY_EDGES: Record<string, Array<{ srcPath: string; dstName: string }>> = {
  python: [],
  go: [{ srcPath: 'single/two.go', dstName: 'help' }],
  java: [
    { srcPath: 'src/main/java/com/example/Service.java', dstName: 'help' },
    { srcPath: 'src/main/java/com/example/Worker.java', dstName: 'internal' },
  ],
  rust: [],
}

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
  // regardless of whether the resolver works. Pinned to the exact
  // (helperSymbol, helperPath, callerPath) triple (task-6-fixes-round2.md,
  // Fix 1), NOT "any cross-file heuristic edge anywhere in the store": for
  // Go and Java, `single/two.go` -> `help` and (the ORIGINAL pairing)
  // `Service.java` -> `help` are ALSO heuristic edges, produced entirely by
  // the same-package fallback with no import involved -- a generic "some
  // edge exists" check would stay green even with the import/FQN resolver
  // completely deleted. `helperPath`/`callerPath` are pinned to a
  // cross-DIRECTORY pair for every language specifically so this can only
  // be satisfied by import resolution actually working.
  it.each(CASES)('$lang: the import-mediated cross-file call edge resolves at heuristic confidence', ({ lang, helperSymbol, helperPath, callerPath }) => {
    const store = stores.get(lang)!
    const edge = store.allEdgeDetails().find(e =>
      e.kind === 'calls' && e.dstName === helperSymbol && e.srcPath === callerPath && e.dstPath === helperPath)
    expect(edge, `no edge ${callerPath} -> ${helperPath} (${helperSymbol}) for ${lang}`).toBeDefined()
    expect(edge!.confidence).toBe('heuristic')
  })

  // task-6-fixes.md: Go and Java scope names by DIRECTORY, so two files in
  // the SAME package never import one another -- the ordinary, dominant
  // layout for both languages (one Go package split across many files; two
  // Java classes in one package). Claim 3 above is satisfied by an
  // IMPORT-mediated cross-file call in both fixtures and would stay green
  // even if this case were completely unresolved, so it is asserted here on
  // its own, by symbol name rather than by "any cross-file edge", naming
  // exactly the call this mechanism exists for. `single/two.go`'s `Combine`
  // calls `single/one.go`'s unexported `help` with no import; `Worker.java`
  // calls `Helper.java`'s package-private `internal` with no import either
  // -- both would be `unresolved` without the same-directory candidate
  // pool `src/indexer/same-package.ts` adds, and neither symbol is
  // exported, so a fix that filtered same-directory candidates by
  // `exported` would leave both unresolved too.
  it('go: a same-package cross-file call with NO import resolves at heuristic confidence', () => {
    const store = stores.get('go')!
    const edge = store.allEdgeDetails().find(e =>
      e.kind === 'calls' && e.dstName === 'help' && e.srcPath === 'single/two.go')
    expect(edge, 'no edge from single/two.go to help').toBeDefined()
    expect(edge!.dstPath).toBe('single/one.go')
    expect(edge!.confidence).toBe('heuristic')
  })

  it('java: a same-package cross-file call to a package-private member with NO import resolves at heuristic confidence', () => {
    const store = stores.get('java')!
    const edge = store.allEdgeDetails().find(e =>
      e.kind === 'calls' && e.dstName === 'internal' &&
      e.srcPath === 'src/main/java/com/example/Worker.java')
    expect(edge, 'no edge from Worker.java to internal').toBeDefined()
    expect(edge!.dstPath).toBe('src/main/java/com/example/Helper.java')
    expect(edge!.confidence).toBe('heuristic')
  })

  // final-fixes.md item 2: `get_repo_overview` reported ZERO entry points
  // for every one of the four new languages, because the conventional
  // basename list in src/tools/entry-points.ts was JS-only. "This
  // repository has no entry points", said about a repo whose root holds
  // `main.go` or whose `src/` holds `main.rs`, is a confident wrong answer
  // -- and it also silently zeroes `impact_of`'s `exportedFromEntryPoint`
  // flag for those languages. Asserted against the SHIPPED fixtures, not a
  // purpose-built one, so it is the real repo shape that is covered.
  // `buildOverview` is called with no repoRoot here deliberately: these
  // fixtures have no package.json, so only the basename rule can be what
  // produces the hit.
  it('go: get_repo_overview lists main.go as an entry point', () => {
    expect(buildOverview(stores.get('go')!).entryPoints).toContain('main.go')
  })

  it('rust: get_repo_overview lists src/main.rs as an entry point', () => {
    expect(buildOverview(stores.get('rust')!).entryPoints).toContain('src/main.rs')
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
  // each fixture defines, from the file that calls it. Pinned to a
  // cross-directory pair for Go/Java (see the class doc on `LangCase`
  // above): a same-directory pair here would stay green even with the
  // FQN/import resolver deleted, via the same-package fallback alone.
  it.each(CASES)('$lang: impact_of finds a cross-file reference to the helper symbol', ({ lang, helperSymbol, callerPath }) => {
    const store = stores.get(lang)!
    const r = impactOf(store, { symbol: helperSymbol, maxDepth: 5, limit: 50 })
    expect(r.matchedSymbols.length, `no symbol named ${helperSymbol} matched for ${lang}`).toBeGreaterThan(0)
    expect(r.references.some(ref => ref.path === callerPath)).toBe(true)
  })

  // Claim 6: trace_flow crosses a file boundary -- a node whose path differs
  // from the root's, proving the call graph walk actually follows a
  // resolved cross-file edge rather than stopping at the entry file. Pinned
  // the same way as claim 5, for the same reason.
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
  //
  // task-6-fixes-round2.md, Fix 1: computed over `calls` edges EXCLUDING
  // `SAME_DIRECTORY_ONLY_EDGES` -- a STRICTER check than the whole-store
  // `store.confidenceBreakdown()`, not a weaker one: this excluded set is a
  // subset of all edges, so "the subset has a non-unresolved edge" implies
  // "the whole store does" too, but not the reverse. Without the exclusion,
  // this claim stayed GREEN for Go and Java even with their import/FQN
  // resolver completely deleted, because the same-package fallback alone
  // guarantees a non-unresolved edge exists somewhere in the fixture,
  // independent of whether import resolution works at all -- exactly the
  // coverage loss this fix round exists to close.
  it.each(CASES)('$lang: confidence breakdown, excluding same-package-only calls, is not entirely unresolved', ({ lang }) => {
    const store = stores.get(lang)!
    const excluded = SAME_DIRECTORY_ONLY_EDGES[lang] ?? []
    const isSameDirectoryOnly = (e: { srcPath: string; dstName: string }) =>
      excluded.some(x => x.srcPath === e.srcPath && x.dstName === e.dstName)
    const relevant = store.allEdgeDetails().filter(e => e.kind === 'calls' && !isSameDirectoryOnly(e))
    const unresolvedCount = relevant.filter(e => e.confidence === 'unresolved').length
    expect(relevant.length).toBeGreaterThan(0)
    expect(unresolvedCount).toBeLessThan(relevant.length)
  })
})
