# AI Software Architect — Indexing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the indexing core — `arch index <repo>` parses a repository with tree-sitter and produces a complete SQLite symbol and dependency graph, with confidence-tiered edges.

**Architecture:** A six-phase pipeline (discover → parse → persist nodes → resolve → persist edges → finalize). Everything language-specific hides behind one normalized `ParsedFile` record, so adding a language means adding a grammar plus three query files and nothing else. Node and edge persistence are separate passes because a call cannot be resolved until every symbol in the repository exists.

**Tech Stack:** TypeScript (ESM), Node 20+, `web-tree-sitter` 0.27.0, `@vscode/tree-sitter-wasm` 0.3.1, `better-sqlite3` 13.0.3, `vitest` 5.x, `commander` 15.x.

**Spec:** `docs/superpowers/specs/2026-09-14-ai-software-architect-design.md`

**Scope:** This plan covers spec §12 milestones 1–5. Milestones 6–7 (incremental reindex, MCP server and tools) are Plan 2. Milestones 8–10 are Plan 3.

## Global Constraints

- Node 20+ required. Project is **ESM** (`"type": "module"` in `package.json`).
- JavaScript and JSX load the TypeScript and TSX grammars, never `tree-sitter-javascript.wasm`. The shared query set names TS-only node types; web-tree-sitter validates node names at `Query` construction and throws `Bad node name 'type_identifier'` against the JS grammar.
- Pinned dependency versions, exactly: `web-tree-sitter@0.27.0`, `@vscode/tree-sitter-wasm@0.3.1`, `better-sqlite3@13.0.3`, `commander@15.0.0`. **These two tree-sitter packages are ABI-coupled** — `tree-sitter-wasms` (a commonly suggested alternative) is built against tree-sitter CLI 0.20 and throws a dylink error on `Language.load` with web-tree-sitter 0.27. Do not substitute either package.
- Confidence tier values, verbatim: `exact`, `resolved`, `heuristic`, `ambiguous`. `exact` is reserved and emitted by nothing in this plan.
- Edge kind values, verbatim: `calls`, `extends`, `implements`, `instantiates`, `references`.
- Index location: `~/.arch/repos/<sha256-of-abs-path, first 16 hex>/index.db`.
- Never silently omit. Every skipped file is recorded with a reason; every capped list carries `truncated` and `total`.
- Ambiguous matches are **stored**, never discarded (spec §6.2).
- The TypeScript type for a code symbol is named `SourceSymbol`, never `Symbol` — the latter shadows the JS global.
- `meta.head_commit` is written last and only on success.

## File Structure

```
src/
  types.ts                      -- ParsedFile, SourceSymbol, RawImport, CallSite, ParseError, tiers
  parser/
    languages.ts                -- extension -> grammar + query dir registry
    parser.ts                   -- RepoParser: source -> ParsedFile
    queries/typescript/{symbols,imports,calls}.scm
  store/
    schema.sql                  -- the six tables
    graph-store.ts              -- GraphStore: the only module touching SQLite
  repo/
    repo-source.ts              -- repo root resolution, cache dir, git handle
  indexer/
    discover.ts                 -- git ls-files + filters
    resolve-imports.ts          -- specifier -> file, resolved tier
    resolve-calls.ts            -- name -> symbol, heuristic/ambiguous/unresolved
    pipeline.ts                 -- the six phases
    parse-pool.ts               -- worker_threads parse pool
    parse-worker.ts             -- worker entry
  cli.ts                        -- arch index / arch status
tests/
  fixture-builder.ts            -- generates the fixture repo into a temp dir
  *.test.ts
```

---

### Task 1: Project scaffold and tree-sitter bootstrap

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/parser/languages.ts`
- Test: `tests/languages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LanguageDef { id: string; extensions: string[]; wasmPath: string; queryDir: string }`, `languageForPath(path: string): LanguageDef | null`, `loadLanguage(def: LanguageDef): Promise<Language>` (memoized).

- [ ] **Step 1: Create the project files**

`package.json`:
```json
{
  "name": "ai-software-architect",
  "version": "0.1.0",
  "type": "module",
  "bin": { "arch": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@vscode/tree-sitter-wasm": "0.3.1",
    "better-sqlite3": "13.0.3",
    "commander": "15.0.0",
    "web-tree-sitter": "0.27.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^5.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
})
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

`tests/languages.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { languageForPath, loadLanguage } from '../src/parser/languages.js'

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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/languages.test.ts`
Expected: FAIL — cannot resolve `../src/parser/languages.js`.

- [ ] **Step 4: Implement the registry**

`src/parser/languages.ts`:
```ts
import { Parser, Language } from 'web-tree-sitter'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

export interface LanguageDef {
  id: string
  extensions: string[]
  wasmPath: string
  queryDir: string
}

function def(id: string, wasmName: string, queryDirName: string, extensions: string[]): LanguageDef {
  return {
    id,
    extensions,
    wasmPath: require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${wasmName}.wasm`),
    queryDir: join(here, 'queries', queryDirName),
  }
}

