import { Parser, Language } from 'web-tree-sitter'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

/**
 * Which visibility rule decides whether a declaration is part of a file's
 * importable surface. A key, exactly like `resolverId`, rather than a
 * function: the rules are implemented in `src/parser/parser.ts` next to the
 * AST helpers they share, and holding a function here would make
 * languages.ts import parser.ts while parser.ts imports languages.ts.
 *
 * `parser.ts` switches on this union EXHAUSTIVELY, so adding a member here
 * without adding its branch there is a compile error rather than a silent
 * `exported: false` for every symbol in the new language.
 */
export type ExportRule =
  /** An `export_statement` sits within a few ancestors. TypeScript/JavaScript. */
  | 'js-export-statement'
  /** Every module-level definition is importable by name. Python. */
  | 'python-module-level'
  /** The name's first character is uppercase. Go. */
  | 'go-capitalised'
  /** An explicit `public` modifier, or the nearest enclosing type is an interface or annotation type. Java. */
  | 'java-public-or-interface-member'
  /** A direct `visibility_modifier` child. Rust. */
  | 'rust-visibility-modifier'

export interface LanguageDef {
  id: string
  extensions: string[]
  wasmPath: string
  queryDir: string
  /** Key into the resolver registry (`src/resolve`); see note below. */
  resolverId: string
  /**
   * How `exported` is decided for this language's symbols. REQUIRED, and
   * consolidated here rather than living as a branch in parser.ts, because
   * omitting it used to fail SILENTLY: every symbol came back
   * `exported: false`, and since cross-file call resolution only considers
   * exported symbols, the language produced zero cross-file edges while
   * looking perfectly healthy in every other respect.
   */
  exportRule: ExportRule
  /**
   * Node types that count as "the function this call sits inside" when
   * attributing a call site to its enclosing symbol. REQUIRED for the same
   * reason: omitting it used to leave every `enclosingSymbol` null, which
   * blinds `trace_flow` and `impact_of` without failing anything.
   *
   * Per language rather than one shared set. These node types are NOT
   * disjoint across grammars -- `function_declaration` exists in both the
   * TypeScript and Go grammars, and `method_declaration` in both Go and
   * Java -- so "each grammar owns its own node types" would be a false
   * explanation of why the split is safe.
   *
   * The invariant that IS true, and that was verified by probing every wasm
   * grammar's type list: for each entry, the declared list equals the OLD
   * shared set INTERSECTED WITH THAT LANGUAGE'S OWN GRAMMAR. A node type
   * dropped from a language's list is one its grammar cannot produce, so
   * the `types.includes()` walk in parser.ts can never reach a different
   * answer than the old `Set.has()` did, for any file in any language.
   * (Overlap between languages is therefore harmless: `method_declaration`
   * is declared by BOTH Go and Java, because both grammars have it.)
   */
  enclosingSymbolNodes: string[]
  /**
   * Conventional entry-point file basenames for this language, unioned by
   * `src/tools/entry-points.ts`. REQUIRED for the same reason again: the
   * list was JS-only for the whole of this plan, so `get_repo_overview`
   * told every Go, Rust, Python and Java repository that it had no entry
   * points at all. An empty array is a legitimate, EXPLICIT answer (see
   * `jsx`); leaving the field out is not possible.
   */
  entryBasenames: string[]
}

interface LanguageSpec extends Omit<LanguageDef, 'wasmPath' | 'queryDir'> {
  /** The `tree-sitter-<wasm>.wasm` grammar to load. Need not match `id`. */
  wasm: string
  /** The `queries/<queries>` directory to read. Need not match `id`. */
  queries: string
}

