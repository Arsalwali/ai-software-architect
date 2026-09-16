import { describe, it, expect, beforeAll } from 'vitest'
import { LANGUAGES, languageForPath, loadLanguage } from '../src/parser/languages.js'
import { RepoParser } from '../src/parser/parser.js'
import { ENTRY_BASENAMES, isEntryPoint } from '../src/tools/entry-points.js'

describe('language registry', () => {
  it('maps TypeScript extensions to the typescript grammar', () => {
    expect(languageForPath('src/a.ts')?.id).toBe('typescript')
    expect(languageForPath('src/a.tsx')?.id).toBe('tsx')
  })

  it('returns null for unknown extensions', () => {
    expect(languageForPath('README.md')).toBeNull()
    expect(languageForPath('data.bin')).toBeNull()
  })

  it('loads a grammar that can parse source', async () => {
    const def = languageForPath('a.ts')!
    const lang = await loadLanguage(def)
    expect(lang.nodeTypeCount).toBeGreaterThan(0)
  })

  it('memoizes grammar loading', async () => {
    const def = languageForPath('a.ts')!
    expect(await loadLanguage(def)).toBe(await loadLanguage(def))
  })
})

/**
 * final-fixes.md item 6(a). Three per-language tables used to live away
 * from the registry -- the `isExported` branch and `ENCLOSING_SYMBOL_NODES`
 * in src/parser/parser.ts, and `ENTRY_BASENAMES` in
 * src/tools/entry-points.ts -- and all three failed SILENTLY when a new
 * language omitted them: every symbol `exported: false` (so zero cross-file
 * call edges), every `enclosingSymbol` null (so `trace_flow` and
 * `impact_of` blind), and no entry points at all. They are now required
 * fields on `LanguageDef`.
 *
 * The type makes them impossible to omit at compile time. This gate makes
 * them impossible to get WRONG without a red test, for every one of the
 * eight registry entries rather than only the six that happen to have a
 * per-language test file: each row below is parsed for real and must
 * produce (a) an exported symbol, (b) an UNEXPORTED one -- so an export
 * rule of `return true` fails here -- and (c) a call attributed to its
 * enclosing function.
 */
describe('every registry entry declares working hooks for the three silent failures', () => {
  interface Row {
    id: string
    path: string
    source: string
    exportedName: string
    unexportedName: string
    /** The function the `helper()` call below must be attributed to. */
    enclosing: string
    /**
     * One basename this language MUST declare in `entryBasenames`, pinned
     * here rather than read back off the registry: reading it back would
     * make the assertion tautological and an emptied `entryBasenames` array
     * would still pass. `null` only for `jsx`, which deliberately declares
     * none (no `.jsx` basename was ever in the pre-consolidation list).
     */
    entryBasename: string | null
  }

  // The TypeScript grammar parses all four JS-family entries, so they share
  // one source; the point of listing them separately is that each is a
  // separate REGISTRY ENTRY that could individually be given wrong fields.
  const JS_SOURCE =
    'export function handler(): number {\n  return helper();\n}\n\n' +
    'function hidden(): number {\n  return 0;\n}\n'

  const ROWS: Row[] = [
    { id: 'typescript', path: 'a.ts', source: JS_SOURCE, exportedName: 'handler', unexportedName: 'hidden', enclosing: 'handler', entryBasename: 'index.ts' },
    { id: 'tsx', path: 'a.tsx', source: JS_SOURCE, exportedName: 'handler', unexportedName: 'hidden', enclosing: 'handler', entryBasename: 'index.tsx' },
    { id: 'javascript', path: 'a.js', source: JS_SOURCE, exportedName: 'handler', unexportedName: 'hidden', enclosing: 'handler', entryBasename: 'index.js' },
    { id: 'jsx', path: 'a.jsx', source: JS_SOURCE, exportedName: 'handler', unexportedName: 'hidden', enclosing: 'handler', entryBasename: null },
    {
      id: 'python', path: 'a.py',
      // Python's rule is "defined at module level"; `hidden` is a method, so
      // it is not part of the module's importable surface.
      source: 'def handler():\n    return helper()\n\n\nclass C:\n    def hidden(self):\n        return 0\n',
      exportedName: 'handler', unexportedName: 'hidden', enclosing: 'handler', entryBasename: '__main__.py',
    },
    {
      id: 'go', path: 'a.go',
      source: 'package main\n\nfunc Handler() int {\n\treturn helper()\n}\n\nfunc hidden() int {\n\treturn 0\n}\n',
      exportedName: 'Handler', unexportedName: 'hidden', enclosing: 'Handler', entryBasename: 'main.go',
    },
    {
      id: 'java', path: 'A.java',
      source: 'package p;\n\npublic class A {\n  public int handler() { return helper(); }\n' +
        '  int hidden() { return 0; }\n}\n',
      exportedName: 'handler', unexportedName: 'hidden', enclosing: 'handler', entryBasename: 'Main.java',
    },
    {
      id: 'rust', path: 'a.rs',
      source: 'pub fn handler() -> i32 {\n    helper()\n}\n\nfn hidden() -> i32 {\n    0\n}\n',
      exportedName: 'handler', unexportedName: 'hidden', enclosing: 'handler', entryBasename: 'main.rs',
    },
  ]

  let parser: RepoParser
  beforeAll(async () => { parser = await RepoParser.create() })

  it('covers every registry entry', () => {
    // Guards against a ninth language being registered without a row here,
    // which would leave it untested by the three assertions below.
    expect(ROWS.map(r => r.id).sort()).toEqual(LANGUAGES.map(l => l.id).sort())
  })

  it.each(ROWS)('$id: exportRule marks the exported symbol and not the unexported one', (row) => {
    const parsed = parser.parse(row.path, row.source)
    expect(parsed.lang, `${row.path} is not indexed as ${row.id}`).toBe(row.id)
    expect(parsed.symbols.find(s => s.name === row.exportedName)!.exported).toBe(true)
    expect(parsed.symbols.find(s => s.name === row.unexportedName)!.exported).toBe(false)
  })

  it.each(ROWS)('$id: enclosingSymbolNodes attributes a call to its enclosing function', (row) => {
    const call = parser.parse(row.path, row.source).callSites.find(c => c.name === 'helper')!
    expect(call, `no helper() call site found for ${row.id}`).toBeDefined()
    expect(call.enclosingSymbol).toBe(row.enclosing)
  })

  it('ENTRY_BASENAMES is exactly the union of the registry entryBasenames', () => {
    expect([...ENTRY_BASENAMES].sort())
      .toEqual([...new Set(LANGUAGES.flatMap(l => l.entryBasenames))].sort())
    // And the union is non-trivial, so a registry that lost every
    // entryBasenames array would not satisfy this by being empty on both
    // sides.
    expect(ENTRY_BASENAMES.size).toBeGreaterThan(10)
  })

  it.each(ROWS)('$id: its entryBasenames reach isEntryPoint', (row) => {
    const declared = LANGUAGES.find(l => l.id === row.id)!.entryBasenames
    if (row.entryBasename === null) {
      expect(declared).toEqual([])
      return
    }
    expect(declared).toContain(row.entryBasename)
    // Every basename it declares, not just the pinned one, must actually
    // be recognised -- the registry field is useless if the union misses it.
    for (const basename of declared) {
      expect(isEntryPoint(`some/dir/${basename}`, new Set())).toBe(true)
    }
  })
})