// Adding a language means adding one entry here plus a queries/<dir> with
// symbols.scm, imports.scm and calls.scm. Nothing else in the codebase changes.
//
// The grammar and the query directory are chosen independently. JavaScript and
// JSX deliberately load the TypeScript and TSX grammars: TypeScript is a
// syntactic superset of JavaScript, and the shared query set names TS-only node
// types (`type_identifier`, `interface_declaration`) that the JavaScript grammar
// does not define. web-tree-sitter validates node names when a Query is
// constructed and offers no lenient mode, so pairing the shared queries with
// tree-sitter-javascript.wasm throws at startup. The distinct `id` values are
// kept so files.lang reports 'javascript' rather than mislabelling .js as TS.
export const LANGUAGES: LanguageDef[] = [
  def('typescript', 'typescript', 'typescript', ['.ts', '.mts', '.cts']),
  def('tsx', 'tsx', 'typescript', ['.tsx']),
  def('javascript', 'typescript', 'typescript', ['.js', '.mjs', '.cjs']),
  def('jsx', 'tsx', 'typescript', ['.jsx']),
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
```

Note: `def()`'s second argument is the grammar wasm and its third is the query directory — they are chosen independently, which is what lets JavaScript and JSX reuse both the TypeScript grammars and the TypeScript query set. Verified against all three grammars: `typescript.wasm` parses plain JavaScript (including CommonJS `require`/`module.exports`) with no errors, while `javascript.wasm` cannot compile the shared query at all.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/languages.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/parser/languages.ts tests/languages.test.ts
git commit -m "feat: project scaffold and tree-sitter language registry"
```

---

### Task 2: The ParsedFile contract and symbol extraction

This task defines the contract the entire project rests on. Defend it here: nothing downstream of the parser may learn what language a file was written in.

**Files:**
- Create: `src/types.ts`
- Create: `src/parser/queries/typescript/symbols.scm`
- Create: `src/parser/parser.ts`
- Test: `tests/parser-symbols.test.ts`

**Interfaces:**
- Consumes: `languageForPath`, `loadLanguage` from Task 1.
- Produces: all types in `src/types.ts`; `RepoParser` with `static create(): Promise<RepoParser>` and `parse(path: string, source: string): ParsedFile`.

- [ ] **Step 1: Write the types**

`src/types.ts`:
```ts
export type Confidence = 'exact' | 'resolved' | 'heuristic' | 'ambiguous'

export type EdgeKind = 'calls' | 'extends' | 'implements' | 'instantiates' | 'references'

export type SymbolKind =
  | 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable'

/** A code symbol. Named SourceSymbol because `Symbol` is a JS global. */
export interface SourceSymbol {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
  exported: boolean
  signature: string | null
  /** Enclosing class name for methods, otherwise null. */
  parentName: string | null
}

export interface RawImport {
  specifier: string
  kind: 'static' | 'dynamic' | 'require'
  line: number
}

export interface CallSite {
  name: string
  line: number
  /** Name of the enclosing function/method, or null at file top level. */
  enclosingSymbol: string | null
  kind: 'calls' | 'instantiates'
}

export interface ParseError {
  line: number
  message: string
}

/**
 * The normalized output of the parser and the load-bearing contract of this
 * project. No module downstream of the parser knows what language a file was
 * written in. Keep it that way.
 */
export interface ParsedFile {
  path: string
  lang: string | null
  contentHash: string
  symbols: SourceSymbol[]
  imports: RawImport[]
  callSites: CallSite[]
  errors: ParseError[]
}
```

- [ ] **Step 2: Write the symbols query**

`src/parser/queries/typescript/symbols.scm`:
```scheme
(function_declaration name: (identifier) @name) @def.function
(class_declaration name: (type_identifier) @name) @def.class
(interface_declaration name: (type_identifier) @name) @def.interface
(type_alias_declaration name: (type_identifier) @name) @def.type
(enum_declaration name: (identifier) @name) @def.enum
(method_definition name: (property_identifier) @name) @def.method
(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @def.function
```

- [ ] **Step 3: Write the failing test**

`tests/parser-symbols.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { RepoParser } from '../src/parser/parser.js'

const SOURCE = `import { helper } from "./helper";
export interface Config { port: number }
export type Alias = string;
export enum Mode { A, B }
export class Service {
  run() { return helper(1); }
}
export const handler = async (req) => { return 1; };
function internal() { return 2; }
`

let parser: RepoParser

beforeAll(async () => { parser = await RepoParser.create() })

describe('symbol extraction', () => {
  it('extracts every top-level declaration with its kind', () => {
    const parsed = parser.parse('src/service.ts', SOURCE)
    const found = parsed.symbols.map(s => `${s.kind}:${s.name}`).sort()
    expect(found).toEqual([
      'class:Service',
      'enum:Mode',
      'function:handler',
      'function:internal',
      'interface:Config',
      'method:run',
      'type:Alias',
    ])
  })

  it('records export status', () => {
    const parsed = parser.parse('src/service.ts', SOURCE)
    const byName = new Map(parsed.symbols.map(s => [s.name, s]))
    expect(byName.get('Service')!.exported).toBe(true)
    expect(byName.get('handler')!.exported).toBe(true)
    expect(byName.get('internal')!.exported).toBe(false)
  })

  it('attributes methods to their enclosing class', () => {
    const parsed = parser.parse('src/service.ts', SOURCE)
    expect(parsed.symbols.find(s => s.name === 'run')!.parentName).toBe('Service')
    expect(parsed.symbols.find(s => s.name === 'internal')!.parentName).toBeNull()
  })

  it('records 1-based line spans', () => {
    const parsed = parser.parse('src/service.ts', SOURCE)
    const service = parsed.symbols.find(s => s.name === 'Service')!
    expect(service.startLine).toBe(5)
    expect(service.endLine).toBe(7)
  })

  it('sets lang to null and returns empty results for unknown extensions', () => {
    const parsed = parser.parse('README.md', '# hello')
    expect(parsed.lang).toBeNull()
    expect(parsed.symbols).toEqual([])
    expect(parsed.contentHash).toHaveLength(64)
  })

  it('produces a stable content hash', () => {
    const a = parser.parse('src/service.ts', SOURCE)
    const b = parser.parse('src/other.ts', SOURCE)
    expect(a.contentHash).toBe(b.contentHash)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/parser-symbols.test.ts`
Expected: FAIL — cannot resolve `../src/parser/parser.js`.

- [ ] **Step 5: Implement the parser**

`src/parser/parser.ts`:
```ts
import { Parser, Query, type Language, type Node } from 'web-tree-sitter'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LANGUAGES, languageForPath, loadLanguage, type LanguageDef } from './languages.js'
import type { ParsedFile, SourceSymbol, SymbolKind } from '../types.js'

interface Compiled {
  language: Language
  symbols: Query
}

export class RepoParser {
  private constructor(
    private readonly parser: Parser,
    private readonly compiled: Map<string, Compiled>,
  ) {}

  static async create(): Promise<RepoParser> {
    const compiled = new Map<string, Compiled>()
    for (const def of LANGUAGES) {
      const language = await loadLanguage(def)
      compiled.set(def.id, {
        language,
        symbols: new Query(language, readQuery(def, 'symbols')),
      })
    }
    return new RepoParser(new Parser(), compiled)
  }

  parse(path: string, source: string): ParsedFile {
    const contentHash = createHash('sha256').update(source).digest('hex')
    const def = languageForPath(path)
    if (!def) {
      return { path, lang: null, contentHash, symbols: [], imports: [], callSites: [], errors: [] }
    }

    const compiled = this.compiled.get(def.id)!
    this.parser.setLanguage(compiled.language)
    const tree = this.parser.parse(source)
    if (!tree) {
      return {
        path, lang: def.id, contentHash, symbols: [], imports: [], callSites: [],
        errors: [{ line: 1, message: 'parser returned no tree' }],
      }
    }

    try {
      return {
        path,
        lang: def.id,
        contentHash,
        symbols: extractSymbols(compiled.symbols, tree.rootNode),
        imports: [],
        callSites: [],
        errors: [],
      }
    } finally {
      tree.delete()
    }
  }
}

function readQuery(def: LanguageDef, name: string): string {
  return readFileSync(join(def.queryDir, `${name}.scm`), 'utf8')
}

function extractSymbols(query: Query, root: Node): SourceSymbol[] {
  const symbols: SourceSymbol[] = []
  for (const match of query.matches(root)) {
    const nameCapture = match.captures.find(c => c.name === 'name')
    const defCapture = match.captures.find(c => c.name.startsWith('def.'))
    if (!nameCapture || !defCapture) continue

    const kind = defCapture.name.slice('def.'.length) as SymbolKind
    const node = defCapture.node
    symbols.push({
      name: nameCapture.node.text,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(node),
      signature: signatureOf(node),
      parentName: kind === 'method' ? enclosingClassName(node) : null,
    })
  }
  return symbols
}

/**
 * A declaration is exported when an `export_statement` sits above it. For
 * `export const x = () => {}` the variable_declarator is two levels deeper
 * (declarator -> lexical_declaration -> export_statement), so walk a bounded
 * number of ancestors rather than assuming a fixed depth.
 */
function isExported(node: Node): boolean {
  let current: Node | null = node
  for (let depth = 0; current && depth < 3; depth++) {
    if (current.type === 'export_statement') return true
    current = current.parent
  }
  return false
}

function signatureOf(node: Node): string | null {
  const body = node.childForFieldName('body')
  const end = body ? body.startIndex : node.endIndex
  const text = node.text.slice(0, end - node.startIndex).trim()
  return text.length > 0 ? text.slice(0, 300) : null
}

function enclosingClassName(node: Node): string | null {
  let current = node.parent
  while (current) {
    if (current.type === 'class_declaration') {
      return current.childForFieldName('name')?.text ?? null
    }
    current = current.parent
  }
  return null
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/parser-symbols.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/parser/parser.ts src/parser/queries tests/parser-symbols.test.ts
git commit -m "feat: ParsedFile contract and symbol extraction"
```

---

### Task 3: Import and call-site extraction, with error recovery

**Files:**
- Create: `src/parser/queries/typescript/imports.scm`, `src/parser/queries/typescript/calls.scm`
- Modify: `src/parser/parser.ts`
- Test: `tests/parser-imports-calls.test.ts`

**Interfaces:**
- Consumes: `RepoParser`, `ParsedFile` from Task 2.
- Produces: `ParsedFile.imports`, `ParsedFile.callSites`, `ParsedFile.errors` populated.

- [ ] **Step 1: Write the query files**

`src/parser/queries/typescript/imports.scm`:
```scheme
(import_statement source: (string (string_fragment) @specifier)) @import.static
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @specifier))) @import.dynamic
(call_expression
  function: (identifier) @_fn
  arguments: (arguments (string (string_fragment) @specifier))
  (#eq? @_fn "require")) @import.require
```

`src/parser/queries/typescript/calls.scm`:
```scheme
(call_expression function: (identifier) @callee) @call
(call_expression function: (member_expression property: (property_identifier) @callee)) @call
(new_expression constructor: (identifier) @callee) @new
```

- [ ] **Step 2: Write the failing test**

`tests/parser-imports-calls.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { RepoParser } from '../src/parser/parser.js'

const SOURCE = `import { helper } from "./helper";
import fs from "node:fs";
const lazy = await import("./lazy");
const legacy = require("./legacy");
export class Service {
  run() { return helper(1); }
}
function internal() { return new Service(); }
topLevelCall();
`

let parser: RepoParser
beforeAll(async () => { parser = await RepoParser.create() })

describe('import extraction', () => {
  it('captures static, dynamic and require imports with their kind', () => {
    const imports = parser.parse('src/a.ts', SOURCE).imports
    expect(imports.map(i => `${i.kind}:${i.specifier}`).sort()).toEqual([
      'dynamic:./lazy',
      'require:./legacy',
      'static:./helper',
      'static:node:fs',
    ])
  })

  it('records 1-based import lines', () => {
    const imports = parser.parse('src/a.ts', SOURCE).imports
    expect(imports.find(i => i.specifier === './helper')!.line).toBe(1)
  })
})

describe('call-site extraction', () => {
  it('captures calls and attributes them to the enclosing symbol', () => {
    const calls = parser.parse('src/a.ts', SOURCE).callSites
    const byName = new Map(calls.map(c => [c.name, c]))
    expect(byName.get('helper')!.enclosingSymbol).toBe('run')
    expect(byName.get('Service')!.enclosingSymbol).toBe('internal')
    expect(byName.get('topLevelCall')!.enclosingSymbol).toBeNull()
  })

  it('distinguishes instantiation from invocation', () => {
    const calls = parser.parse('src/a.ts', SOURCE).callSites
    expect(calls.find(c => c.name === 'Service')!.kind).toBe('instantiates')
    expect(calls.find(c => c.name === 'helper')!.kind).toBe('calls')
  })

  it('excludes import mechanisms from call sites', () => {
    const calls = parser.parse('src/a.ts', SOURCE).callSites
    expect(calls.map(c => c.name)).not.toContain('require')
  })
})

describe('error recovery', () => {
  const BROKEN = `function good() { return 1; }
function BROKEN( { { {
`
  it('keeps symbols that parsed and records the error', () => {
    const parsed = parser.parse('src/broken.ts', BROKEN)
    expect(parsed.symbols.map(s => s.name)).toContain('good')
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(parsed.errors[0].line).toBe(2)
  })

  it('reports no errors for a clean file', () => {
    expect(parser.parse('src/a.ts', SOURCE).errors).toEqual([])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/parser-imports-calls.test.ts`
Expected: FAIL — `imports` and `callSites` are empty arrays.

- [ ] **Step 4: Extend the parser**

In `src/parser/parser.ts`, extend the `Compiled` interface and `create()`:

```ts
interface Compiled {
  language: Language
  symbols: Query
  imports: Query
  calls: Query
}
```

```ts
      compiled.set(def.id, {
        language,
        symbols: new Query(language, readQuery(def, 'symbols')),
        imports: new Query(language, readQuery(def, 'imports')),
        calls: new Query(language, readQuery(def, 'calls')),
      })
```

Replace the success return inside `parse()` with:

```ts
      return {
        path,
        lang: def.id,
        contentHash,
        symbols: extractSymbols(compiled.symbols, tree.rootNode),
        imports: extractImports(compiled.imports, tree.rootNode),
        callSites: extractCalls(compiled.calls, tree.rootNode),
        errors: extractErrors(tree.rootNode),
      }
```

Add these functions to the module:

```ts
import type { RawImport, CallSite, ParseError } from '../types.js'

/** Names that are import mechanisms, not real call targets. */
const IMPORT_MECHANISMS = new Set(['require', 'import'])

const ENCLOSING_SYMBOL_NODES = new Set([
  'function_declaration', 'method_definition', 'arrow_function', 'function_expression',
])

function extractImports(query: Query, root: Node): RawImport[] {
  const imports: RawImport[] = []
  for (const match of query.matches(root)) {
    const specifier = match.captures.find(c => c.name === 'specifier')
    const tagged = match.captures.find(c => c.name.startsWith('import.'))
    if (!specifier || !tagged) continue
    imports.push({
      specifier: specifier.node.text,
      kind: tagged.name.slice('import.'.length) as RawImport['kind'],
      line: tagged.node.startPosition.row + 1,
    })
  }
  return imports
}

function extractCalls(query: Query, root: Node): CallSite[] {
  const calls: CallSite[] = []
  for (const match of query.matches(root)) {
    const callee = match.captures.find(c => c.name === 'callee')
    const site = match.captures.find(c => c.name === 'call' || c.name === 'new')
    if (!callee || !site) continue
    if (IMPORT_MECHANISMS.has(callee.node.text)) continue
    calls.push({
      name: callee.node.text,
      line: callee.node.startPosition.row + 1,
      enclosingSymbol: enclosingSymbolName(callee.node),
      kind: site.name === 'new' ? 'instantiates' : 'calls',
    })
  }
  return calls
}

/**
 * Walk up to the nearest enclosing function-like node and read its name. An
 * arrow function assigned to a variable takes the variable's name, which is
 * how `export const handler = () => {}` gets attributed to `handler`.
 */
function enclosingSymbolName(node: Node): string | null {
  let current = node.parent
  while (current) {
    if (ENCLOSING_SYMBOL_NODES.has(current.type)) {
      const named = current.childForFieldName('name')
      if (named) return named.text
      if (current.parent?.type === 'variable_declarator') {
        return current.parent.childForFieldName('name')?.text ?? null
      }
    }
    current = current.parent
  }
  return null
}

function extractErrors(root: Node): ParseError[] {
  if (!root.hasError) return []
  return root.descendantsOfType('ERROR').map(node => ({
    line: node.startPosition.row + 1,
    message: `syntax error near ${JSON.stringify(node.text.slice(0, 40))}`,
  }))
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/parser-imports-calls.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests from Tasks 1–3.

- [ ] **Step 7: Commit**

```bash
git add src/parser tests/parser-imports-calls.test.ts
git commit -m "feat: import and call-site extraction with error recovery"
```

---

### Task 4: SQLite schema and node persistence

**Files:**
- Create: `src/store/schema.sql`, `src/store/graph-store.ts`
- Test: `tests/graph-store.test.ts`

**Interfaces:**
- Consumes: `ParsedFile`, `Confidence`, `EdgeKind` from Task 2.
- Produces: `GraphStore` with `static open(dbPath: string): GraphStore`, `insertParsedFiles(files: ParsedFile[]): void`, `fileIdByPath(path: string): number | undefined`, `allFilePaths(): string[]`, `symbolsByName(): Map<string, SymbolRow[]>`, `exportedSymbolsByFile(): Map<number, SymbolRow[]>`, `insertEdges(edges: EdgeInput[]): void`, `insertImports(imports: ImportInput[]): void`, `setMeta(key, value): void`, `getMeta(key): string | undefined`, `close(): void`. Row types `FileRow`, `SymbolRow`.

> **Schema note (refinement over spec §6):** `edges` gains a non-null `src_file_id` and a nullable `dst_file_id`, and `src_symbol_id` is nullable. Top-level calls have no enclosing symbol, so a non-null `src_symbol_id` could not represent them, and module-level aggregation needs a direct file join rather than a hop through `symbols`. The spec has been amended to match.

- [ ] **Step 1: Write the schema**

`src/store/schema.sql`:
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  lang          TEXT,
  content_hash  TEXT NOT NULL,
  loc           INTEGER NOT NULL DEFAULT 0,
  last_commit   TEXT,
  error_count   INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  exported    INTEGER NOT NULL DEFAULT 0,
  signature   TEXT,
  parent_name TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw_specifier    TEXT NOT NULL,
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL,
  confidence       TEXT NOT NULL,
  line             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id            INTEGER PRIMARY KEY,
  src_file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  src_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  dst_file_id   INTEGER REFERENCES files(id) ON DELETE SET NULL,
  dst_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  dst_name      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  confidence    TEXT NOT NULL,
  line          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  module_path TEXT NOT NULL,
  tree_hash   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (module_path, tree_hash)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_name     ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file     ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_src_symbol ON edges(src_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst_symbol ON edges(dst_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_src_file   ON edges(src_file_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst_file   ON edges(dst_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_file     ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_files_path       ON files(path);
```

- [ ] **Step 2: Write the failing test**

`tests/graph-store.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { GraphStore, SCHEMA_VERSION } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function parsedFile(path: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path,
    lang: 'typescript',
    contentHash: 'hash-' + path,
    symbols: [],
    imports: [],
    callSites: [],
    errors: [],
    ...overrides,
  }
}

describe('GraphStore', () => {
  it('creates the schema and stamps a version', () => {
    const store = GraphStore.open(':memory:')
    expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
    store.close()
  })

  it('persists files and symbols, and links them', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([
      parsedFile('src/a.ts', {
        symbols: [{
          name: 'foo', kind: 'function', startLine: 1, endLine: 3,
          exported: true, signature: 'function foo()', parentName: null,
        }],
      }),
    ])

    const fileId = store.fileIdByPath('src/a.ts')
    expect(fileId).toBeDefined()

    const byName = store.symbolsByName()
    expect(byName.get('foo')).toHaveLength(1)
    expect(byName.get('foo')![0].fileId).toBe(fileId)
    expect(byName.get('foo')![0].exported).toBe(true)
    store.close()
  })

  it('records error counts and unknown languages', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([
      parsedFile('README.md', { lang: null }),
      parsedFile('src/b.ts', { errors: [{ line: 2, message: 'boom' }] }),
    ])
    expect(store.allFilePaths().sort()).toEqual(['README.md', 'src/b.ts'])
    expect(store.fileRow('src/b.ts')!.errorCount).toBe(1)
    expect(store.fileRow('README.md')!.lang).toBeNull()
    store.close()
  })

  it('groups exported symbols by file', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([
      parsedFile('src/a.ts', {
        symbols: [
          { name: 'pub', kind: 'function', startLine: 1, endLine: 1, exported: true, signature: null, parentName: null },
          { name: 'priv', kind: 'function', startLine: 2, endLine: 2, exported: false, signature: null, parentName: null },
        ],
      }),
    ])
    const fileId = store.fileIdByPath('src/a.ts')!
    expect(store.exportedSymbolsByFile().get(fileId)!.map(s => s.name)).toEqual(['pub'])
    store.close()
  })

  it('stores edges including unresolved ones', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([parsedFile('src/a.ts')])
    const fileId = store.fileIdByPath('src/a.ts')!
    store.insertEdges([
      { srcFileId: fileId, srcSymbolId: null, dstFileId: null, dstSymbolId: null,
        dstName: 'externalThing', kind: 'calls', confidence: 'ambiguous', line: 4 },
    ])
    expect(store.edgeCount()).toBe(1)
    store.close()
  })

  it('is idempotent on re-insert of the same path', () => {
    const store = GraphStore.open(':memory:')
    store.insertParsedFiles([parsedFile('src/a.ts')])
    store.insertParsedFiles([parsedFile('src/a.ts')])
    expect(store.allFilePaths()).toEqual(['src/a.ts'])
    store.close()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/graph-store.test.ts`
Expected: FAIL — cannot resolve `../src/store/graph-store.js`.

- [ ] **Step 4: Implement GraphStore**

`src/store/graph-store.ts`:
```ts
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Confidence, EdgeKind, ParsedFile } from '../types.js'

export const SCHEMA_VERSION = 1

const here = dirname(fileURLToPath(import.meta.url))

export interface FileRow {
  id: number
  path: string
  lang: string | null
  contentHash: string
  loc: number
  errorCount: number
}

export interface SymbolRow {
  id: number
  fileId: number
  name: string
  kind: string
  startLine: number
  endLine: number
  exported: boolean
}

export interface EdgeInput {
  srcFileId: number
  srcSymbolId: number | null
  dstFileId: number | null
  dstSymbolId: number | null
  dstName: string
  kind: EdgeKind
  confidence: Confidence
  line: number
}

export interface ImportInput {
  fileId: number
  rawSpecifier: string
  resolvedFileId: number | null
  kind: string
  confidence: Confidence
  line: number
}

/** The only module in the project that touches SQLite. */
export class GraphStore {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath: string): GraphStore {
    const db = new Database(dbPath)
    db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))

    const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string } | undefined
    if (existing && Number(existing.value) !== SCHEMA_VERSION) {
      db.close()
      throw new Error(
        `Index schema version ${existing.value} does not match ${SCHEMA_VERSION}. Run "arch index --force" to rebuild.`,
      )
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION))

    return new GraphStore(db)
  }

  insertParsedFiles(files: ParsedFile[]): void {
    const deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?')
    const insertFile = this.db.prepare(`
      INSERT INTO files (path, lang, content_hash, loc, error_count, indexed_at)
      VALUES (@path, @lang, @contentHash, @loc, @errorCount, @indexedAt)
    `)
    const insertSymbol = this.db.prepare(`
      INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported, signature, parent_name)
      VALUES (@fileId, @name, @kind, @startLine, @endLine, @exported, @signature, @parentName)
    `)

    const run = this.db.transaction((batch: ParsedFile[]) => {
      const now = Date.now()
      for (const file of batch) {
        deleteFile.run(file.path)
        const { lastInsertRowid } = insertFile.run({
          path: file.path,
          lang: file.lang,
          contentHash: file.contentHash,
          loc: 0,
          errorCount: file.errors.length,
          indexedAt: now,
        })
        const fileId = Number(lastInsertRowid)
        for (const symbol of file.symbols) {
          insertSymbol.run({
            fileId,
            name: symbol.name,
            kind: symbol.kind,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            exported: symbol.exported ? 1 : 0,
            signature: symbol.signature,
            parentName: symbol.parentName,
          })
        }
      }
    })
    run(files)
  }

  insertImports(imports: ImportInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO imports (file_id, raw_specifier, resolved_file_id, kind, confidence, line)
      VALUES (@fileId, @rawSpecifier, @resolvedFileId, @kind, @confidence, @line)
    `)
    this.db.transaction((rows: ImportInput[]) => { for (const r of rows) stmt.run(r) })(imports)
  }

  insertEdges(edges: EdgeInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO edges (src_file_id, src_symbol_id, dst_file_id, dst_symbol_id, dst_name, kind, confidence, line)
      VALUES (@srcFileId, @srcSymbolId, @dstFileId, @dstSymbolId, @dstName, @kind, @confidence, @line)
    `)
    this.db.transaction((rows: EdgeInput[]) => { for (const r of rows) stmt.run(r) })(edges)
  }

  fileIdByPath(path: string): number | undefined {
    const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as { id: number } | undefined
    return row?.id
  }

  fileRow(path: string): FileRow | undefined {
    const row = this.db.prepare(
      'SELECT id, path, lang, content_hash, loc, error_count FROM files WHERE path = ?',
    ).get(path) as Record<string, unknown> | undefined
    return row ? toFileRow(row) : undefined
  }

  allFilePaths(): string[] {
    return (this.db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[])
      .map(r => r.path)
  }

  symbolsByName(): Map<string, SymbolRow[]> {
    const grouped = new Map<string, SymbolRow[]>()
    for (const row of this.allSymbolRows()) {
      const bucket = grouped.get(row.name)
      if (bucket) bucket.push(row)
      else grouped.set(row.name, [row])
    }
    return grouped
  }

  exportedSymbolsByFile(): Map<number, SymbolRow[]> {
    const grouped = new Map<number, SymbolRow[]>()
    for (const row of this.allSymbolRows()) {
      if (!row.exported) continue
      const bucket = grouped.get(row.fileId)
      if (bucket) bucket.push(row)
      else grouped.set(row.fileId, [row])
    }
    return grouped
  }

  symbolsByFile(): Map<number, SymbolRow[]> {
    const grouped = new Map<number, SymbolRow[]>()
    for (const row of this.allSymbolRows()) {
      const bucket = grouped.get(row.fileId)
      if (bucket) bucket.push(row)
      else grouped.set(row.fileId, [row])
    }
    return grouped
  }

  edgeCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string } | undefined
    return row?.value
  }

  analyze(): void {
    this.db.exec('ANALYZE')
  }

  close(): void {
    this.db.close()
  }

  private allSymbolRows(): SymbolRow[] {
    const rows = this.db.prepare(
      'SELECT id, file_id, name, kind, start_line, end_line, exported FROM symbols',
    ).all() as Record<string, unknown>[]
    return rows.map(r => ({
      id: r.id as number,
      fileId: r.file_id as number,
      name: r.name as string,
      kind: r.kind as string,
      startLine: r.start_line as number,
      endLine: r.end_line as number,
      exported: Boolean(r.exported),
    }))
  }
}

function toFileRow(r: Record<string, unknown>): FileRow {
  return {
    id: r.id as number,
    path: r.path as string,
    lang: (r.lang as string | null) ?? null,
    contentHash: r.content_hash as string,
    loc: r.loc as number,
    errorCount: r.error_count as number,
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/graph-store.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/store tests/graph-store.test.ts
git commit -m "feat: SQLite schema and graph store node persistence"
```

---

### Task 5: Repo source and file discovery

**Files:**
- Create: `src/repo/repo-source.ts`, `src/indexer/discover.ts`
- Create: `tests/fixture-builder.ts` (see Step 1)
- Test: `tests/discover.test.ts`

**Interfaces:**
- Consumes: `languageForPath` from Task 1.
- Produces: `indexPathFor(repoRoot: string): string`, `gitHeadCommit(repoRoot: string): string | null`, `isGitRepo(repoRoot: string): boolean`; `discoverFiles(repoRoot: string): DiscoveryResult` where `DiscoveryResult = { files: string[]; skipped: SkippedFile[] }` and `SkippedFile = { path: string; reason: SkipReason }`.

- [ ] **Step 1: Create the fixture builder**

The fixture is **generated into a temp directory at test time**, not committed. Committing it would place it inside this project's own git repository, where `git rev-parse --is-inside-work-tree` returns true and the outer `.gitignore` hides `node_modules` from `git ls-files` — the vendored-skip test would then silently test nothing. Generating it also lets one helper produce both a git and a non-git variant, so both discovery branches get exercised.

`tests/fixture-builder.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A small repository whose expected graph is hand-verified. */
export const FIXTURE_FILES: Record<string, string> = {
  'src/helper.ts': `export function helper(n: number): number {
  return n + 1;
}
export function unused(): void {}
`,
  'src/services/order.ts': `import { helper } from "../helper";
import { notify } from "./notify";

export class OrderService {
  place(quantity: number): number {
    notify("placed");
    return helper(quantity);
  }
}
`,
  'src/services/notify.ts': `export function notify(message: string): void {
  console.log(message);
}
`,
  'src/index.ts': `import { OrderService } from "./services/order";
import external from "node:fs";

const service = new OrderService();
service.place(2);
`,
  'README.md': '# fixture\n',
  'node_modules/pkg/index.js': 'module.exports = {};\n',
  'bundle.min.js': '!function(){var a=1;}();\n',
}

/**
 * Writes the fixture to a fresh temp directory and returns its path.
 * Pass `{ git: true }` to initialize a repository and commit, which routes
 * discovery through the `git ls-files` branch instead of the filesystem walk.
 */
export function buildFixture(options: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-fixture-'))

  for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }

  if (options.git) {
    const run = (args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'fixture@example.com'])
    run(['config', 'user.name', 'Fixture'])
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'fixture'])
  }

  return root
}
```

Note there is deliberately **no `.gitignore`** in the fixture, so `node_modules` is visible to both discovery branches and is excluded by the vendored-directory rule rather than by git. That is what the test needs to prove.

- [ ] **Step 2: Write the failing test**

`tests/discover.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { discoverFiles } from '../src/indexer/discover.js'
import { indexPathFor } from '../src/repo/repo-source.js'
import { buildFixture } from './fixture-builder.js'

const EXPECTED_FILES = [
  'README.md',
  'src/helper.ts',
  'src/index.ts',
  'src/services/notify.ts',
  'src/services/order.ts',
]

let plainRoot: string
let gitRoot: string

beforeAll(() => {
  plainRoot = buildFixture()
  gitRoot = buildFixture({ git: true })
})

describe('discoverFiles (filesystem walk)', () => {
  it('finds source files and the unknown-language README', () => {
    expect(discoverFiles(plainRoot).files.sort()).toEqual(EXPECTED_FILES)
  })

  it('skips vendored directories with a reason', () => {
    const { skipped } = discoverFiles(plainRoot)
    expect(skipped.find(s => s.path.startsWith('node_modules'))?.reason).toBe('vendored')
  })

  it('skips minified bundles with a reason', () => {
    const { skipped } = discoverFiles(plainRoot)
    expect(skipped.find(s => s.path === 'bundle.min.js')?.reason).toBe('minified')
  })

  it('never silently omits: every skipped entry carries a reason', () => {
    const { skipped } = discoverFiles(plainRoot)
    expect(skipped.length).toBeGreaterThan(0)
    for (const entry of skipped) expect(entry.reason).toBeTruthy()
  })
})

describe('discoverFiles (git ls-files)', () => {
  it('finds the same files as the filesystem walk', () => {
    expect(discoverFiles(gitRoot).files.sort()).toEqual(EXPECTED_FILES)
  })

  it('still skips vendored and minified files', () => {
    const reasons = new Set(discoverFiles(gitRoot).skipped.map(s => s.reason))
    expect(reasons.has('vendored')).toBe(true)
    expect(reasons.has('minified')).toBe(true)
  })
})

describe('indexPathFor', () => {
  it('is deterministic and repo-specific', () => {
    expect(indexPathFor('/a/b')).toBe(indexPathFor('/a/b'))
    expect(indexPathFor('/a/b')).not.toBe(indexPathFor('/a/c'))
    expect(indexPathFor('/a/b')).toMatch(/\.arch\/repos\/[0-9a-f]{16}\/index\.db$/)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/discover.test.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 4: Implement repo-source**

`src/repo/repo-source.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function indexPathFor(repoRoot: string): string {
  const digest = createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 16)
  return join(homedir(), '.arch', 'repos', digest, 'index.db')
}

export function isGitRepo(repoRoot: string): boolean {
  return git(repoRoot, ['rev-parse', '--is-inside-work-tree']) === 'true'
}

export function gitHeadCommit(repoRoot: string): string | null {
  return git(repoRoot, ['rev-parse', 'HEAD'])
}

/** Runs git, returning trimmed stdout or null when git fails for any reason. */
export function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Implement discovery**

> **Correction applied during execution.** The reference implementation below was
> found, in Task 5's review, to violate this plan's own never-silently-omit
> constraint in three places. All three were fixed before Task 5 was accepted; the
> text below is annotated but a reader should treat the shipped `src/indexer/discover.ts`
> as authoritative.
>
> 1. `statSync`'s `catch { continue }` dropped a candidate with no record in either
>    `files` or `skipped`. Reachable when a tracked file is deleted with `rm` rather
>    than `git rm`, and when the walk emits a `<directory>` marker for a gitignored
>    directory that is not a hardcoded vendored name. Fixed by recording `unreadable`,
>    and `not-a-file` when the path exists but is not a regular file.
> 2. `walkCandidates` admitted only `isDirectory()` or `isFile()` entries, so symlinks
>    never became candidates and could never be recorded as skipped. Fixed by admitting
>    symlinks and letting the post-stat classification handle them.
> 3. `binary` was a declared but unreachable `SkipReason`: a sub-1MB binary with an
>    unrecognized extension was indexed as source. Fixed with a NUL-byte sniff of the
>    first 8000 bytes for files with no known language.

`src/indexer/discover.ts`:
```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { git, isGitRepo } from '../repo/repo-source.js'
import { languageForPath } from '../parser/languages.js'

export type SkipReason =
  | 'vendored' | 'too-large' | 'minified' | 'binary' | 'unreadable' | 'not-a-file'

export interface SkippedFile {
  path: string
  reason: SkipReason
}

export interface DiscoveryResult {
  files: string[]
  skipped: SkippedFile[]
}

const VENDORED = new Set(['node_modules', 'vendor', 'dist', 'build', '.venv', 'venv', '.git', 'target'])
const MAX_BYTES = 1_000_000
const MAX_AVERAGE_LINE_LENGTH = 500

export function discoverFiles(repoRoot: string): DiscoveryResult {
  const candidates = isGitRepo(repoRoot) ? gitCandidates(repoRoot) : walkCandidates(repoRoot)

  const files: string[] = []
  const skipped: SkippedFile[] = []

  for (const path of candidates) {
    if (path.split(sep).some(segment => VENDORED.has(segment))) {
      skipped.push({ path, reason: 'vendored' })
      continue
    }

    const absolute = join(repoRoot, path)
    let size: number
    try {
      size = statSync(absolute).size
    } catch {
      continue
    }
    if (size > MAX_BYTES) {
      skipped.push({ path, reason: 'too-large' })
      continue
    }
    if (languageForPath(path) && isMinified(absolute, path)) {
      skipped.push({ path, reason: 'minified' })
      continue
    }
    files.push(path)
  }

  return { files, skipped }
}

/**
 * Tracked files plus untracked-but-not-ignored files. The second set matters:
 * a file created and not yet committed is exactly the file you want indexed.
 */
function gitCandidates(repoRoot: string): string[] {
  const tracked = git(repoRoot, ['ls-files']) ?? ''
  const untracked = git(repoRoot, ['ls-files', '--others', '--exclude-standard']) ?? ''
  const all = [...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean)
  return [...new Set(all)]
}

function walkCandidates(repoRoot: string): string[] {
  const ignored = readGitignoreDirectories(repoRoot)
  const out: string[] = []

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
      const absolute = join(dir, entry.name)
      const rel = relative(repoRoot, absolute)
      if (entry.isDirectory()) {
        // Skip vendored and gitignored trees without descending. Enumerating
        // node_modules would defeat the purpose; one marker entry satisfies the
        // never-silently-omit rule instead of thousands.
        if (VENDORED.has(entry.name) || ignored.has(entry.name)) {
          out.push(join(rel, '<directory>'))
          continue
        }
        visit(absolute)
      } else if (entry.isFile() && entry.name !== '.gitignore') {
        out.push(rel)
      }
    }
  }

  visit(repoRoot)
  return out
}

function readGitignoreDirectories(repoRoot: string): Set<string> {
  try {
    const lines = readFileSync(join(repoRoot, '.gitignore'), 'utf8').split('\n')
    return new Set(
      lines.map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/\/$/, '')),
    )
  } catch {
    return new Set()
  }
}

function isMinified(absolute: string, path: string): boolean {
  if (/\.min\.[a-z]+$/.test(path)) return true
  try {
    const source = readFileSync(absolute, 'utf8')
    const lines = source.split('\n')
    return source.length / Math.max(lines.length, 1) > MAX_AVERAGE_LINE_LENGTH
  } catch {
    return false
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/discover.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add src/repo src/indexer/discover.ts tests/fixture-builder.ts tests/discover.test.ts
git commit -m "feat: repo source resolution and file discovery"
```

---

### Task 6: Import resolution and confidence tiers

**Files:**
- Create: `src/indexer/resolve-imports.ts`
- Test: `tests/resolve-imports.test.ts`

**Interfaces:**
- Consumes: `RawImport` from Task 2, `ImportInput` from Task 4.
- Produces: `resolveImport(fromPath: string, specifier: string, knownPaths: Set<string>): ResolvedImport` where `ResolvedImport = { path: string | null; confidence: Confidence }`; `resolveImportsForFile(fromPath, imports, knownPaths)` returning `Array<{ raw: RawImport; resolvedPath: string | null; confidence: Confidence }>`.

- [ ] **Step 1: Write the failing test**

`tests/resolve-imports.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolveImport } from '../src/indexer/resolve-imports.js'

const KNOWN = new Set([
  'src/helper.ts',
  'src/services/order.ts',
  'src/services/notify.ts',
  'src/widgets/index.ts',
  'src/legacy.js',
])

describe('resolveImport', () => {
  it('resolves a relative sibling by probing extensions', () => {
    expect(resolveImport('src/services/order.ts', './notify', KNOWN))
      .toEqual({ path: 'src/services/notify.ts', confidence: 'resolved' })
  })

  it('resolves a parent-directory specifier', () => {
    expect(resolveImport('src/services/order.ts', '../helper', KNOWN))
      .toEqual({ path: 'src/helper.ts', confidence: 'resolved' })
  })

  it('resolves a directory to its index file', () => {
    expect(resolveImport('src/index.ts', './widgets', KNOWN))
      .toEqual({ path: 'src/widgets/index.ts', confidence: 'resolved' })
  })

  it('resolves an explicit .js specifier to the .ts source', () => {
    expect(resolveImport('src/index.ts', './helper.js', KNOWN).path).toBe('src/helper.ts')
  })

  it('leaves bare package specifiers unresolved', () => {
    expect(resolveImport('src/index.ts', 'react', KNOWN))
      .toEqual({ path: null, confidence: 'ambiguous' })
    expect(resolveImport('src/index.ts', 'node:fs', KNOWN))
      .toEqual({ path: null, confidence: 'ambiguous' })
  })

  it('leaves a relative specifier pointing nowhere unresolved', () => {
    expect(resolveImport('src/index.ts', './missing', KNOWN))
      .toEqual({ path: null, confidence: 'ambiguous' })
  })

  it('never resolves outside the set of indexed files', () => {
    expect(resolveImport('src/index.ts', '../../../etc/passwd', KNOWN).path).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/resolve-imports.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement import resolution**

`src/indexer/resolve-imports.ts`:
```ts
import { dirname, join, normalize } from 'node:path'
import type { Confidence, RawImport } from '../types.js'

export interface ResolvedImport {
  path: string | null
  confidence: Confidence
}

/** Extensions probed, in order, when a specifier carries none. */
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const INDEX_BASENAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs']

/**
 * Resolves against the set of *indexed* paths rather than the filesystem. This
 * is both faster and more correct: an import can only produce a graph edge if
 * its target is a file we actually indexed.
 */
export function resolveImport(
  fromPath: string,
  specifier: string,
  knownPaths: Set<string>,
): ResolvedImport {
  if (!specifier.startsWith('.')) {
    return { path: null, confidence: 'ambiguous' }
  }

  const base = normalize(join(dirname(fromPath), specifier)).replace(/\\/g, '/')
  if (base.startsWith('..')) {
    return { path: null, confidence: 'ambiguous' }
  }

  for (const candidate of candidatesFor(base)) {
    if (knownPaths.has(candidate)) {
      return { path: candidate, confidence: 'resolved' }
    }
  }
  return { path: null, confidence: 'ambiguous' }
}

function* candidatesFor(base: string): Generator<string> {
  yield base

  // TypeScript source for an explicit JS specifier: "./helper.js" -> "./helper.ts"
  const jsExtension = /\.(js|jsx|mjs|cjs)$/.exec(base)
  if (jsExtension) {
    const stem = base.slice(0, -jsExtension[0].length)
    for (const ext of PROBE_EXTENSIONS) yield stem + ext
  }

  for (const ext of PROBE_EXTENSIONS) yield base + ext
  for (const basename of INDEX_BASENAMES) yield `${base}/${basename}`
}

export function resolveImportsForFile(
  fromPath: string,
  imports: RawImport[],
  knownPaths: Set<string>,
): Array<{ raw: RawImport; resolvedPath: string | null; confidence: Confidence }> {
  return imports.map(raw => {
    const { path, confidence } = resolveImport(fromPath, raw.specifier, knownPaths)
    return { raw, resolvedPath: path, confidence }
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/resolve-imports.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/resolve-imports.ts tests/resolve-imports.test.ts
git commit -m "feat: import resolution with confidence tiers"
```

---

### Task 7: Call resolution

The highest-risk logic in the project, and the densest tests. The three outcomes — one candidate, several, none — are the whole confidence system.

**Files:**
- Create: `src/indexer/resolve-calls.ts`
- Test: `tests/resolve-calls.test.ts`

**Interfaces:**
- Consumes: `SymbolRow` and `EdgeInput` from Task 4, `CallSite` from Task 2.
- Produces: `buildCandidateIndex(input: CandidateIndexInput): CandidateIndex`, `resolveCallsForFile(args: ResolveCallsArgs): EdgeInput[]`.

- [ ] **Step 1: Write the failing test**

`tests/resolve-calls.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolveCallsForFile } from '../src/indexer/resolve-calls.js'
import type { SymbolRow } from '../src/store/graph-store.js'
import type { CallSite } from '../src/types.js'

function symbol(id: number, fileId: number, name: string, exported = true): SymbolRow {
  return { id, fileId, name, kind: 'function', startLine: 1, endLine: 2, exported }
}

// file 1 = caller.ts, file 2 = helper.ts, file 3 = other.ts
const localSymbols = [symbol(10, 1, 'localFn', false)]
const exportedByFile = new Map<number, SymbolRow[]>([
  [2, [symbol(20, 2, 'helper')]],
  [3, [symbol(30, 3, 'helper')]],
])

function call(name: string, enclosing: string | null = null): CallSite {
  return { name, line: 5, enclosingSymbol: enclosing, kind: 'calls' }
}

describe('resolveCallsForFile', () => {
  it('marks a single candidate as heuristic', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ dstSymbolId: 20, dstFileId: 2, confidence: 'heuristic' })
  })

  it('fans out to every candidate and marks them ambiguous', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2, 3],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(2)
    expect(edges.every(e => e.confidence === 'ambiguous')).toBe(true)
    expect(edges.map(e => e.dstSymbolId).sort()).toEqual([20, 30])
  })

  it('prefers a local declaration over imports and treats it as unambiguous', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols: [symbol(10, 1, 'helper', false)],
      importedFileIds: [2, 3],
      exportedByFile,
      callSites: [call('helper')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ dstSymbolId: 10, confidence: 'heuristic' })
  })

  it('records an unresolved edge when nothing matches', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [],
      exportedByFile,
      callSites: [call('console')],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      dstSymbolId: null, dstFileId: null, dstName: 'console', confidence: 'ambiguous',
    })
  })

  it('attributes the edge to the enclosing symbol when there is one', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper', 'localFn')],
    })
    expect(edges[0].srcSymbolId).toBe(10)
  })

  it('leaves srcSymbolId null for a top-level call but always sets srcFileId', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [call('helper', null)],
    })
    expect(edges[0].srcSymbolId).toBeNull()
    expect(edges[0].srcFileId).toBe(1)
  })

  it('maps instantiation call sites to the instantiates edge kind', () => {
    const edges = resolveCallsForFile({
      srcFileId: 1,
      localSymbols,
      importedFileIds: [2],
      exportedByFile,
      callSites: [{ name: 'helper', line: 9, enclosingSymbol: null, kind: 'instantiates' }],
    })
    expect(edges[0].kind).toBe('instantiates')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/resolve-calls.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement call resolution**

`src/indexer/resolve-calls.ts`:
```ts
import type { EdgeInput, SymbolRow } from '../store/graph-store.js'
import type { CallSite } from '../types.js'

export interface ResolveCallsArgs {
  srcFileId: number
  /** Every symbol declared in the source file. */
  localSymbols: SymbolRow[]
  /** File ids this file imports through `resolved` imports. */
  importedFileIds: number[]
  /** Exported symbols grouped by file id, for the whole repository. */
  exportedByFile: Map<number, SymbolRow[]>
  callSites: CallSite[]
}

/**
 * Spec §6.3. The candidate set for a call is: symbols declared in this file,
 * plus symbols exported by files this file resolves an import to.
 *
 * One candidate  -> `heuristic`
 * Several        -> `ambiguous`, fanned out to all of them
 * None           -> an unresolved edge carrying only the name
 *
 * Ambiguous matches are stored, never dropped. Under-reporting on "what could
 * break?" is the failure that destroys trust; over-reporting with a label does not.
 */
export function resolveCallsForFile(args: ResolveCallsArgs): EdgeInput[] {
  const { srcFileId, localSymbols, importedFileIds, exportedByFile, callSites } = args

  const localByName = groupByName(localSymbols)

  const importedByName = new Map<string, SymbolRow[]>()
  for (const fileId of importedFileIds) {
    for (const symbol of exportedByFile.get(fileId) ?? []) {
      const bucket = importedByName.get(symbol.name)
      if (bucket) bucket.push(symbol)
      else importedByName.set(symbol.name, [symbol])
    }
  }

  const symbolIdByName = new Map(localSymbols.map(s => [s.name, s.id]))
  const edges: EdgeInput[] = []

  for (const site of callSites) {
    const srcSymbolId = site.enclosingSymbol
      ? symbolIdByName.get(site.enclosingSymbol) ?? null
      : null

    // A local declaration shadows imports, so it wins outright rather than
    // producing a spurious ambiguity.
    const candidates = localByName.get(site.name) ?? importedByName.get(site.name) ?? []

    if (candidates.length === 0) {
      edges.push({
        srcFileId,
        srcSymbolId,
        dstFileId: null,
        dstSymbolId: null,
        dstName: site.name,
        kind: site.kind,
        confidence: 'ambiguous',
        line: site.line,
      })
      continue
    }

    const confidence = candidates.length === 1 ? 'heuristic' : 'ambiguous'
    for (const candidate of candidates) {
      edges.push({
        srcFileId,
        srcSymbolId,
        dstFileId: candidate.fileId,
        dstSymbolId: candidate.id,
        dstName: site.name,
        kind: site.kind,
        confidence,
        line: site.line,
      })
    }
  }

  return edges
}

function groupByName(symbols: SymbolRow[]): Map<string, SymbolRow[]> {
  const grouped = new Map<string, SymbolRow[]>()
  for (const symbol of symbols) {
    const bucket = grouped.get(symbol.name)
    if (bucket) bucket.push(symbol)
    else grouped.set(symbol.name, [symbol])
  }
  return grouped
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/resolve-calls.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/resolve-calls.ts tests/resolve-calls.test.ts
git commit -m "feat: call resolution with heuristic and ambiguous tiers"
```

---

### Task 8: The cold index pipeline

**Files:**
- Create: `src/indexer/pipeline.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `runColdIndex(options: ColdIndexOptions): Promise<IndexReport>` where `ColdIndexOptions = { repoRoot: string; dbPath: string; batchSize?: number }` and `IndexReport = { filesIndexed: number; filesSkipped: number; symbols: number; edges: number; parseErrors: number; durationMs: number }`.

- [ ] **Step 1: Write the failing test**

`tests/pipeline.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import type { IndexReport } from '../src/indexer/pipeline.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string
let report: IndexReport
let store: GraphStore

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-')), 'index.db')
  report = await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('cold index', () => {
  it('indexes every discovered file', () => {
    expect(report.filesIndexed).toBe(5)
    expect(store.allFilePaths()).toContain('src/services/order.ts')
  })

  it('records the README with a null language rather than omitting it', () => {
    expect(store.fileRow('README.md')!.lang).toBeNull()
  })

  it('reports skipped files', () => {
    expect(report.filesSkipped).toBeGreaterThan(0)
  })

  it('resolves a relative import to a concrete file', () => {
    const orderId = store.fileIdByPath('src/services/order.ts')!
    const helperId = store.fileIdByPath('src/helper.ts')!
    const resolved = store.importsForFile(orderId)
    const helperImport = resolved.find(i => i.rawSpecifier === '../helper')!
    expect(helperImport.resolvedFileId).toBe(helperId)
    expect(helperImport.confidence).toBe('resolved')
  })

  it('leaves a bare package specifier unresolved', () => {
    const indexId = store.fileIdByPath('src/index.ts')!
    const fsImport = store.importsForFile(indexId).find(i => i.rawSpecifier === 'node:fs')!
    expect(fsImport.resolvedFileId).toBeNull()
  })

  it('builds a call edge from OrderService.place to helper', () => {
    const helperId = store.fileIdByPath('src/helper.ts')!
    const edges = store.edgesInto(helperId)
    const toHelper = edges.find(e => e.dstName === 'helper')!
    expect(toHelper.confidence).toBe('heuristic')
    expect(toHelper.srcFileId).toBe(store.fileIdByPath('src/services/order.ts')!)
  })

  it('records unresolved external calls without dropping them', () => {
    const all = store.allEdges()
    expect(all.some(e => e.dstName === 'log' && e.dstSymbolId === null)).toBe(true)
  })

  it('writes head_commit only after a successful run', () => {
    expect(store.getMeta('indexed_at')).toBeDefined()
    expect(store.getMeta('files_indexed')).toBe('5')
  })

  it('produces an identical graph when run twice', async () => {
    const before = { files: store.allFilePaths(), edges: store.edgeCount() }
    await runColdIndex({ repoRoot: fixture, dbPath })
    const after = GraphStore.open(dbPath)
    expect(after.allFilePaths()).toEqual(before.files)
    expect(after.edgeCount()).toBe(before.edges)
    after.close()
  })
})
```

- [ ] **Step 2: Add the read helpers GraphStore is missing**

Append these methods to `GraphStore` in `src/store/graph-store.ts`:

```ts
  importsForFile(fileId: number): Array<{ rawSpecifier: string; resolvedFileId: number | null; confidence: string }> {
    const rows = this.db.prepare(
      'SELECT raw_specifier, resolved_file_id, confidence FROM imports WHERE file_id = ?',
    ).all(fileId) as Record<string, unknown>[]
    return rows.map(r => ({
      rawSpecifier: r.raw_specifier as string,
      resolvedFileId: (r.resolved_file_id as number | null) ?? null,
      confidence: r.confidence as string,
    }))
  }

  edgesInto(fileId: number): EdgeRow[] {
    return this.toEdgeRows(this.db.prepare(EDGE_SELECT + ' WHERE dst_file_id = ?').all(fileId))
  }

  allEdges(): EdgeRow[] {
    return this.toEdgeRows(this.db.prepare(EDGE_SELECT).all())
  }

  clear(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;')
  }

  private toEdgeRows(rows: unknown[]): EdgeRow[] {
    return (rows as Record<string, unknown>[]).map(r => ({
      srcFileId: r.src_file_id as number,
      srcSymbolId: (r.src_symbol_id as number | null) ?? null,
      dstFileId: (r.dst_file_id as number | null) ?? null,
      dstSymbolId: (r.dst_symbol_id as number | null) ?? null,
      dstName: r.dst_name as string,
      kind: r.kind as EdgeKind,
      confidence: r.confidence as Confidence,
      line: r.line as number,
    }))
  }
```

Add alongside the other exports in the same file:

```ts
const EDGE_SELECT =
  'SELECT src_file_id, src_symbol_id, dst_file_id, dst_symbol_id, dst_name, kind, confidence, line FROM edges'

export interface EdgeRow {
  srcFileId: number
  srcSymbolId: number | null
  dstFileId: number | null
  dstSymbolId: number | null
  dstName: string
  kind: EdgeKind
  confidence: Confidence
  line: number
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: FAIL — cannot resolve `../src/indexer/pipeline.js`.

- [ ] **Step 4: Implement the pipeline**

`src/indexer/pipeline.ts`:
```ts
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RepoParser } from '../parser/parser.js'
import { GraphStore, type EdgeInput, type ImportInput } from '../store/graph-store.js'
import { gitHeadCommit } from '../repo/repo-source.js'
import { discoverFiles } from './discover.js'
import { resolveImport } from './resolve-imports.js'
import { resolveCallsForFile } from './resolve-calls.js'
import type { ParsedFile } from '../types.js'

export interface ColdIndexOptions {
  repoRoot: string
  dbPath: string
  batchSize?: number
  onProgress?: (message: string) => void
}

export interface IndexReport {
  filesIndexed: number
  filesSkipped: number
  symbols: number
  edges: number
  parseErrors: number
  durationMs: number
}

const DEFAULT_BATCH_SIZE = 500

export async function runColdIndex(options: ColdIndexOptions): Promise<IndexReport> {
  const { repoRoot, dbPath, batchSize = DEFAULT_BATCH_SIZE, onProgress } = options
  const startedAt = Date.now()

  mkdirSync(dirname(dbPath), { recursive: true })
  const store = GraphStore.open(dbPath)

  try {
    // Phase 6's guarantee starts here: clear head_commit so an interrupted run
    // is visibly incomplete rather than silently half-written.
    store.setMeta('head_commit', '')
    store.clear()

    // Phase 1 — discover
    const { files, skipped } = discoverFiles(repoRoot)
    onProgress?.(`discovered ${files.length} files, skipped ${skipped.length}`)

    // Phases 2–3 — parse and persist nodes, in batches, discarding ASTs
    const parser = await RepoParser.create()
    let parseErrors = 0
    let symbolCount = 0

    for (let start = 0; start < files.length; start += batchSize) {
      const batch: ParsedFile[] = []
      for (const path of files.slice(start, start + batchSize)) {
        const parsed = parseOne(parser, repoRoot, path)
        parseErrors += parsed.errors.length
        symbolCount += parsed.symbols.length
        batch.push(parsed)
      }
      store.insertParsedFiles(batch)
      onProgress?.(`parsed ${Math.min(start + batchSize, files.length)}/${files.length}`)
    }

    // Phase 4a — resolve imports
    const knownPaths = new Set(store.allFilePaths())
    const fileIdByPath = new Map<string, number>()
    for (const path of knownPaths) fileIdByPath.set(path, store.fileIdByPath(path)!)

    const importRows: ImportInput[] = []
    const importedFileIds = new Map<number, number[]>()

    for (const path of files) {
      const fileId = fileIdByPath.get(path)
      if (fileId === undefined) continue
      const parsed = parseOne(parser, repoRoot, path)
      const targets: number[] = []

      for (const raw of parsed.imports) {
        const { path: resolvedPath, confidence } = resolveImport(path, raw.specifier, knownPaths)
        const resolvedFileId = resolvedPath ? fileIdByPath.get(resolvedPath) ?? null : null
        if (resolvedFileId !== null) targets.push(resolvedFileId)
        importRows.push({
          fileId,
          rawSpecifier: raw.specifier,
          resolvedFileId,
          kind: raw.kind,
          confidence,
          line: raw.line,
        })
      }
      importedFileIds.set(fileId, targets)
    }
    store.insertImports(importRows)

    // Phase 4b — resolve calls against the now-complete symbol table
    const symbolsByFile = store.symbolsByFile()
    const exportedByFile = store.exportedSymbolsByFile()
    const edges: EdgeInput[] = []

    for (const path of files) {
      const fileId = fileIdByPath.get(path)
      if (fileId === undefined) continue
      const parsed = parseOne(parser, repoRoot, path)
      if (parsed.callSites.length === 0) continue

      edges.push(...resolveCallsForFile({
        srcFileId: fileId,
        localSymbols: symbolsByFile.get(fileId) ?? [],
        importedFileIds: importedFileIds.get(fileId) ?? [],
        exportedByFile,
        callSites: parsed.callSites,
      }))
    }

    // Phase 5 — persist edges
    store.insertEdges(edges)

    // Phase 6 — finalize. head_commit is written last and only on success.
    store.analyze()
    store.setMeta('indexed_at', String(Date.now()))
    store.setMeta('files_indexed', String(files.length))
    store.setMeta('files_skipped', String(skipped.length))
    store.setMeta('repo_root', repoRoot)
    store.setMeta('head_commit', gitHeadCommit(repoRoot) ?? '')

    return {
      filesIndexed: files.length,
      filesSkipped: skipped.length,
      symbols: symbolCount,
      edges: edges.length,
      parseErrors,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    store.close()
  }
}

function parseOne(parser: RepoParser, repoRoot: string, path: string): ParsedFile {
  let source: string
  try {
    source = readFileSync(join(repoRoot, path), 'utf8')
  } catch {
    source = ''
  }
  return parser.parse(path, source)
}
```

Note: this first implementation reparses each file in the resolve phases. That is deliberately naive and gets fixed in Task 9, where the parse pool retains `ParsedFile` records (not ASTs) for the whole run. Correctness first, then the optimization, with the same tests guarding both.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests from Tasks 1–8.

- [ ] **Step 7: Commit**

```bash
git add src/indexer/pipeline.ts src/store/graph-store.ts tests/pipeline.test.ts
git commit -m "feat: cold index pipeline end to end"
```

---

### Task 9: Single-pass parsing with a worker pool

Two changes at once because they share one test: parse each file exactly once, and do it across cores.

**Files:**
- Create: `src/indexer/parse-pool.ts`, `src/indexer/parse-worker.ts`
- Modify: `src/indexer/pipeline.ts`
- Test: `tests/parse-pool.test.ts`

**Interfaces:**
- Consumes: `ParsedFile` from Task 2.
- Produces: `parseAll(args: ParseAllArgs): Promise<ParsedFile[]>` where `ParseAllArgs = { repoRoot: string; paths: string[]; concurrency?: number; onBatch?: (done: number, total: number) => void }`.

- [ ] **Step 1: Write the failing test**

`tests/parse-pool.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { parseAll } from '../src/indexer/parse-pool.js'
import { RepoParser } from '../src/parser/parser.js'
import { buildFixture } from './fixture-builder.js'

const FIXTURE = buildFixture()
const PATHS = ['src/helper.ts', 'src/index.ts', 'src/services/notify.ts', 'src/services/order.ts']

describe('parseAll', () => {
  it('returns one record per input path, in input order', async () => {
    const parsed = await parseAll({ repoRoot: FIXTURE, paths: PATHS })
    expect(parsed.map(p => p.path)).toEqual(PATHS)
  })

  it('produces results identical to single-threaded parsing', async () => {
    const pooled = await parseAll({ repoRoot: FIXTURE, paths: PATHS })
    const parser = await RepoParser.create()
    const direct = PATHS.map(p => parser.parse(p, readFileSync(join(FIXTURE, p), 'utf8')))
    expect(pooled).toEqual(direct)
  })

  it('handles an empty input list', async () => {
    expect(await parseAll({ repoRoot: FIXTURE, paths: [] })).toEqual([])
  })

  it('records an unreadable file as an error rather than throwing', async () => {
    const parsed = await parseAll({ repoRoot: FIXTURE, paths: ['src/does-not-exist.ts'] })
    expect(parsed).toHaveLength(1)
    expect(parsed[0].errors.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/parse-pool.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the worker**

`src/indexer/parse-worker.ts`:
```ts
import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoParser } from '../parser/parser.js'
import type { ParsedFile } from '../types.js'

interface WorkerData {
  repoRoot: string
  paths: string[]
}

const { repoRoot, paths } = workerData as WorkerData

const results: ParsedFile[] = []
const parser = await RepoParser.create()

for (const path of paths) {
  results.push(parseOne(parser, repoRoot, path))
}

parentPort!.postMessage(results)

function parseOne(parser: RepoParser, repoRoot: string, path: string): ParsedFile {
  try {
    return parser.parse(path, readFileSync(join(repoRoot, path), 'utf8'))
  } catch (error) {
    return {
      path,
      lang: null,
      contentHash: '',
      symbols: [],
      imports: [],
      callSites: [],
      errors: [{ line: 1, message: `unreadable: ${(error as Error).message}` }],
    }
  }
}
```

- [ ] **Step 4: Implement the pool**

`src/indexer/parse-pool.ts`:
```ts
import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ParsedFile } from '../types.js'

const here = dirname(fileURLToPath(import.meta.url))
const WORKER_PATH = join(here, 'parse-worker.js')

export interface ParseAllArgs {
  repoRoot: string
  paths: string[]
  concurrency?: number
  onBatch?: (done: number, total: number) => void
}

/**
 * Parses every path across a worker pool and returns records in input order.
 * ASTs never cross the thread boundary and are never retained — only the
 * normalized ParsedFile records are, which is what bounds memory.
 */
export async function parseAll(args: ParseAllArgs): Promise<ParsedFile[]> {
  const { repoRoot, paths, onBatch } = args
  if (paths.length === 0) return []

  const workers = Math.max(1, Math.min(args.concurrency ?? availableParallelism() - 1, paths.length))
  const chunks = chunkInto(paths, workers)

  let done = 0
  const settled = await Promise.all(
    chunks.map(chunk =>
      runChunk(repoRoot, chunk).then(result => {
        done += chunk.length
        onBatch?.(done, paths.length)
        return result
      }),
    ),
  )

  return settled.flat()
}

function runChunk(repoRoot: string, paths: string[]): Promise<ParsedFile[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { repoRoot, paths } })
    let received: ParsedFile[] | null = null

    worker.on('message', (message: ParsedFile[]) => { received = message })
    worker.on('error', reject)
    worker.on('exit', code => {
      if (received) resolve(received)
      else reject(new Error(`parse worker exited with code ${code} before reporting`))
    })
  })
}