function def(spec: LanguageSpec): LanguageDef {
  const { wasm, queries, ...rest } = spec
  return {
    ...rest,
    wasmPath: require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${wasm}.wasm`),
    queryDir: join(here, 'queries', queries),
  }
}

/** The four TypeScript-grammar languages share one set of function-like nodes. */
const JS_ENCLOSING_SYMBOL_NODES = [
  'function_declaration', 'method_definition', 'arrow_function', 'function_expression',
]

// The wasm grammar, the query directory and the resolver are all chosen
// independently. The TypeScript grammar is a syntactic superset of
// JavaScript, so `javascript` and `jsx` deliberately load the
// TypeScript/TSX wasm grammars rather than tree-sitter-javascript.wasm
// (whose grammar lacks TS-only node kinds that the shared symbols.scm
// references, and so cannot compile that query at all). `id` still
// reflects the source language, since it flows into files.lang in the
// database and downstream reporting. `resolverId` likewise need not match
// `id` or the query directory: it only selects which import-resolution
// strategy (see `src/resolve`) applies to files of this language, and
// languages that share an import syntax can share a resolver.
//
// WHAT ADDING A LANGUAGE ACTUALLY COSTS -- about EIGHT files (see the
// plan's Done Criteria and spec SS5.2, both saying the same thing):
//
//   REQUIRED, always:
//     1. One entry below. The type forces it to be complete.
//     2. queries/<dir>/symbols.scm, imports.scm and calls.scm (3 files).
//        Three, not four: there is no exports.scm.
//     3. A resolver in src/resolve, plus its line in that directory's
//        index.ts RESOLVERS map (2 files) -- or reuse of an existing
//        `resolverId`, in which case neither is touched.
//     4. A row in tests/languages.test.ts. Its `covers every registry
//        entry` assertion compares the row ids against LANGUAGES, so a
//        language added without one turns that test red.
//
//   REQUIRED IF the language's visibility rule is not one of the five
//   `ExportRule` members already defined above:
//     5. A new member on `ExportRule` here, AND its case in `isExported`
//        in src/parser/parser.ts. This is NOT optional and NOT skippable:
//        the switch there is exhaustive with no `default`, so adding the
//        member alone fails to compile --
//          src/parser/parser.ts(217,66): error TS2366: Function lacks
//          ending return statement and return type does not include
//          'undefined'.
//        That compile error is the POINT. Before consolidation this same
//        omission returned `false` for every symbol in the new language,
//        silently, and cost it every cross-file call edge. A build failure
//        naming the exact line is the improvement, not an inconvenience.
//
//   OPTIONAL, depending on the language's SHAPE:
//     - METHOD_CONTAINER_TYPES (src/parser/parser.ts) -- only if a method
//       parses as a plain function nested in a type body (Python, Rust).
//     - ENCLOSING_CLASS_TYPES (src/parser/parser.ts) -- only if a method's
//       container is something other than `class_declaration` (Java), or is
//       named by a field on the method itself rather than an ancestor (Go,
//       which has its own branch).
//     - SAME_PACKAGE_LANGS (src/indexer/same-package.ts) and the matching
//       widening in src/indexer/incremental.ts -- only for directory-scoped
//       languages where siblings reference each other with no import
//       (Go, Java).
//     - An @member capture in imports.scm -- only if one import specifier
//       is spread across two grammar nodes (Python's `from pkg import x`).
//
// The three hooks that used to fail SILENTLY when omitted -- the export
// rule, the enclosing-symbol node types and the entry basenames -- are
// fields above, not tables elsewhere, precisely so they cannot be
// forgotten. The optional hooks fail VISIBLY or not at all: a missing
// METHOD_CONTAINER_TYPES entry yields `function` instead of `method`, a
// missing SAME_PACKAGE_LANGS entry yields unresolved edges.
export const LANGUAGES: LanguageDef[] = [
  def({
    id: 'typescript', wasm: 'typescript', queries: 'typescript',
    extensions: ['.ts', '.mts', '.cts'], resolverId: 'javascript',
    exportRule: 'js-export-statement',
    enclosingSymbolNodes: JS_ENCLOSING_SYMBOL_NODES,
    entryBasenames: ['index.ts', 'main.ts', 'server.ts', 'app.ts', 'cli.ts'],
  }),
  def({
    id: 'tsx', wasm: 'tsx', queries: 'typescript',
    extensions: ['.tsx'], resolverId: 'javascript',
    exportRule: 'js-export-statement',
    enclosingSymbolNodes: JS_ENCLOSING_SYMBOL_NODES,
    entryBasenames: ['index.tsx'],
  }),
  def({
    id: 'javascript', wasm: 'typescript', queries: 'typescript',
    extensions: ['.js', '.mjs', '.cjs'], resolverId: 'javascript',
    exportRule: 'js-export-statement',
    enclosingSymbolNodes: JS_ENCLOSING_SYMBOL_NODES,
    entryBasenames: ['index.js', 'index.mjs', 'main.js', 'server.js', 'app.js', 'cli.js'],
  }),
  def({
    // No `.jsx` basename was ever in the entry list, and adding one now
    // would be a behaviour change smuggled into a refactor. Empty is the
    // explicit, deliberate answer.
    id: 'jsx', wasm: 'tsx', queries: 'typescript',
    extensions: ['.jsx'], resolverId: 'javascript',
    exportRule: 'js-export-statement',
    enclosingSymbolNodes: JS_ENCLOSING_SYMBOL_NODES,
    entryBasenames: [],
  }),
  def({
    id: 'python', wasm: 'python', queries: 'python',
    extensions: ['.py'], resolverId: 'python',
    exportRule: 'python-module-level',
    // One node for both a function and a method.
    enclosingSymbolNodes: ['function_definition'],
    // What `python -m pkg` executes.
    entryBasenames: ['__main__.py'],
  }),
  def({
    id: 'go', wasm: 'go', queries: 'go',
    extensions: ['.go'], resolverId: 'go',
    exportRule: 'go-capitalised',
    // `method_declaration` is captured explicitly as def.method but is
    // still a distinct node type from `function_declaration`; it shapes
    // its `name` field identically.
    enclosingSymbolNodes: ['function_declaration', 'method_declaration'],
    entryBasenames: ['main.go'],
  }),
  def({
    id: 'java', wasm: 'java', queries: 'java',
    extensions: ['.java'], resolverId: 'java',
    exportRule: 'java-public-or-interface-member',
    enclosingSymbolNodes: ['method_declaration'],
    // Convention, not a compiler rule: the class holding `public static
    // void main`.
    entryBasenames: ['Main.java'],
  }),
  def({
    id: 'rust', wasm: 'rust', queries: 'rust',
    extensions: ['.rs'], resolverId: 'rust',
    exportRule: 'rust-visibility-modifier',
    // Both a free function and (nested in an `impl_item`/`trait_item`) a
    // method -- one node type for both, like Python's, with a normal
    // `name` field.
    enclosingSymbolNodes: ['function_item'],
    entryBasenames: ['main.rs'],
  }),
]

const byExtension = new Map<string, LanguageDef>()
for (const language of LANGUAGES) {
  for (const ext of language.extensions) byExtension.set(ext, language)
}

export function languageForPath(path: string): LanguageDef | null {
  return byExtension.get(extname(path)) ?? null
}

let initialized: Promise<void> | null = null
const loaded = new Map<string, Promise<Language>>()

export function loadLanguage(def: LanguageDef): Promise<Language> {
  initialized ??= Parser.init()
  let existing = loaded.get(def.wasmPath)
  if (!existing) {
    existing = initialized.then(() => Language.load(def.wasmPath))
    loaded.set(def.wasmPath, existing)
  }
  return existing
}
