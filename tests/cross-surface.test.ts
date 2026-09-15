import { describe, it, expect, beforeAll } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { runIncrementalIndex, type IncrementalReport } from '../src/indexer/incremental.js'
import { buildOverview } from '../src/tools/overview.js'
import { impactOf } from '../src/tools/impact.js'
import { GraphStore } from '../src/store/graph-store.js'

/**
 * Dedicated fixture written directly to its own temp dir -- NOT the shared
 * `buildFixture` from fixture-builder.ts, which ten other tasks assert on
 * the exact contents of.
 */
function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

/**
 * Every existing test in this suite examines exactly one tool or CLI
 * command in isolation. That is precisely how two regressions survived
 * review:
 *
 * - Fix 5: `arch index` (the incremental path, the DEFAULT command) always
 *   reported `parseErrors: 0`, hardcoded, while `arch index --full` (the
 *   cold path) computed the real count from the parser -- two surfaces
 *   disagreeing about identical on-disk content.
 * - Fix 6: `get_repo_overview.entryPoints` only recognised conventional
 *   basenames (index.ts, main.js, ...), while `impact_of.exportedFromEntryPoint`
 *   had separately learned to also read package.json's `main`/`module`/
 *   `bin`/`exports` -- so a symbol could be flagged as exported from an
 *   entry point by one tool while the other tool's entry-point list omitted
 *   that same file entirely.
 *
 * This suite indexes ONE fixture and checks two independent surfaces
 * against that SAME store/report, rather than each in isolation.
 */
describe('cross-surface agreement: two tools reading one index must not disagree', () => {
  let repoRoot: string
  let dbPath: string
  let incrementalReport: IncrementalReport

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'arch-cross-'))
    writeFiles(repoRoot, {
      // Declared as an entry point ONLY via package.json's "main", at a
      // non-conventional basename (not index.ts/main.ts/...), so the
      // entryPoints assertion below can only pass if get_repo_overview
      // actually reads package.json -- exactly Fix 6.
      'src/public.ts': 'export function DeclaredEntry(): number {\n  return 1;\n}\n',
      'src/consumer.ts':
        'import { DeclaredEntry } from "./public";\n\n' +
        'export function useIt(): number {\n  return DeclaredEntry();\n}\n',
      'package.json': JSON.stringify({ name: 'cross-fixture', main: 'src/public.ts' }, null, 2),
    })
    dbPath = join(mkdtempSync(join(tmpdir(), 'arch-cross-db-')), 'index.db')

    // Pass 1: a clean cold index. This is what establishes a COMPLETE index
    // for the incremental run below to build on top of.
    await runColdIndex({ repoRoot, dbPath })

    // Introduce a genuine parse error -- the same broken construct the
    // parser's own test suite (tests/parser-imports-calls.test.ts) uses --
    // AFTER the cold index, then run the REAL incremental path. Running
    // runIncrementalIndex against a fresh/missing db falls back to
    // runColdIndex internally and would spread its already-correct
    // `parseErrors`, never touching incremental.ts's own report() function,
    // which is where Fix 5's bug actually lived.
    writeFiles(repoRoot, {
      'src/broken.ts': 'function good() { return 1; }\nfunction BROKEN( { { {\n',
    })
    incrementalReport = await runIncrementalIndex({ repoRoot, dbPath })
  })

  it('arch index (incremental) and get_repo_overview agree that a parse error exists', () => {
    // Before Fix 5 this was hardcoded to 0 on the incremental path, even
    // though a file the run just parsed genuinely failed to parse.
    expect(incrementalReport.parseErrors).toBeGreaterThan(0)

    const store = GraphStore.open(dbPath)
    try {
      const overview = buildOverview(store, repoRoot)
      expect(overview.filesWithParseErrors).toBeGreaterThan(0)
      // Not just independently non-zero -- the two surfaces must agree
      // about the same underlying fact (an error exists in this index).
      expect(incrementalReport.parseErrors > 0).toBe(overview.filesWithParseErrors > 0)
    } finally {
      store.close()
    }
  })

  it('get_repo_overview.entryPoints and impact_of.exportedFromEntryPoint agree about a package.json-declared entry', () => {
    const store = GraphStore.open(dbPath)
    try {
      const overview = buildOverview(store, repoRoot)
      expect(overview.entryPoints).toContain('src/public.ts')

      const impact = impactOf(store, { symbol: 'DeclaredEntry', maxDepth: 1, limit: 10, repoRoot })
      expect(impact.exportedFromEntryPoint).toBe(true)
    } finally {
      store.close()
    }
  })
})