/** Contiguous chunks, so results concatenate back into input order. */
function chunkInto<T>(items: T[], count: number): T[][] {
  const size = Math.ceil(items.length / count)
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size))
  }
  return chunks
}
```

Because workers load compiled JavaScript, the pool tests require a build. Add to `package.json` scripts:

```json
    "pretest": "tsc -p tsconfig.json"
```

and point `WORKER_PATH` at the compiled output, which the `dist`-relative `import.meta.url` already does once `src/indexer/parse-pool.ts` is compiled to `dist/indexer/parse-pool.js`.

For vitest (which runs TypeScript directly from `src`), resolve the worker path against `dist` explicitly:

```ts
// Workers execute compiled JavaScript. Under vitest this module runs from
// src/, so redirect to the built worker in dist/.
const WORKER_PATH = here.includes(`${sep}dist${sep}`)
  ? join(here, 'parse-worker.js')
  : join(here, '..', '..', 'dist', 'indexer', 'parse-worker.js')
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/parse-pool.test.ts`
Expected: PASS, 4 tests (`pretest` builds `dist` first).

- [ ] **Step 6: Rewrite the pipeline to parse once**

In `src/indexer/pipeline.ts`, replace the three separate `parseOne` loops with a single parse followed by reuse. Replace everything from the `// Phases 2–3` comment through the end of the `// Phase 4b` loop with:

```ts
    // Phase 2 — parse once, across cores
    const parsed = await parseAll({
      repoRoot,
      paths: files,
      onBatch: (done, total) => onProgress?.(`parsed ${done}/${total}`),
    })

    let parseErrors = 0
    let symbolCount = 0
    for (const file of parsed) {
      parseErrors += file.errors.length
      symbolCount += file.symbols.length
    }

    // Phase 3 — persist nodes in batches
    for (let start = 0; start < parsed.length; start += batchSize) {
      store.insertParsedFiles(parsed.slice(start, start + batchSize))
    }

    // Phase 4a — resolve imports
    const knownPaths = new Set(store.allFilePaths())
    const fileIdByPath = new Map<string, number>()
    for (const path of knownPaths) fileIdByPath.set(path, store.fileIdByPath(path)!)

    const importRows: ImportInput[] = []
    const importedFileIds = new Map<number, number[]>()

    for (const file of parsed) {
      const fileId = fileIdByPath.get(file.path)
      if (fileId === undefined) continue
      const targets: number[] = []

      for (const raw of file.imports) {
        const { path: resolvedPath, confidence } = resolveImport(file.path, raw.specifier, knownPaths)
        const resolvedFileId = resolvedPath ? fileIdByPath.get(resolvedPath) ?? null : null
        if (resolvedFileId !== null) targets.push(resolvedFileId)
        importRows.push({
          fileId,
          rawSpecifier: raw.specifier,
          resolvedFileId,
          kind: raw.kind,
          confidence,
          line: raw.line,
        })
      }
      importedFileIds.set(fileId, targets)
    }
    store.insertImports(importRows)

    // Phase 4b — resolve calls against the now-complete symbol table
    const symbolsByFile = store.symbolsByFile()
    const exportedByFile = store.exportedSymbolsByFile()
    const edges: EdgeInput[] = []

    for (const file of parsed) {
      const fileId = fileIdByPath.get(file.path)
      if (fileId === undefined || file.callSites.length === 0) continue
      edges.push(...resolveCallsForFile({
        srcFileId: fileId,
        localSymbols: symbolsByFile.get(fileId) ?? [],
        importedFileIds: importedFileIds.get(fileId) ?? [],
        exportedByFile,
        callSites: file.callSites,
      }))
    }
```

