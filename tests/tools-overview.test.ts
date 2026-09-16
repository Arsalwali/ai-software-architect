import { describe, it, expect, beforeAll } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { buildOverview } from '../src/tools/overview.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-ov-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('buildOverview', () => {
  it('reports totals', () => {
    const o = buildOverview(store)
    expect(o.totals.files).toBeGreaterThan(0)
    expect(o.totals.symbols).toBeGreaterThan(0)
    expect(o.totals.edges).toBeGreaterThan(0)
  })

  it('reports languages including files with no known language', () => {
    const o = buildOverview(store)
    expect(o.languages.find(l => l.lang === 'typescript')!.files).toBeGreaterThan(0)
    expect(o.languages.some(l => l.lang === null)).toBe(true)
  })

  it('reports the confidence breakdown WITHOUT merging unresolved into ambiguous', () => {
    const o = buildOverview(store)
    expect(o.edgeConfidence.unresolved).toBeGreaterThan(0)
    expect(o.edgeConfidence).toHaveProperty('ambiguous')
    expect(o.edgeConfidence).toHaveProperty('heuristic')
  })

  it('reports the share of edges targeting internal symbols', () => {
    const o = buildOverview(store)
    expect(o.internalTargetFraction).toBeGreaterThanOrEqual(0)
    expect(o.internalTargetFraction).toBeLessThanOrEqual(1)
  })

  it('lists top-level modules with their file and symbol counts', () => {
    const o = buildOverview(store)
    const src = o.modules.find(m => m.path === 'src')!
    expect(src.files).toBeGreaterThan(0)
    expect(src.symbols).toBeGreaterThan(0)
  })

  it('surfaces the skip breakdown by reason', () => {
    const o = buildOverview(store)
    expect(o.skipped.total).toBeGreaterThan(0)
    expect(Object.keys(o.skipped.byReason).length).toBeGreaterThan(0)
  })

  it('reports parse errors from the per-file counts', () => {
    const o = buildOverview(store)
    expect(o.filesWithParseErrors).toBe(0)
  })

  it('detects entry points', () => {
    const o = buildOverview(store)
    expect(o.entryPoints).toContain('src/index.ts')
  })
})

/**
 * final-fixes.md item 2. The entry-basename list was JS-only, so every
 * non-JS language reported "no entry points". The Go and Rust halves are
 * asserted against the SHIPPED fixtures in multilang-integration.test.ts;
 * Python's `__main__.py` and Java's `Main.java` have no such fixture, so
 * this builds a purpose-made one covering all four at once rather than
 * perturbing a shared fixture that a dozen other expectations depend on.
 *
 * Every file here carries real content, not a stub: a file that fails to
 * parse or extracts no symbol would still be listed as an entry point (the
 * check is on the path alone), so an empty file would make this test pass
 * for the wrong reason.
 */
describe('entry-point basenames for every indexed language', () => {
  const ENTRY_FILES: Record<string, string> = {
    'main.go': 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n',
    'src/main.rs': 'fn main() {\n    println!("hi");\n}\n',
    'app/__main__.py': 'def main():\n    return 1\n\n\nmain()\n',
    'src/main/java/com/example/Main.java':
      'package com.example;\n\npublic class Main {\n' +
      '  public static void main(String[] args) { System.out.println("hi"); }\n}\n',
    // A non-entry file per language, so "lists everything it indexed" would
    // not pass either.
    'helper.go': 'package main\n\nfunc help() int {\n\treturn 1\n}\n',
    'src/helper.rs': 'pub fn help() -> i32 {\n    1\n}\n',
    'app/helper.py': 'def help():\n    return 1\n',
    'src/main/java/com/example/Helper.java':
      'package com.example;\n\npublic class Helper {\n  public static int help() { return 1; }\n}\n',
  }

  let entryPoints: string[]

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-entry-'))
    for (const [rel, content] of Object.entries(ENTRY_FILES)) {
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-entry-db-')), 'index.db')
    await runColdIndex({ repoRoot: root, dbPath })
    const s = GraphStore.open(dbPath)
    try {
      // No package.json exists in this fixture, so the basename rule is the
      // only thing that can produce a hit.
      entryPoints = buildOverview(s, root).entryPoints
    } finally {
      s.close()
    }
  })

  it.each([
    ['go', 'main.go'],
    ['rust', 'src/main.rs'],
    ['python', 'app/__main__.py'],
    ['java', 'src/main/java/com/example/Main.java'],
  ])('%s: %s is recognised as an entry point', (_lang, path) => {
    expect(entryPoints).toContain(path)
  })

  it('does not treat every indexed file as an entry point', () => {
    expect(entryPoints).not.toContain('helper.go')
    expect(entryPoints).not.toContain('src/helper.rs')
    expect(entryPoints).not.toContain('app/helper.py')
    expect(entryPoints).not.toContain('src/main/java/com/example/Helper.java')
  })
})
