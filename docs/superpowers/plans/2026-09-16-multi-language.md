# AI Software Architect — Multi-Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ten tools work on Python, Go, Java and Rust repositories, not just TypeScript and JavaScript.

**Architecture:** Each language needs three things, not one: a grammar, a query set, and an import resolver. The first two are additive and the existing seam already supports them. The third does not exist yet — the spec promised per-language resolvers and the code never grew the dispatch point, so this plan builds that seam first and then fills it four times.

**Tech Stack:** TypeScript (ESM), Node 20+, existing `web-tree-sitter` 0.27.0 and `@vscode/tree-sitter-wasm` 0.3.1 — all four grammars ship in the package already installed. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-ai-software-architect-design.md`

**Scope:** Spec milestone 10, for four languages. Milestone 9 (the summarizer) is withdrawn — see spec §5.5. Ruby, C#, PHP and C++ grammars ship in the same package and can follow the same pattern later; they are excluded here because each needs its own hand-verified queries and its own resolution semantics, and four is already the honest size of this plan.

---

## THE FINDING THAT SHAPES THIS PLAN

A naive reading of "add more grammars" produces a tool that **lies about every non-JS repository.** This is measured, not predicted.

`resolveImport` is written for JavaScript module semantics: relative paths, extension probing, index files. I ran the four languages' real import specifiers through the shipped resolver, with a TypeScript control to prove the resolver itself works:

```
ts control  "./helper"          -> src/helper.ts      (resolver works)
python      ".helper"           -> null
python      "pkg.helper"        -> null
go          "example.com/m/helper" -> null
java        "com.example.Helper"   -> null
rust        "crate::helper"        -> null
```

Every one unresolved. Follow that through the pipeline:

- No import resolves, so `importedFileIds` is empty for every file.
- `buildModuleGraph` produces **no edges**, so `find_cycles` reports no cycles and `get_coupling` reports zero coupling for every module — on any repository, however tangled.
- `resolveCallsForFile`'s candidate set collapses to local symbols only, so nearly every call becomes `unresolved` and `impact_of` returns almost nothing.
- `trace_flow` cannot leave a file.

Those are not missing answers. They are **confident wrong answers**: "this Python codebase has no circular dependencies and no coupling" is a sentence the tool would emit, and a reader would believe. That is the manufactured-signal failure this project has fought in every prior plan — the conflated confidence tier, the fabricated `ambiguous`, the artifact cycle — and shipping grammars without resolvers would reintroduce it at the largest scale yet.

**Therefore a language is not done when its symbols appear. It is done when its edges resolve.** Every language task in this plan ends with an assertion that a cross-file edge exists, and Task 6 refuses to pass unless all four produce real graphs.

## Global Constraints

- Node 20+, ESM (`"type": "module"`), relative imports carry `.js` extensions.
- No new dependencies. All four grammars are already in `@vscode/tree-sitter-wasm@0.3.1`.
- **`Confidence` has five values** — `exact`, `resolved`, `heuristic`, `unresolved`, `ambiguous` — and `unresolved` must never be conflated with `ambiguous`. A specifier a resolver cannot map is `unresolved`, not `ambiguous`.
- **Never silently omit.** Every capped list carries its true total.
- **Never assert a bare type check where the value is the thing under test.** Assert the concrete value. This project shipped that anti-pattern eight times across three plans; if a fixture cannot support a concrete assertion, build one that can rather than weakening the assertion.
- **Precedence rule:** when this plan's verbatim code conflicts with a constraint above, the constraint wins — implement the constraint-satisfying version and flag the conflict rather than transcribing a violation.
- `SourceSymbol`, never `Symbol`. Nothing downstream of the parser learns what language a file was written in beyond `ParsedFile.lang`.

## A deliberate departure, stated rather than hidden

Task 2 gives Python's resolver as verbatim code. Tasks 3, 4 and 5 do NOT transcribe theirs — they give the **tests verbatim** and state each language's resolution rules precisely, then ask the implementer to write the resolver against them.

That departs from this plan's own standard of showing code for every code step, so here is the reasoning rather than leaving it to look like an oversight. Python is the template and is fully worked; the remaining three differ only in their mapping rule, which is stated exactly — strip the `go.mod` prefix and take the first sorted `.go` file in the directory, replace dots with slashes under each derived source root longest-first, split on `::` and try both the full path and the path minus its last segment. The verbatim tests pin every one of those behaviours, including the edge cases, so a test-first implementer has a complete specification with no guessing.

If any of those rules turns out to be underspecified while you are implementing, that is a defect in this plan — say so rather than choosing for me.

## Verified before this plan was written

Every query below was executed against the real grammar. A malformed `.scm` throws at `Query` construction, so unverified queries would fail at startup rather than in a test.

| Language | symbols | imports | calls | Extracted from a real sample |
|---|---|---|---|---|
| Python | OK | OK | OK | `class:Service, function:run, function:standalone` / `.helper`, `os` / `helper, Service, run` |
| Go | OK | OK | OK | `type:Service, method:Run, function:standalone` / `fmt`, `example.com/m/helper` / `Help, Println` |
| Java | OK | OK | OK | `class:Service, method:run, interface:Runner` / `com.example.Helper` / `help` |
| Rust | OK | OK | OK | `class:Service, function:run, interface:Runner` / `std::collections::HashMap`, `crate::helper::help` / `help` |

Three details that cost time if rediscovered:

1. **Go string literals include their quotes.** `interpreted_string_literal` captures `"example.com/x"` with the quotes. The child node `interpreted_string_literal_content` gives `example.com/x` clean — capture the child.
2. **Python and Rust do not have a distinct method node.** A method is a `function_definition` / `function_item` like any other. They are distinguishable by ancestry, verified: a Python method's chain is `block < class_definition < module` versus a free function's `module`; a Rust method's is `declaration_list < impl_item < source_file` versus `source_file`. Use a bounded ancestor walk, exactly as the TypeScript parser already does for `enclosingClassName`.
3. **Rust structs map to `class` and traits to `interface`.** `SymbolKind` has no `struct` or `trait` member. These are the closest honest fits and the mapping is documented in the query file so a reader is not surprised.

## Existing interfaces you build on

All of this exists and is tested (307 tests). Do not modify except where a task says so.

```ts
// src/types.ts
type Confidence = 'exact' | 'resolved' | 'heuristic' | 'unresolved' | 'ambiguous'
type SymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable'
interface ParsedFile { path; lang: string | null; contentHash; loc: number; symbols; imports; callSites; errors }
interface RawImport { specifier: string; kind: 'static' | 'dynamic' | 'require'; line: number }
interface CallSite { name; line; enclosingSymbol: string | null; kind: 'calls' | 'instantiates' }