Add the import and delete the now-unused `parseOne` helper and the `RepoParser`/`readFileSync` imports:

```ts
import { parseAll } from './parse-pool.js'
```

- [ ] **Step 7: Run the whole suite to confirm no behavior changed**

Run: `npm test`
Expected: PASS. Task 8's nine pipeline tests must still pass unchanged — that is the point of doing the optimization behind an existing test suite.

- [ ] **Step 8: Commit**

```bash
git add src/indexer/parse-pool.ts src/indexer/parse-worker.ts src/indexer/pipeline.ts package.json tests/parse-pool.test.ts
git commit -m "perf: parse each file once across a worker pool"
```

---

### Task 10: The CLI

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `runColdIndex` from Task 8, `indexPathFor` from Task 5, `GraphStore` from Task 4.
- Produces: `arch index [repo]` and `arch status [repo]` executables.

- [ ] **Step 1: Write the failing test**

`tests/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { buildFixture } from './fixture-builder.js'

const FIXTURE = buildFixture({ git: true })
const CLI = join(process.cwd(), 'dist/cli.js')

function run(args: string[]): string {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8' })
}

describe('arch CLI', () => {
  it('indexes a repository and reports counts', () => {
    const output = run(['index', FIXTURE])
    expect(output).toMatch(/Indexed 5 files/)
    expect(output).toMatch(/symbols/)
    expect(output).toMatch(/edges/)
  })

  it('reports status for an indexed repository', () => {
    run(['index', FIXTURE])
    const output = run(['status', FIXTURE])
    expect(output).toMatch(/Files:\s+5/)
    expect(output).toMatch(/Index:/)
  })

  it('reports a clear message for a repository with no index', () => {
    const output = run(['status', buildFixture()])
    expect(output).toMatch(/No index/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/cli.test.ts`
Expected: FAIL — `dist/cli.js` does not exist.

- [ ] **Step 3: Implement the CLI**

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { runColdIndex } from './indexer/pipeline.js'
import { indexPathFor, gitHeadCommit } from './repo/repo-source.js'
import { GraphStore } from './store/graph-store.js'

const program = new Command()

program
  .name('arch')
  .description('Index a repository into a queryable architecture graph')
  .version('0.1.0')

program
  .command('index')
  .argument('[repo]', 'path to the repository', '.')
  .option('-q, --quiet', 'suppress progress output')
  .description('Build the index for a repository')
  .action(async (repo: string, options: { quiet?: boolean }) => {
    const repoRoot = resolve(repo)
    const dbPath = indexPathFor(repoRoot)

    const report = await runColdIndex({
      repoRoot,
      dbPath,
      onProgress: options.quiet ? undefined : message => process.stderr.write(`  ${message}\n`),
    })

    console.log(
      `Indexed ${report.filesIndexed} files ` +
      `(${report.symbols} symbols, ${report.edges} edges) ` +
      `in ${(report.durationMs / 1000).toFixed(1)}s`,
    )
    if (report.filesSkipped > 0) console.log(`Skipped ${report.filesSkipped} files`)
    if (report.parseErrors > 0) console.log(`${report.parseErrors} parse errors (partial results kept)`)
    console.log(`Index: ${dbPath}`)
  })