// src/parser/languages.ts
interface LanguageDef { id: string; extensions: string[]; wasmPath: string; queryDir: string }
const LANGUAGES: LanguageDef[]          // 4 entries today: typescript, tsx, javascript, jsx
function languageForPath(path): LanguageDef | null
function loadLanguage(def): Promise<Language>   // memoized on wasmPath

// src/indexer/resolve-imports.ts
function resolveImport(fromPath, specifier, knownPaths: Set<string>): { path: string | null; confidence: Confidence }

// src/indexer/pipeline.ts  — calls resolveImport directly, no language dispatch
// src/indexer/incremental.ts — same, at its own call site
```

## File Structure

```
src/
  parser/
    languages.ts                       -- MODIFY: four new entries, plus a resolver id per language
    queries/python/{symbols,imports,calls}.scm    -- NEW
    queries/go/{symbols,imports,calls}.scm        -- NEW
    queries/java/{symbols,imports,calls}.scm      -- NEW
    queries/rust/{symbols,imports,calls}.scm      -- NEW
    parser.ts                          -- MODIFY: ancestry-based method detection for Python and Rust
  resolve/
    index.ts                           -- NEW: the dispatch seam the spec promised
    javascript.ts                      -- NEW: today's resolveImport, moved behind the seam unchanged
    python.ts                          -- NEW
    go.ts                              -- NEW
    java.ts                            -- NEW
    rust.ts                            -- NEW
tests/
  fixtures-multilang.ts                -- NEW: one builder per language, mirroring tests/fixture-builder.ts
  resolve-python.test.ts / -go / -java / -rust
  parser-python.test.ts / -go / -java / -rust
  multilang-integration.test.ts        -- the gate: every language produces a real graph
```

---

### Task 1: The resolver seam

The spec's §5.3 says "Per-language resolvers may override it." That seam was never built — `resolveImport` is one function the pipeline calls directly. Build it before adding languages that need it, so the four language tasks are additive rather than each editing the same dispatch.

**Files:**
- Create: `src/resolve/index.ts`, `src/resolve/javascript.ts`
- Modify: `src/parser/languages.ts`, `src/indexer/pipeline.ts`, `src/indexer/incremental.ts`
- Test: `tests/resolve-seam.test.ts`

**Interfaces:**
- Consumes: `LanguageDef`, `languageForPath`, `Confidence`.
- Produces: `interface ImportResolver { id: string; resolve(fromPath: string, specifier: string, knownPaths: Set<string>): { path: string | null; confidence: Confidence } }`; `resolverFor(path: string): ImportResolver`; `resolveImport(fromPath, specifier, knownPaths)` re-exported with an unchanged signature so existing callers do not change.

> **The existing `resolveImport` must not change behaviour.** 307 tests depend on it, including the incremental-vs-full equality invariant. Move it verbatim into `src/resolve/javascript.ts` as that resolver's `resolve` method, and keep `src/indexer/resolve-imports.ts` re-exporting a `resolveImport` that dispatches. If a single existing test changes its expected value, the move was not verbatim — stop and report rather than adjusting the test.

- [ ] **Step 1: Write the failing test**

`tests/resolve-seam.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolverFor } from '../src/resolve/index.js'
import { resolveImport } from '../src/indexer/resolve-imports.js'

describe('resolverFor', () => {
  it('picks the javascript resolver for TypeScript and JavaScript files', () => {
    for (const p of ['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.jsx']) {
      expect(resolverFor(p).id).toBe('javascript')
    }
  })

  it('falls back to the javascript resolver for an unknown extension', () => {
    // A file with no registered language still gets a resolver rather than
    // throwing; it simply will not resolve anything.
    expect(resolverFor('notes.md').id).toBe('javascript')
  })
})