program
  .command('status')
  .argument('[repo]', 'path to the repository', '.')
  .description('Report index freshness for a repository')
  .action((repo: string) => {
    const repoRoot = resolve(repo)
    const dbPath = indexPathFor(repoRoot)

    if (!existsSync(dbPath)) {
      console.log(`No index for ${repoRoot}. Run "arch index ${repo}" first.`)
      return
    }

    const store = GraphStore.open(dbPath)
    try {
      const indexedHead = store.getMeta('head_commit') ?? ''
      const currentHead = gitHeadCommit(repoRoot) ?? ''
      const indexedAt = store.getMeta('indexed_at')

      console.log(`Repo:    ${repoRoot}`)
      console.log(`Index:   ${dbPath}`)
      console.log(`Files:   ${store.getMeta('files_indexed') ?? '0'}`)
      console.log(`Skipped: ${store.getMeta('files_skipped') ?? '0'}`)
      console.log(`Edges:   ${store.edgeCount()}`)
      console.log(`Built:   ${indexedAt ? new Date(Number(indexedAt)).toISOString() : 'unknown'}`)

      if (indexedHead === '') {
        console.log('State:   INCOMPLETE — a previous index did not finish. Re-run "arch index".')
      } else if (currentHead && currentHead !== indexedHead) {
        console.log(`State:   STALE — indexed at ${indexedHead.slice(0, 8)}, HEAD is ${currentHead.slice(0, 8)}.`)
      } else {
        console.log('State:   current')
      }
    } finally {
      store.close()
    }
  })