describe('resolveImport still behaves exactly as before the seam', () => {
  const known = new Set(['src/helper.ts', 'src/widgets/index.ts', 'src/legacy.js'])

  it('resolves a relative sibling', () => {
    expect(resolveImport('src/main.ts', './helper', known))
      .toEqual({ path: 'src/helper.ts', confidence: 'resolved' })
  })

  it('resolves a directory to its index file', () => {
    expect(resolveImport('src/main.ts', './widgets', known).path).toBe('src/widgets/index.ts')
  })

  it('prefers the .ts source for an explicit .js specifier', () => {
    expect(resolveImport('src/main.ts', './helper.js', known).path).toBe('src/helper.ts')
  })

  it('leaves a bare package specifier unresolved', () => {
    expect(resolveImport('src/main.ts', 'react', known))
      .toEqual({ path: null, confidence: 'unresolved' })
  })

  it('never escapes the repository root', () => {
    expect(resolveImport('src/main.ts', '../../../etc/passwd', known).path).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/resolve-seam.test.ts`
Expected: FAIL — cannot resolve `../src/resolve/index.js`.

- [ ] **Step 3: Define the resolver contract**

`src/resolve/index.ts`:
```ts
import { languageForPath } from '../parser/languages.js'
import type { Confidence } from '../types.js'
import { javascriptResolver } from './javascript.js'

export interface ResolvedImport {
  path: string | null
  confidence: Confidence
}

export interface ImportResolver {
  /** Matches `LanguageDef.resolverId`. */
  id: string
  /**
   * Maps a raw import specifier to an indexed path, or null.
   *
   * Resolution is against the set of INDEXED paths rather than the
   * filesystem: an import can only produce a graph edge when its target is
   * a file this index actually holds.
   */
  resolve(fromPath: string, specifier: string, knownPaths: Set<string>): ResolvedImport
}

/**
 * Every resolver, keyed by the `resolverId` its languages declare. Static
 * rather than a registry with an `add` function: all resolvers are known at
 * compile time, so a registration call would be indirection without a caller.
 * Each language task adds one line here.
 */
const RESOLVERS = new Map<string, ImportResolver>([[javascriptResolver.id, javascriptResolver]])

/**
 * The resolver for a file's language.
 *
 * Falls back to the JavaScript resolver for an unregistered language rather
 * than throwing. A file with no resolver would silently contribute no edges,
 * which is the failure mode this seam exists to make impossible to ship by
 * accident — but throwing mid-index would be worse, and the fallback simply
 * resolves nothing for a specifier it does not understand.
 */
export function resolverFor(path: string): ImportResolver {
  const lang = languageForPath(path)
  if (lang === null) return javascriptResolver
  return RESOLVERS.get(lang.resolverId) ?? javascriptResolver
}
```

- [ ] **Step 4: Move the existing resolver behind the seam**

Create `src/resolve/javascript.ts`. Move the ENTIRE current body of `src/indexer/resolve-imports.ts` into it verbatim — `PROBE_EXTENSIONS`, `INDEX_BASENAMES`, `candidatesFor`, and the resolution logic — exposed as:

```ts
export const javascriptResolver: ImportResolver = {
  id: 'javascript',
  resolve(fromPath, specifier, knownPaths) { /* the existing body, unchanged */ },
}
```

Then reduce `src/indexer/resolve-imports.ts` to a dispatching re-export, so its callers in `pipeline.ts` and `incremental.ts` need no edit:

```ts
import { resolverFor, type ResolvedImport } from '../resolve/index.js'

export type { ResolvedImport }

export function resolveImport(
  fromPath: string,
  specifier: string,
  knownPaths: Set<string>,
): ResolvedImport {
  return resolverFor(fromPath).resolve(fromPath, specifier, knownPaths)
}
```

Keep `resolveImportsForFile` if it still exists and is exported; check whether anything imports it, and delete it if nothing does rather than carrying it through the move.

- [ ] **Step 5: Add `resolverId` to the language registry**

In `src/parser/languages.ts`, add a `resolverId: string` field to `LanguageDef`, and give the `def()` helper a fifth parameter for it. All four existing entries take `'javascript'`. Document that a language's resolver id is separate from its grammar and its query directory, all three chosen independently — the same reasoning already recorded there for grammar-versus-query-directory.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/resolve-seam.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Prove the move was behaviour-preserving**

Run the full suite AND the equality invariant specifically:

```bash
npx vitest run tests/resolve-imports.test.ts tests/incremental.test.ts
npm test
```

Expected: every existing test passes unchanged, 307 before your 7. If any existing expectation changed, the move was not verbatim — revert and redo it rather than updating the test. Report the counts.

- [ ] **Step 8: Commit**

```bash
git add src/resolve src/indexer/resolve-imports.ts src/parser/languages.ts tests/resolve-seam.test.ts
git commit -m "feat: per-language import resolver seam"
```

---

### Task 2: Python

The template for the three languages after it: registry entry, three query files, a resolver, and a test that a cross-file edge actually exists.

**Files:**
- Create: `src/parser/queries/python/{symbols,imports,calls}.scm`, `src/resolve/python.ts`, `tests/fixtures-multilang.ts`
- Modify: `src/parser/languages.ts`, `src/parser/parser.ts`, `src/resolve/index.ts`
- Test: `tests/parser-python.test.ts`, `tests/resolve-python.test.ts`

**Interfaces:**
- Consumes: `ImportResolver`, `LanguageDef`, `RepoParser`.
- Produces: `pythonResolver: ImportResolver`; `buildPythonFixture(): string` from `tests/fixtures-multilang.ts`.

> **Python resolution rules, and why each is what it is.** A dotted specifier is a module path relative to the repository root: `pkg.helper` means `pkg/helper.py`, falling back to the package directory's `pkg/helper/__init__.py`. A leading-dot specifier is relative to the importing file's package: one dot means the same directory, two means the parent, and so on — `.helper` from `pkg/main.py` is `pkg/helper.py`, `..util` from `pkg/sub/main.py` is `pkg/util.py`. Anything that resolves to no indexed file is `unresolved`, which is the correct answer for a standard-library or site-packages import and must not be reported as `ambiguous`.

- [ ] **Step 1: Write the query files**

`src/parser/queries/python/symbols.scm`:
```scheme
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class
```

`src/parser/queries/python/imports.scm`:
```scheme
(import_statement name: (dotted_name) @specifier) @import.static
(import_from_statement module_name: (dotted_name) @specifier) @import.static
(import_from_statement module_name: (relative_import) @specifier) @import.static
```

`src/parser/queries/python/calls.scm`:
```scheme
(call function: (identifier) @callee) @call
(call function: (attribute attribute: (identifier) @callee)) @call
```

All three were executed against `tree-sitter-python.wasm` and extracted `class:Service, function:run, function:standalone`, `.helper` and `os`, and `helper, Service, run` from a real sample.

Python has no separate method node — a method is a `function_definition` inside a class — so `symbols.scm` cannot distinguish them. Step 3 handles that in the parser, where ancestry is available.

- [ ] **Step 2: Write the failing tests**

`tests/fixtures-multilang.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function build(prefix: string, files: Record<string, string>, git: boolean): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  if (git) {
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'a@example.com'])
    run(['config', 'user.name', 'A'])
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'fixture'])
  }
  return root
}

/** helper.py is imported BOTH absolutely and relatively, so both paths are exercised. */
export const PYTHON_FILES: Record<string, string> = {
  'pkg/__init__.py': '',
  'pkg/helper.py': 'def helper(n):\n    return n + 1\n\n\ndef unused():\n    pass\n',
  'pkg/service.py':
    'from .helper import helper\n\n\nclass Service:\n    def place(self, n):\n        return helper(n)\n',
  'main.py': 'from pkg.service import Service\n\n\ndef run():\n    return Service().place(2)\n',
}

export function buildPythonFixture(options: { git?: boolean } = {}): string {
  return build('arch-py-', PYTHON_FILES, options.git ?? false)
}
```

`tests/resolve-python.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pythonResolver } from '../src/resolve/python.js'

const known = new Set([
  'pkg/__init__.py', 'pkg/helper.py', 'pkg/service.py', 'main.py',
  'pkg/sub/__init__.py', 'pkg/sub/deep.py', 'pkg/util.py',
])
const r = (from: string, spec: string) => pythonResolver.resolve(from, spec, known)

describe('pythonResolver', () => {
  it('resolves an absolute dotted module', () => {
    expect(r('main.py', 'pkg.helper')).toEqual({ path: 'pkg/helper.py', confidence: 'resolved' })
  })

  it('resolves a dotted package to its __init__.py', () => {
    expect(r('main.py', 'pkg').path).toBe('pkg/__init__.py')
  })

  it('resolves a single-dot relative import against the importing package', () => {
    expect(r('pkg/service.py', '.helper')).toEqual({ path: 'pkg/helper.py', confidence: 'resolved' })
  })

  it('resolves a two-dot relative import against the parent package', () => {
    expect(r('pkg/sub/deep.py', '..util').path).toBe('pkg/util.py')
  })

  it('resolves a bare single dot to the current package __init__', () => {
    expect(r('pkg/service.py', '.').path).toBe('pkg/__init__.py')
  })

  it('reports a standard-library import as unresolved, not ambiguous', () => {
    expect(r('main.py', 'os')).toEqual({ path: null, confidence: 'unresolved' })
    expect(r('main.py', 'typing')).toEqual({ path: null, confidence: 'unresolved' })
  })

  it('does not escape the repository root', () => {
    expect(r('main.py', '....secrets').path).toBeNull()
  })
})
```

`tests/parser-python.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { RepoParser } from '../src/parser/parser.js'

const SOURCE =
  'from .helper import helper\n' +
  'import os\n' +
  '\n' +
  'class Service:\n' +
  '    def place(self, n):\n' +
  '        return helper(n)\n' +
  '\n' +
  'def standalone(x):\n' +
  '    return Service().place(x)\n'

let parser: RepoParser
beforeAll(async () => { parser = await RepoParser.create() })

describe('python parsing', () => {
  it('recognises .py as python', () => {
    expect(parser.parse('a.py', SOURCE).lang).toBe('python')
  })

  it('extracts classes and functions', () => {
    const names = parser.parse('a.py', SOURCE).symbols.map(s => `${s.kind}:${s.name}`).sort()
    expect(names).toEqual(['class:Service', 'function:standalone', 'method:place'])
  })

  it('marks a function inside a class as a method and attributes it to the class', () => {
    const place = parser.parse('a.py', SOURCE).symbols.find(s => s.name === 'place')!
    expect(place.kind).toBe('method')
    expect(place.parentName).toBe('Service')
  })

  it('leaves a module-level function as a function with no parent', () => {
    const standalone = parser.parse('a.py', SOURCE).symbols.find(s => s.name === 'standalone')!
    expect(standalone.kind).toBe('function')
    expect(standalone.parentName).toBeNull()
  })

  it('extracts both relative and absolute imports', () => {
    const specs = parser.parse('a.py', SOURCE).imports.map(i => i.specifier).sort()
    expect(specs).toEqual(['.helper', 'os'])
  })

  it('extracts call sites and attributes them to the enclosing symbol', () => {
    const calls = parser.parse('a.py', SOURCE).callSites
    expect(calls.find(c => c.name === 'helper')!.enclosingSymbol).toBe('place')
    expect(calls.find(c => c.name === 'Service')!.enclosingSymbol).toBe('standalone')
  })

  it('counts lines', () => {
    expect(parser.parse('a.py', SOURCE).loc).toBe(9)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/resolve-python.test.ts tests/parser-python.test.ts`
Expected: FAIL — `src/resolve/python.js` does not resolve, and `.py` has no registered language.

- [ ] **Step 4: Implement the resolver**

`src/resolve/python.ts`:
```ts
import type { ImportResolver, ResolvedImport } from './index.js'

const UNRESOLVED: ResolvedImport = { path: null, confidence: 'unresolved' }

/**
 * Python import resolution against the indexed path set.
 *
 * A dotted specifier is a module path from the repository root: `pkg.helper`
 * is `pkg/helper.py`, or the package's `pkg/helper/__init__.py`. A
 * leading-dot specifier is relative to the importing file's package — one dot
 * is that package, each further dot climbs one level.
 *
 * Anything that maps to no indexed file is `unresolved`, which is the right
 * answer for a standard-library or site-packages import. It is never
 * `ambiguous`: nothing matched, so there is no ambiguity to report.
 */
export const pythonResolver: ImportResolver = {
  id: 'python',

  resolve(fromPath: string, specifier: string, knownPaths: Set<string>): ResolvedImport {
    const base = specifier.startsWith('.')
      ? relativeBase(fromPath, specifier)
      : { dir: '', rest: specifier }

    if (base === null) return UNRESOLVED

    const segments = base.rest.length === 0 ? [] : base.rest.split('.')
    const joined = [base.dir, ...segments].filter(s => s.length > 0).join('/')

    for (const candidate of [`${joined}.py`, `${joined}/__init__.py`]) {
      if (knownPaths.has(candidate)) return { path: candidate, confidence: 'resolved' }
    }
    return UNRESOLVED
  },
}

/**
 * Splits a leading-dot specifier into a starting directory and the remaining
 * dotted path. One dot means the importing file's own package, so climb
 * (dots - 1) levels above it. Returns null when the climb escapes the root.
 */
function relativeBase(fromPath: string, specifier: string): { dir: string; rest: string } | null {
  let dots = 0
  while (dots < specifier.length && specifier[dots] === '.') dots += 1

  const cut = fromPath.lastIndexOf('/')
  const ownDir = cut === -1 ? [] : fromPath.slice(0, cut).split('/')

  const climb = dots - 1
  if (climb > ownDir.length) return null

  return { dir: ownDir.slice(0, ownDir.length - climb).join('/'), rest: specifier.slice(dots) }
}
```

- [ ] **Step 5: Register the language and the resolver**

In `src/parser/languages.ts`, add `def('python', 'python', 'python', ['.py'], 'python')`.

In `src/resolve/index.ts`, import `pythonResolver` and add it to the `RESOLVERS` map alongside the JavaScript one.

- [ ] **Step 6: Teach the parser ancestry-based method detection**

`symbols.scm` cannot mark Python methods, because Python has no distinct method node. In `src/parser/parser.ts`, where `SourceSymbol.kind` and `parentName` are set, add an ancestry check: a captured definition whose ancestor chain contains `class_definition` is a `method` with that class's name as `parentName`, rather than a `function` with none.

Verified ancestry, so you know the shape to look for: a Python method's chain is `block < class_definition < module`; a module-level function's is just `module`.

Keep this general rather than special-casing Python by name — Rust needs the same treatment in Task 5 with a different ancestor node type, so express it as a per-language set of "container" node types that turn a function into a method. The existing TypeScript path, which already handles `class_declaration`, should keep working unchanged; verify that it does.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/resolve-python.test.ts tests/parser-python.test.ts`
Expected: PASS, 7 + 7 tests.

- [ ] **Step 8: Prove an edge actually resolves end to end**

This is the step that distinguishes "Python symbols appear" from "Python works". Add to `tests/parser-python.test.ts`:

```ts
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildPythonFixture } from './fixtures-multilang.js'

describe('python produces a real graph', () => {
  it('resolves a cross-file import and a cross-file call edge', async () => {
    const fixture = buildPythonFixture({ git: true })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-py-db-')), 'index.db')
    await runColdIndex({ repoRoot: fixture, dbPath })
    const store = GraphStore.open(dbPath)
    try {
      const serviceId = store.fileIdByPath('pkg/service.py')!
      const helperId = store.fileIdByPath('pkg/helper.py')!

      const resolved = store.importsForFile(serviceId).find(i => i.rawSpecifier === '.helper')!
      expect(resolved.resolvedFileId).toBe(helperId)
      expect(resolved.confidence).toBe('resolved')

      const intoHelper = store.edgesInto(helperId)
      const call = intoHelper.find(e => e.dstName === 'helper')!
      expect(call.confidence).toBe('heuristic')
      expect(call.srcFileId).toBe(serviceId)
    } finally {
      store.close()
    }
  })
})
```

If the import resolves but the call edge does not, say so rather than weakening the assertion — it would mean the resolver works and the candidate-set construction does not, which is a different defect and worth knowing separately.

- [ ] **Step 9: Run the whole suite and commit**

Run: `npm test` — 314 tests exist before this task's additions; no existing assertion may be weakened.

```bash
git add src/parser/queries/python src/resolve/python.ts src/parser/languages.ts src/parser/parser.ts src/resolve/index.ts tests/fixtures-multilang.ts tests/resolve-python.test.ts tests/parser-python.test.ts
git commit -m "feat: Python language support with module-path resolution"
```

---

### Task 3: Go

**Files:**
- Create: `src/parser/queries/go/{symbols,imports,calls}.scm`, `src/resolve/go.ts`
- Modify: `src/parser/languages.ts`, `src/resolve/index.ts`, `tests/fixtures-multilang.ts`
- Test: `tests/parser-go.test.ts`, `tests/resolve-go.test.ts`

**Interfaces:**
- Produces: `goResolver: ImportResolver`; `buildGoFixture()` added to `tests/fixtures-multilang.ts`.

> **Go resolution is package-directory based, and the module prefix has to come from somewhere.** A Go import is a full module path — `example.com/m/helper` — whose prefix is declared in `go.mod`'s `module` line. Strip that prefix and what remains is a directory relative to the repository root, holding one or more `.go` files that share a package. So `example.com/m/helper` with `module example.com/m` means the directory `helper/`.
>
> Two consequences worth stating. First, the resolver must read `go.mod` — it cannot resolve anything without the module prefix, and a repository without `go.mod` gets `unresolved` for every internal import, which is honest. Second, a Go import names a DIRECTORY, not a file, so it can resolve to several files; resolve to the first indexed `.go` file in that directory by sorted order, and document that choice, because picking arbitrarily without saying so is the kind of silent decision this project keeps finding.

- [ ] **Step 1: Write the query files**

`src/parser/queries/go/symbols.scm`:
```scheme
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(type_declaration (type_spec name: (type_identifier) @name)) @def.type
```

`src/parser/queries/go/imports.scm`:
```scheme
(import_spec path: (interpreted_string_literal
  (interpreted_string_literal_content) @specifier)) @import.static
```

Note the capture is the CONTENT child, not the literal. Verified: capturing `interpreted_string_literal` yields `"example.com/x"` with quotes included, while the content child yields `example.com/x` clean.

`src/parser/queries/go/calls.scm`:
```scheme
(call_expression function: (identifier) @callee) @call
(call_expression function: (selector_expression field: (field_identifier) @callee)) @call
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/fixtures-multilang.ts`:
```ts
export const GO_FILES: Record<string, string> = {
  'go.mod': 'module example.com/m\n\ngo 1.22\n',
  'helper/helper.go': 'package helper\n\nfunc Help(n int) int {\n\treturn n + 1\n}\n',
  'service/service.go':
    'package service\n\nimport "example.com/m/helper"\n\n' +
    'type Service struct{ N int }\n\n' +
    'func (s *Service) Place() int {\n\treturn helper.Help(s.N)\n}\n',
  'main.go':
    'package main\n\nimport (\n\t"fmt"\n\t"example.com/m/service"\n)\n\n' +
    'func main() {\n\ts := service.Service{N: 2}\n\tfmt.Println(s.Place())\n}\n',
}

export function buildGoFixture(options: { git?: boolean } = {}): string {
  return build('arch-go-', GO_FILES, options.git ?? false)
}
```

`tests/resolve-go.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { goResolver, modulePrefixFrom } from '../src/resolve/go.js'

const known = new Set(['go.mod', 'helper/helper.go', 'service/service.go', 'main.go'])
const r = (from: string, spec: string, prefix = 'example.com/m') =>
  goResolver.resolve(from, spec, known, prefix)

describe('modulePrefixFrom', () => {
  it('reads the module line', () => {
    expect(modulePrefixFrom('module example.com/m\n\ngo 1.22\n')).toBe('example.com/m')
  })

  it('tolerates leading whitespace and trailing comments', () => {
    expect(modulePrefixFrom('  module   example.com/m // root\n')).toBe('example.com/m')
  })

  it('returns null when there is no module line', () => {
    expect(modulePrefixFrom('go 1.22\n')).toBeNull()
  })
})

describe('goResolver', () => {
  it('resolves an internal import to a file in the package directory', () => {
    expect(r('service/service.go', 'example.com/m/helper'))
      .toEqual({ path: 'helper/helper.go', confidence: 'resolved' })
  })

  it('reports a standard-library import as unresolved', () => {
    expect(r('main.go', 'fmt')).toEqual({ path: null, confidence: 'unresolved' })
  })

  it('reports a third-party import as unresolved', () => {
    expect(r('main.go', 'github.com/pkg/errors')).toEqual({ path: null, confidence: 'unresolved' })
  })

  it('reports everything unresolved when the module prefix is unknown', () => {
    expect(goResolver.resolve('service/service.go', 'example.com/m/helper', known, null).path)
      .toBeNull()
  })
})
```

`tests/parser-go.test.ts` mirrors the Python parser test: assert `.go` maps to `go`, that `Service` is a `type`, `Place` a `method`, `main` a `function`, that the import specifier is `example.com/m/helper` WITHOUT quotes, that calls attribute to their enclosing symbol, and the end-to-end graph test asserting `service/service.go` resolves an import to `helper/helper.go` and a call edge reaches it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/resolve-go.test.ts tests/parser-go.test.ts`
Expected: FAIL — module does not resolve.

- [ ] **Step 4: Implement the resolver**

`src/resolve/go.ts`. The signature needs the module prefix, which the `ImportResolver` contract does not carry. Rather than widening the shared contract for one language, have `goResolver.resolve` accept an optional fourth argument and read `go.mod` lazily from the repository when it is absent — cache the result per repository root so it is read once per index run, not once per import.

Export `modulePrefixFrom(goModContents: string): string | null` separately so it is testable without a filesystem.

Resolution: strip the module prefix and a following slash from the specifier; if the specifier does not start with the prefix, it is external and `unresolved`. What remains is a directory. Collect every indexed path under that directory ending in `.go`, sort, and take the first. Document that a Go package is a directory of files and the first is chosen deterministically.

- [ ] **Step 5: Register, run, and prove the edge**

Register `def('go', 'go', 'go', ['.go'], 'go')` and add `goResolver` to the map. Then run both test files and the end-to-end graph assertion.

Expected: PASS. Report whether the cross-file call edge from `service.go` into `helper.go` came back `heuristic`.

- [ ] **Step 6: Run the whole suite and commit**

```bash
npm test
git add src/parser/queries/go src/resolve/go.ts src/parser/languages.ts src/resolve/index.ts tests/fixtures-multilang.ts tests/resolve-go.test.ts tests/parser-go.test.ts
git commit -m "feat: Go language support with go.mod-aware package resolution"
```

---

### Task 4: Java

**Files:**
- Create: `src/parser/queries/java/{symbols,imports,calls}.scm`, `src/resolve/java.ts`
- Modify: `src/parser/languages.ts`, `src/resolve/index.ts`, `tests/fixtures-multilang.ts`
- Test: `tests/parser-java.test.ts`, `tests/resolve-java.test.ts`

**Interfaces:**
- Produces: `javaResolver: ImportResolver`; `buildJavaFixture()`.

> **Java resolution maps a fully-qualified name to a path, and the source root is the wrinkle.** `import com.example.Helper` means the class `Helper` in package `com.example`, which by convention lives at `com/example/Helper.java` — but almost every real project nests that under a source root such as `src/main/java/` or `src/`. So the resolver must try the FQN-as-path both bare and under each known source-root prefix.
>
> Derive the candidate roots from the indexed paths rather than hardcoding a list: for any indexed `*.java` file, the portion of its path before its own package directory is a source root. That handles Maven, Gradle, and a flat layout without a configuration file, and it degrades to bare FQN resolution when the convention is not followed.
>
> A wildcard import (`import com.example.*`) names a package, not a class. Resolve it to `unresolved` rather than guessing a file — it genuinely does not identify one, and picking one would be a fabricated edge.

- [ ] **Step 1: Write the query files**

`src/parser/queries/java/symbols.scm`:
```scheme
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(method_declaration name: (identifier) @name) @def.method
```

`src/parser/queries/java/imports.scm`:
```scheme
(import_declaration (scoped_identifier) @specifier) @import.static
```

`src/parser/queries/java/calls.scm`:
```scheme
(method_invocation name: (identifier) @callee) @call
(object_creation_expression type: (type_identifier) @callee) @new
```

The symbols and imports queries were executed against `tree-sitter-java.wasm` and extracted `class:Service, method:run, interface:Runner, method:go` and `com.example.Helper`. The `enum_declaration` line was not in the executed sample — verify it compiles before relying on it, and if the node type differs in this grammar version, correct it and say so.

- [ ] **Step 2: Write the failing tests**

Add to `tests/fixtures-multilang.ts` a fixture under a Maven-style root, so the source-root logic is genuinely exercised rather than assumed:

```ts
export const JAVA_FILES: Record<string, string> = {
  'src/main/java/com/example/Helper.java':
    'package com.example;\n\npublic class Helper {\n  public static int help(int n) { return n + 1; }\n}\n',
  'src/main/java/com/example/Service.java':
    'package com.example;\n\nimport com.example.Helper;\n\n' +
    'public class Service {\n  public int place(int n) { return Helper.help(n); }\n}\n',
  'src/main/java/com/example/Runner.java':
    'package com.example;\n\npublic interface Runner {\n  void go();\n}\n',
}

export function buildJavaFixture(options: { git?: boolean } = {}): string {
  return build('arch-java-', JAVA_FILES, options.git ?? false)
}
```

`tests/resolve-java.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { javaResolver, sourceRootsFrom } from '../src/resolve/java.js'

const known = new Set([
  'src/main/java/com/example/Helper.java',
  'src/main/java/com/example/Service.java',
  'com/other/Flat.java',
])
const r = (from: string, spec: string) => javaResolver.resolve(from, spec, known)

describe('sourceRootsFrom', () => {
  it('derives a Maven source root from an indexed path', () => {
    expect([...sourceRootsFrom(known)]).toContain('src/main/java')
  })

  it('includes the empty root for a flat layout', () => {
    expect([...sourceRootsFrom(known)]).toContain('')
  })
})

describe('javaResolver', () => {
  it('resolves a fully-qualified name under a derived source root', () => {
    expect(r('src/main/java/com/example/Service.java', 'com.example.Helper'))
      .toEqual({ path: 'src/main/java/com/example/Helper.java', confidence: 'resolved' })
  })

  it('resolves a fully-qualified name in a flat layout', () => {
    expect(r('com/other/Main.java', 'com.other.Flat').path).toBe('com/other/Flat.java')
  })

  it('reports a JDK import as unresolved', () => {
    expect(r('src/main/java/com/example/Service.java', 'java.util.List'))
      .toEqual({ path: null, confidence: 'unresolved' })
  })

  it('reports a wildcard import as unresolved rather than guessing a file', () => {
    expect(r('src/main/java/com/example/Service.java', 'com.example.*').path).toBeNull()
  })
})
```

`tests/parser-java.test.ts` mirrors the earlier parser tests: `.java` maps to `java`; `Service` is a `class`, `Runner` an `interface`, `place` a `method` with `parentName` `Service`; the import specifier is `com.example.Helper`; calls attribute correctly. Java's grammar HAS a distinct `method_declaration`, so unlike Python no ancestry work is needed — but assert `parentName` anyway, since it comes from the same enclosing-class walk.

Then the end-to-end graph test: `Service.java` resolves its import to `Helper.java`, and a call edge reaches it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/resolve-java.test.ts tests/parser-java.test.ts`

- [ ] **Step 4: Implement the resolver**

`src/resolve/java.ts`, exporting both `javaResolver` and `sourceRootsFrom(knownPaths: Set<string>): Set<string>`.

`sourceRootsFrom` walks every indexed `.java` path and, for each, strips the trailing package directories to leave a candidate root. Since the package is not known from the path alone, derive it the other way: for a path `a/b/c/D.java`, every prefix of its directory chain is a candidate root. Collect them all, always including the empty string. Cache per `knownPaths` identity so it is computed once per index run rather than per import.

`resolve` converts the FQN to a relative path by replacing dots with slashes and appending `.java`, then tries it under each candidate root, longest root first so a nested layout wins over a coincidental shallow match. A specifier ending in `.*` returns `unresolved` immediately.

- [ ] **Step 5: Register, run, prove the edge, commit**

Register `def('java', 'java', 'java', ['.java'], 'java')` and add the resolver. Run both test files plus the end-to-end assertion, then the full suite.

```bash
git add src/parser/queries/java src/resolve/java.ts src/parser/languages.ts src/resolve/index.ts tests/fixtures-multilang.ts tests/resolve-java.test.ts tests/parser-java.test.ts
git commit -m "feat: Java language support with source-root-aware FQN resolution"
```

---

### Task 5: Rust

**Files:**
- Create: `src/parser/queries/rust/{symbols,imports,calls}.scm`, `src/resolve/rust.ts`
- Modify: `src/parser/languages.ts`, `src/parser/parser.ts`, `src/resolve/index.ts`, `tests/fixtures-multilang.ts`
- Test: `tests/parser-rust.test.ts`, `tests/resolve-rust.test.ts`

**Interfaces:**
- Produces: `rustResolver: ImportResolver`; `buildRustFixture()`.

> **Rust resolution follows the module tree, and `use` paths name items rather than files.** A `use crate::helper::help` names the function `help` in module `helper` — so the resolver must map the module part, dropping the final segment when it names an item rather than a module. Since the resolver cannot know which from the path alone, try both: the full path as a module, and the path minus its last segment.
>
> A module `helper` under crate root `src/` is either `src/helper.rs` or `src/helper/mod.rs`. `crate::` is the crate root, `self::` the current module, `super::` the parent. A leading segment that is none of those is an external crate — `unresolved`.
>
> Rust also needs the same method-versus-function ancestry work as Python, with a different container: a method's chain is `declaration_list < impl_item < source_file`, verified. Task 2 built that as a per-language container set; add `impl_item` and `trait_item` to Rust's rather than writing a second mechanism.

- [ ] **Step 1: Write the query files**

`src/parser/queries/rust/symbols.scm`:
```scheme
; Rust has no `struct` or `trait` in SymbolKind. A struct is the closest
; thing to a class and a trait to an interface; the mapping is recorded
; here so a reader is not surprised by the kind that comes back.
(function_item name: (identifier) @name) @def.function
(struct_item name: (type_identifier) @name) @def.class
(enum_item name: (type_identifier) @name) @def.enum
(trait_item name: (type_identifier) @name) @def.interface
(type_item name: (type_identifier) @name) @def.type
```

`src/parser/queries/rust/imports.scm`:
```scheme
(use_declaration argument: (scoped_identifier) @specifier) @import.static
(use_declaration argument: (use_wildcard) @specifier) @import.static
```

`src/parser/queries/rust/calls.scm`:
```scheme
(call_expression function: (identifier) @callee) @call
(call_expression function: (field_expression field: (field_identifier) @callee)) @call
(call_expression function: (scoped_identifier name: (identifier) @callee)) @call
```

The `function_item`, `struct_item`, `trait_item`, both import patterns and all three call patterns were executed against `tree-sitter-rust.wasm`. `enum_item` and `type_item` were NOT in the executed sample — verify they compile and correct them if the grammar names them differently, reporting what you found.

- [ ] **Step 2: Write the failing tests**

Add to `tests/fixtures-multilang.ts`:
```ts
export const RUST_FILES: Record<string, string> = {
  'src/helper.rs': 'pub fn help(n: i32) -> i32 {\n    n + 1\n}\n',
  'src/service.rs':
    'use crate::helper::help;\n\npub struct Service {\n    pub n: i32,\n}\n\n' +
    'impl Service {\n    pub fn place(&self) -> i32 {\n        help(self.n)\n    }\n}\n',
  'src/main.rs':
    'mod helper;\nmod service;\n\nuse crate::service::Service;\n\n' +
    'fn main() {\n    let s = Service { n: 2 };\n    println!("{}", s.place());\n}\n',
}

export function buildRustFixture(options: { git?: boolean } = {}): string {
  return build('arch-rs-', RUST_FILES, options.git ?? false)
}
```

`tests/resolve-rust.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { rustResolver } from '../src/resolve/rust.js'

const known = new Set([
  'src/main.rs', 'src/helper.rs', 'src/service.rs',
  'src/deep/mod.rs', 'src/deep/inner.rs',
])
const r = (from: string, spec: string) => rustResolver.resolve(from, spec, known)

describe('rustResolver', () => {
  it('resolves a crate path naming an item, dropping the item segment', () => {
    expect(r('src/service.rs', 'crate::helper::help'))
      .toEqual({ path: 'src/helper.rs', confidence: 'resolved' })
  })

  it('resolves a crate path naming a module directly', () => {
    expect(r('src/main.rs', 'crate::helper').path).toBe('src/helper.rs')
  })

  it('resolves a module directory to its mod.rs', () => {
    expect(r('src/main.rs', 'crate::deep').path).toBe('src/deep/mod.rs')
  })

  it('resolves a self path against the current module', () => {
    expect(r('src/deep/mod.rs', 'self::inner').path).toBe('src/deep/inner.rs')
  })

  it('resolves a super path against the parent module', () => {
    expect(r('src/deep/inner.rs', 'super::helper')).toBeTruthy()
  })

  it('reports an external crate as unresolved', () => {
    expect(r('src/main.rs', 'std::collections::HashMap'))
      .toEqual({ path: null, confidence: 'unresolved' })
    expect(r('src/main.rs', 'serde::Serialize').path).toBeNull()
  })
})
```

`tests/parser-rust.test.ts` mirrors the others, and must assert specifically that `place` inside `impl Service` comes back as a `method` with `parentName` `Service` — that is the ancestry work — while `help` in `helper.rs` is a plain `function` with no parent. Then the end-to-end graph test.

- [ ] **Step 3: Run the tests to verify they fail**

- [ ] **Step 4: Implement the resolver**

`src/resolve/rust.ts`. Split the specifier on `::`. Map the first segment: `crate` starts at the crate root, `self` at the importing file's module directory, `super` one level above it; anything else is an external crate and returns `unresolved` immediately.

The crate root is the directory containing `main.rs` or `lib.rs` — derive it from the indexed paths rather than assuming `src/`, so a workspace member or an unusual layout still resolves. Fall back to `src` when neither is indexed.

For the remaining segments, try the full path and the path minus its last segment, each as both `<path>.rs` and `<path>/mod.rs`. Return the first that is indexed. Try the longer form first, so `crate::helper` resolving to a real `helper.rs` is not shadowed by a coincidental match on a shorter prefix.

- [ ] **Step 5: Extend the parser's container set**

Add `impl_item` and `trait_item` to Rust's method-container node types in the per-language mechanism Task 2 built. Do not add a second mechanism. Confirm the Python and TypeScript paths still behave identically after the change — run their parser tests specifically and report.

- [ ] **Step 6: Register, run, prove the edge, commit**

```bash
git add src/parser/queries/rust src/resolve/rust.ts src/parser/languages.ts src/parser/parser.ts src/resolve/index.ts tests/fixtures-multilang.ts tests/resolve-rust.test.ts tests/parser-rust.test.ts
git commit -m "feat: Rust language support with module-tree resolution"
```

---

### Task 6: The gate — every language produces a real graph

The tasks above each prove one language in isolation. This one proves the tools work on them, and refuses to pass on symbols alone.

**Files:**
- Create: `tests/multilang-integration.test.ts`
- Modify: `README.md`
- Test: itself

**Interfaces:**
- Consumes: every fixture builder, `runColdIndex`, `GraphStore`, `buildOverview`, `getCoupling`, `findCycles`, `impactOf`, `traceFlow`, `getSymbol`, `describeModule`.

> **Why this task exists.** The finding at the top of this plan is that a language with grammars but no resolver reports "no dependencies, no cycles, no coupling" — a confident wrong answer. A per-language test proves the resolver; only an integration test proves the TOOLS see what the resolver produced. These are different claims, and the second is the one a user experiences.

- [ ] **Step 1: Write the failing test**

`tests/multilang-integration.test.ts`. For each of the four languages, index its fixture once and assert:

1. **Symbols exist** — `totals().symbols` is greater than zero, and `languageBreakdown()` names the language with a non-zero symbol count. A language that indexes files but extracts nothing would pass a naive file-count check.
2. **A cross-file import resolved** — at least one row in `imports` has a non-null `resolvedFileId`. This is the assertion that fails today for all four.
3. **A cross-file call edge exists at `heuristic`** — not merely that edges exist, since unresolved edges always do. Assert one whose `dstFileId` differs from its `srcFileId`.
4. **The module graph has an edge** — `getCoupling` returns at least one module with non-zero `efferent`. Without this, `find_cycles` and `get_coupling` are dead for the language even though symbols look healthy.
5. **`impact_of` finds a cross-file reference** for the helper symbol each fixture defines.
6. **`trace_flow` crosses a file boundary** — a node whose `path` differs from the root's.

Write it as a table-driven test over the four fixtures so adding a fifth language later is one row, and so a failure names the language in its message.

Also assert the negative that protects against regression: for a language, `confidenceBreakdown()` must NOT be entirely `unresolved`. That single assertion is the compact form of this plan's whole finding.

- [ ] **Step 2: Run it and expect real failures**

Run: `npx vitest run tests/multilang-integration.test.ts`

If Tasks 2 through 5 are complete this passes. If a language fails, the message names which and which of the six claims broke — fix that language rather than relaxing the assertion. A relaxed assertion here reinstates exactly the wrong answer this plan exists to prevent.

- [ ] **Step 3: Verify against a real repository in each language**

Find or clone a small real repository per language and index it. Report, per language: file count, symbol count, the confidence breakdown, and whether `get_coupling` returns non-trivial numbers.

What to look for and report honestly: if a language shows symbols but an all-`unresolved` confidence breakdown on real code while passing the fixture test, the fixture is too kind — say so. Real repositories use import forms fixtures do not, and that gap is the most valuable thing this step can surface.

- [ ] **Step 4: Update the README**

Document the supported languages and, for each, what resolution is based on — Python module paths, Go `go.mod` package directories, Java FQNs under derived source roots, Rust module trees. State plainly that an unresolved import yields no edge, so a repository whose imports the resolver does not understand will show symbols but a sparse graph, and that this is visible in `get_repo_overview`'s confidence breakdown rather than hidden.

Also record what is NOT supported: Ruby, C#, PHP and C++ grammars ship in the installed package but have no queries or resolver, so files in those languages index with `lang: null` and no symbols.

- [ ] **Step 5: Run the whole suite and commit**

```bash
npm test
git add tests/multilang-integration.test.ts README.md
git commit -m "test: multi-language integration gate, and document language support"
```

---

## Done criteria

- Python, Go, Java and Rust files index with symbols, imports and call sites.
- Each language resolves at least one cross-file import and produces at least one cross-file `heuristic` call edge.
- `get_coupling` returns non-zero coupling for each language's fixture, so the module graph is real rather than empty.
- No language's confidence breakdown is entirely `unresolved`.
- The per-language resolver seam the spec promised exists, and adding a fifth language is a **complete registry entry** (extensions, grammar, query directory, resolver key, export rule, enclosing-symbol node types and entry-point basenames — all required fields, so none can be silently omitted), **three query files** (`symbols.scm`, `imports.scm`, `calls.scm`; there is no `exports.scm`), and **a resolver** in `src/resolve` or reuse of an existing one.
- Beyond that, a language may need one or more OPTIONAL, shape-dependent hooks, and the plan says so rather than pretending otherwise: `METHOD_CONTAINER_TYPES` and `ENCLOSING_CLASS_TYPES` in `src/parser/parser.ts`, `SAME_PACKAGE_LANGS` in `src/indexer/same-package.ts` with its matching incremental widening, and an `@member` capture in `imports.scm`. Each of these degrades one observable thing when omitted; none of them fails silently. Spec §5.2 carries the same list.
- The full suite passes with no existing assertion weakened, and the incremental-vs-full equality invariant still holds.

## Deliberately out of scope

- **The summarizer.** Withdrawn — see spec §5.5.
- **Ruby, C#, PHP, C++.** Same pattern, four more tasks; excluded so this plan stays honestly sized.
- **Cross-language edges.** A TypeScript file calling into a Rust binary, or a React Native JS-to-native bridge, produces no edge and will not. Spec §13 already records this.
- **Type-aware resolution.** Every new resolver is path-based and produces `resolved` imports and `heuristic` calls. The `exact` tier stays reserved.
- **The indexing memory ceiling**, recorded at spec §11 with a measurement.