await program.parseAsync(process.argv)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/cli.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify against a real repository**

Run the tool against an actual codebase to confirm the spec's §11 targets are plausible:

```bash
npm run build
node dist/cli.js index ~/Documents/arsal_git/work-dashboard
node dist/cli.js status ~/Documents/arsal_git/work-dashboard
```

Expected: completes without error, reports a file count matching the repository, and a non-zero edge count. Record the wall-clock time — if a repository of a few thousand files takes substantially longer than 60 seconds, note it for Plan 2 rather than optimizing here.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests across Tasks 1–10.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: arch index and arch status commands"
```

---

## Done criteria for this plan

- `arch index <repo>` produces a SQLite graph with files, symbols, imports, and confidence-tiered edges.
- `arch status <repo>` reports counts and distinguishes current, stale, and incomplete indexes.
- Every discovered file is either indexed or skipped with a recorded reason.
- Ambiguous call matches are stored and labelled, never dropped.
- Unknown-language files appear in the index with `lang: null`.
- Parse errors keep partial results and are reported in aggregate.
- The full test suite passes.

## Deliberately deferred to Plan 2

- Incremental reindex and the full-versus-incremental equality invariant (spec §7.1, §10).
- The `~50 changed file` auto-reindex threshold (spec §7.2). Task 10's `status` reports staleness but takes no action.
- `loc` is persisted as `0`; nothing reads it until `find_hotspots` in Plan 3.
- MCP server and tools (spec §8).
- Languages beyond TypeScript/JavaScript. `@vscode/tree-sitter-wasm` ships 17 grammars including Python, Go, Java, Ruby, Rust, C#, C++ and PHP — each needs only a registry entry and three `.scm` files. **Swift and Kotlin are not in that package** and would need grammars compiled separately; note this against the spec's React Native ambitions.
