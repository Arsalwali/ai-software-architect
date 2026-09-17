# AI Software Architect — Design

**Date:** 2026-09-14
**Status:** Approved for planning

## 1. Problem

Answering architectural questions about an unfamiliar or large codebase — "where is
authentication implemented?", "what breaks if I change this interface?", "where is the
technical debt?" — currently means reading a lot of code or trusting an LLM that has
seen only fragments of it.

Pasting a repository into a model does not work. Large repositories exceed any context
window, and even when they fit, the model has no reliable way to answer questions that
are fundamentally *graph* questions: transitive impact, dependency cycles, coupling
between modules.

This project builds the missing layer: a structural index of a repository, exposed to
Claude Code as MCP tools. Claude supplies the reasoning; the index supplies ground truth
about structure.

## 2. Goals

- Answer architectural questions about real repositories, accurately enough to rely on
  during a design review.
- Work across languages without per-language work being a prerequisite for usefulness.
- Be honest about uncertainty. A guess labelled as a guess is useful; a guess presented
  as a fact is worse than no answer.
- Index fast enough to stay current with uncommitted working-tree changes.
- Require no running services. One command, one binary, one SQLite file.

## 3. Non-goals

- **Not** an agent. Claude Code is the agent. This project ships no model loop, no chat
  interface, no prompt orchestration.
- **Not** a code reader. Claude already has `Read`, `Grep`, and `Glob`. Tools return
  pointers and relationships, not source dumps.
- **Not** multi-tenant or hosted. Single user, local machine.
- **Not** a visualization, in this phase. The query layer is designed so a UI can be
  added later as a separate project, but no UI is built here.

## 4. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Primary use | Daily-driver tool for real repositories | Prioritizes correctness and freshness over feature breadth |
| Language coverage | Language-agnostic via tree-sitter | Breadth on day one; per-language depth is additive |
| Interface | MCP server consumed by Claude Code | Removes the entire agent/UI subsystem from scope |
| Knowledge base | Structural index only; module summaries withdrawn (§5.5) | Whole-repo LLM preprocessing is expensive and goes stale — and the MCP consumer summarizes better itself |
| Indexing strategy | Eager structural index, incremental via git | Tree-sitter is fast enough that lazy tiers add complexity without payoff |
| Implementation | TypeScript / Node | Matches maintainer's stack; MCP SDK is TS-first; future TS resolver is native |
| Storage | SQLite at `~/.arch/repos/<path-hash>/index.db` | No service to run; central location keeps repos clean and treats clones identically |
| Repo access | Local-first | A GitHub URL is cloned to cache, then indexed as a local path |
| Grammars | `@vscode/tree-sitter-wasm` + `web-tree-sitter` | 17 prebuilt, ABI-current grammars with no build step. `tree-sitter-wasms` is ABI-incompatible with current web-tree-sitter and must not be substituted |

### 4.1 The central tradeoff

Language-agnostic tree-sitter parsing yields *names*, not *bindings*. Import edges
resolve deterministically against the filesystem, but call edges are matched by name.
This is accepted deliberately, and mitigated by the confidence tier system (§6.2) rather
than hidden. Every edge carries the strength of evidence behind it, and every tool
result propagates it.

The schema reserves an `exact` tier for bindings verified by a real type resolver.
Nothing emits it yet. A TypeScript resolver using the TS compiler API is the intended
first occupant, and can be added without schema changes.

## 5. Architecture

Eight modules. Everything language-specific sits behind one normalized record type, so
no module downstream of the parser knows what language anything was written in. That
boundary holds. What does NOT hold — and the original wording of this paragraph claimed
it did — is that adding a language never touches core. Adding one touches **about eight
files**, and a language whose visibility rule is new to the project **must** edit the
parser itself, where an exhaustive `switch` makes omitting that edit a build failure
rather than a silent wrong answer. §5.2 lists exactly what is required and what is
optional.

```
  repo-source ──► parser ──► resolver ──► graph-store ◄── summarizer
   (git/clone)  (tree-sitter)  (edges +     (SQLite)       (lazy LLM)
                               confidence)       ▲
                                                 │
                                           tool-surface
                                          (search/graph/git)
                                                 ▲
                                                 │
                                           mcp-server ◄── cli
```

### 5.1 `repo-source`

Resolves a target to a working directory plus a git handle. A local path is used in
place; a GitHub URL is cloned into the cache directory. Downstream modules see one
interface, so local versus remote stops mattering past this boundary.

### 5.2 `parser`

The tree-sitter layer. Owns a registry mapping file extension to a grammar and a set of
`.scm` query files. Its sole output is one normalized record per file:

```ts
interface ParsedFile {
  path: string
  lang: string | null
  contentHash: string
  symbols: Symbol[]
  imports: RawImport[]
  callSites: CallSite[]
  errors: ParseError[]
}
```

**This type is the load-bearing contract of the project.** No module downstream of the
parser knows what language anything was written in. Write this type first and defend it.

**What adding a language actually costs — about eight files.** An earlier version of
this section promised "a grammar and four query files … and changing nothing else". That
was false. The honest seam, as built:

*Required, for every language:*

1. **One entry in the language registry** (`src/parser/languages.ts`). The entry is a
   typed record, so it cannot be partially filled in: extensions, the wasm grammar, the
   query directory, the resolver key, the **export rule**, the **enclosing-symbol node
   types**, and the **entry-point basenames**. The last three used to be tables held
   elsewhere, and each failed *silently* when a new language omitted it — every symbol
   `exported: false` and therefore zero cross-file call edges; every `enclosingSymbol`
   null and therefore `trace_flow` and `impact_of` blind; no entry points, so
   `get_repo_overview` reports "no entry points" for a repository with an obvious one.
   They live in the registry so that omission is a compile error instead.
2. **Three query files** in `src/parser/queries/<dir>`: `symbols.scm`, `imports.scm`,
   `calls.scm`. Not four — there is no `exports.scm`; visibility is decided by the
   registry's export rule against the AST, because no language this project supports
   expresses its export surface in a way one query can capture.
3. **An import resolver** in `src/resolve`, plus its line in that directory's `index.ts`
   `RESOLVERS` map — two files. Or reuse of an existing `resolverId`, in which case
   neither is touched (the four JS-family entries share one).
4. **A row in `tests/languages.test.ts`.** Its `covers every registry entry` assertion
   compares the table's ids against `LANGUAGES`, so a language added without a row turns
   that test red.

*Required if the language's visibility rule is new — this is the case the earlier
wording got wrong by filing it as optional:*

5. **A new `ExportRule` member** (`src/parser/languages.ts`) **and its case in
   `isExported`** (`src/parser/parser.ts`). Not skippable. The switch there is exhaustive
   with no `default`, so adding the member without the case fails to compile:

   ```
   src/parser/parser.ts(217,66): error TS2366: Function lacks ending return statement
   and return type does not include 'undefined'.
   ```

   That compile error is the design, not friction. Before the export rule moved into the
   registry, this exact omission returned `false` for every symbol in the new language,
   silently, costing it every cross-file call edge. A build failure naming the line is
   the improvement. A language that reuses one of the five existing rules
   (`js-export-statement`, `python-module-level`, `go-capitalised`,
   `java-public-or-interface-member`, `rust-visibility-modifier`) skips this
   step entirely.

*Optional, depending on the language's shape:*

- `METHOD_CONTAINER_TYPES` (`src/parser/parser.ts`) — only when a method parses as a
  plain function nested inside a type body, so `symbols.scm` alone cannot tell the two
  apart (Python, Rust).
- `ENCLOSING_CLASS_TYPES` (`src/parser/parser.ts`) — only when a method's container is
  something other than `class_declaration` (Java's interfaces, enums, records and
  annotation types), or is named by a field on the method itself rather than by an
  ancestor (Go's receiver, which has its own branch).
- `SAME_PACKAGE_LANGS` (`src/indexer/same-package.ts`), plus the matching widening in
  `src/indexer/incremental.ts` — only for directory-scoped languages whose sibling files
  reference each other with no import at all (Go, Java).
- An `@member` capture in `imports.scm` — only when one import specifier is spread
  across two grammar nodes (Python's `from pkg import service`).

The difference between the two lists is failure mode, not importance. Omitting anything
required fails loudly or does not compile. Omitting an optional hook degrades one
specific, observable thing: a `method` reported as a `function`, or a same-package call
left `unresolved`. Nothing in either list fails silently any more.

### 5.3 `resolver`

Converts raw import specifiers and call sites into concrete edges, stamping each with a
confidence tier. The default resolver is filesystem-based: relative path resolution,
index-file probing, extension candidates. Per-language resolvers may override it (a
TypeScript resolver reading `tsconfig` path aliases is the first planned one).

### 5.4 `graph-store`

The only module that touches SQLite. Exposes typed queries — `callersOf`,
`dependentsOf`, `cyclesIn`, `couplingBetween` — rather than letting SQL leak upward.
Graph algorithms run in-process over loaded edge sets.

### 5.5 `summarizer` — WITHDRAWN

**This component is deliberately not built, and milestone 9 is withdrawn rather than
deferred.** The original design predates the decision to ship as an MCP server. Once the
consumer became an LLM with its own file access, a summarizer inside the tool became a
duplicate of a capability the caller already has — and a worse one, because a cached
string cannot know what the caller actually asked.

`describe_module` already returns the file list, the exported surface, dependencies and
dependents with weights, coupling metrics, and the sub-modules it excluded. A model holding
that plus `Read` produces a better summary than any cache, tailored to the question.

Building it would have added an API-key requirement, network calls, per-query cost and a
cache-invalidation problem, in exchange for none of that. It would also have cost the tool
its best property: it runs entirely locally, with no network and no per-query spend.

`describe_module` keeps returning `summary: null` with a reason, and the `summaries` table
stays in the schema — both are now the permanent shape rather than a placeholder. The one
argument that would revive this is wanting `arch` to stand alone as a CLI that prints a
readable architecture summary with no model attached; that is a different product decision,
not unfinished work on this one.

The original design follows, for the record:

Lazy, cached, LLM-generated module summaries. Invoked by tools, never by the indexer.
Cache key is the module subtree's git tree-hash, which means invalidation is automatic on
content change and summaries are shared across branches with identical subtrees.

### 5.6 `tool-surface`

MCP tool implementations. Pure composition over `graph-store`, the git handle, and
ripgrep. Contains no parsing and no storage logic.

### 5.7 `mcp-server` and `cli`

Two entry points over one core. The CLI exists because the first index of a large
repository must not happen inside a tool call that Claude is blocked on. Commands:
`arch index`, `arch reindex`, `arch status`.

## 6. Data model

Six tables, deliberately flat — every interesting question is a traversal or an
aggregate.

```sql
files      (id, path, lang, content_hash, loc, last_commit, error_count, indexed_at)
symbols    (id, file_id, name, kind, start_line, end_line,
            exported, signature, parent_symbol_id)
imports    (id, file_id, raw_specifier, resolved_file_id, kind, confidence, line)
edges      (id, src_file_id, src_symbol_id, dst_file_id, dst_symbol_id,
            dst_name, kind, confidence, line)
summaries  (module_path, tree_hash, summary, model, created_at)
meta       (key, value)   -- schema_version, head_commit, indexed_at, counts
```

Indexes on `symbols(name)`, `symbols(file_id)`, `edges(src_symbol_id)`,
`edges(dst_symbol_id)`, `edges(src_file_id)`, `edges(dst_file_id)`,
`imports(resolved_file_id)`, `files(path)`.

`src_file_id` is NOT NULL; `src_symbol_id`, `dst_file_id` and `dst_symbol_id`
are all nullable. A call at file top level has no enclosing symbol, so a
non-null `src_symbol_id` could not represent it, and file- and module-level
aggregation should join files directly rather than hopping through `symbols`.

`edges.kind` is one of `calls | extends | implements | instantiates | references`.

### 6.1 Modules are directories

There is no `modules` table. A module *is* a directory path. Module-level edges are
aggregations computed from file edges on demand. This removes an entire class of
synchronization bug at negligible query cost.

### 6.2 Confidence tiers

| Tier | Meaning |
|---|---|
| `exact` | A real type resolver verified this binding. Reserved; nothing emits it yet. |
| `resolved` | An import specifier deterministically resolved to a file on disk. |
| `heuristic` | A called name matched exactly one symbol reachable from the file's imports. |
| `unresolved` | No candidate matched at all — an external, builtin or third-party target. Carries `dst_name` with a null `dst_symbol_id`. |
| `ambiguous` | The name matched multiple candidates. **All candidates are stored.** |

`unresolved` and `ambiguous` must never be conflated; that distinction is the point of the
tier system. `unresolved` means there is nothing to be uncertain *about* — `console.log`
has no in-repo target and never will. `ambiguous` means the graph genuinely does not know
which of several real candidates is meant. Collapsing the first into the second
manufactures uncertainty: measured on a representative repository, unresolved external
calls outnumbered genuine collisions roughly 100 to 1, so a tool labelling both `ambiguous`
drowns its own signal and reports a number nobody should trust.

Note for the future `min_confidence` filter (§8): do not treat the declaration order of the
`Confidence` union as a ranking. Whether `unresolved` sorts above or below `ambiguous` is
genuinely arguable, and an implicit ordering would silently invert such a filter. Define an
explicit rank.

Storing ambiguous matches rather than discarding them is a deliberate inversion of the
obvious instinct. Under-reporting on "what could break?" is the failure mode that
destroys trust permanently; over-reporting with a visible label costs the reader a few
seconds. Ambiguity is surfaced, never dropped.

### 6.3 Call resolution

For a call to `foo()` in file F, the candidate set is: symbols declared in F, plus
symbols imported into F through `resolved` imports.

- Exactly one candidate → `heuristic` edge.
- Multiple candidates → `ambiguous` edges to all of them.
- Zero candidates → stored as an unresolved call with `dst_name` set and
  `dst_symbol_id` null. This keeps external and standard-library calls visible without
  polluting the graph with phantom nodes.

### 6.4 Derived metrics

Computed deterministically from the graph, with no LLM involvement:

- Afferent coupling (`Ca`) and efferent coupling (`Ce`) per module.
- Instability, `I = Ce / (Ca + Ce)`.
- Strongly-connected components via Tarjan, at file and module scope.
- Fan-in / fan-out outliers.
- Exported symbols with zero inbound edges.

### 6.5 Sizing

A 5,000-file repository is estimated at roughly 250,000 symbols and 500,000 edges —
a few hundred megabytes of SQLite, with millisecond queries given the indexes above.

## 7. Indexing pipeline

Six phases. The ordering constraint: a call cannot be resolved until every symbol in the
repository exists, so nodes and edges are separate passes.

```
1. discover ─► 2. parse ─► 3. persist nodes ─► 4. resolve ─► 5. persist edges ─► 6. finalize
```

**1. Discover.** `git ls-files`, not a filesystem walk — faster, and `.gitignore` is
handled correctly for free. Filter to known extensions; drop vendored trees
(`node_modules`, `vendor`, `dist`, `.venv`); skip files over ~1 MB or matching a
minified-bundle signature. Every skip is recorded with a reason.

**2. Parse.** CPU-bound and embarrassingly parallel: a `worker_threads` pool sized to
core count. Files stream in batches of ~500 — parse, normalize to `ParsedFile`, persist,
discard the AST. ASTs are never retained across batches, which bounds memory independent
of repository size.

**3. Persist nodes.** `files` and `symbols`, one transaction per batch.

**4. Resolve.** Single-threaded global join, two sub-passes. Imports first: each
specifier probed against the filesystem by the default or language-specific resolver,
producing `resolved` edges. Then call sites: build an in-memory `name → symbol[]` index
read back from SQLite, and apply §6.3 to each call site.

**5. Persist edges.** Bulk insert.

**6. Finalize.** Write `meta` and run `ANALYZE`. `meta.head_commit` is written **last and
only on success**, so an interrupted run leaves the index visibly incomplete and the next
run starts clean rather than resuming into a half-state.

### 7.1 Incremental re-index

`git diff --name-status <meta.head_commit> HEAD` supplies the committed delta.
`git status --porcelain` supplies uncommitted working-tree changes — **required**, not
optional: "what will this break?" is asked about code that has not been committed yet,
and an index that only sees HEAD is blind at exactly the moment it matters.

Changed files have their rows deleted and are re-parsed. Resolution then re-runs over a
**one-hop dilation**: the changed files plus every file that imports them. Restricting
re-resolution to changed files alone is incorrect — renaming a symbol invalidates edges
pointing at it, and adding an export can newly resolve calls that previously dangled.
The dilation is bounded and typically a few dozen files.

Deleted files cascade-delete their rows; edges pointing at them revert to unresolved.

Summary invalidation walks each changed file's ancestor directories and drops any cached
summary whose `tree_hash` no longer matches.

### 7.2 Staleness policy

Every tool call cheaply compares HEAD plus a working-tree dirty hash against `meta`.

- Under ~50 changed files: auto-reindex inline. Sub-second; the caller does not notice.
- At or above that threshold: serve results annotated `stale: true` with the change
  count and a prompt to run `arch index`. Blocking a tool call for a full minute is worse
  than a labelled stale answer.

## 8. Tool surface

**Governing principle: the index is a map, not the territory.** Claude Code already
reads code well. These tools answer what `Read` and `Grep` cannot — where to look, and
how things connect. Tools return `file:line` pointers and relationships, not source.

### Orientation

- **`get_repo_overview()`** — languages and counts, top-level module tree with sizes,
  detected entry points (`package.json` bin/main, `main()` functions, route files), key
  config files, git summary. Fully structural and cheap. The natural first call for
  "explain this architecture."
- **`describe_module(path)`** — cached module summary, public surface (exported
  symbols), dependencies and dependents with edge counts, coupling metrics, contained
  files.

### Search and navigation

- **`search_code(query, {kind, lang, path, limit})`** — hybrid: indexed symbol-name
  matches unioned with ripgrep full-text, ranked exact-symbol → partial-symbol → text.
  The workhorse for "where is authentication implemented?"
- **`get_symbol(name, {file})`** — definition site, signature, doc comment, exported
  flag, caller and callee counts.

### Graph traversal

- **`get_dependencies(target, {direction, depth, kind, min_confidence})`** — `target` is
  a file, module, or symbol; `direction` is `in` or `out`. This single parameterized tool
  subsumes callers-of, callees-of, imports, and imported-by. Four near-identical tools
  would only give the agent four chances to choose wrong.
- **`impact_of(symbol, {max_depth})`** — transitive reverse-reachability, bucketed by
  confidence tier and grouped by module. Reports in the shape "47 references — 0
  verified, 39 likely, 8 ambiguous, across 6 modules." Also flags whether the symbol is
  exported at a package boundary, since impact may then extend outside the repository.
- **`trace_flow(entry, {max_depth})`** — forward call-graph walk from an entry point,
  returned as a tree annotated with files and module boundaries crossed. Chained after
  `search_code`, this answers "what happens when a customer places an order?"

### Analysis

Deterministic aggregates; no LLM involvement.

- **`find_cycles({scope, min_size})`** — Tarjan SCCs at file or module scope, ranked by
  size and edge weight.
- **`get_coupling({scope, top_n})`** — repository-wide coupling ranking: `Ca`, `Ce`, and
  instability per module, plus the heaviest module-to-module edge pairs. Answers "which
  modules are tightly coupled?" at whole-repo scope, where `describe_module` answers it
  for one module at a time.
- **`find_hotspots({top_n})`** — technical-debt candidates, ranked by structural signals
  (size, fan-in/out, cycle membership, instability) multiplied by git signals (commit
  churn over a trailing window, default 180 days and configurable, distinct author count, bug-fix commit ratio by message
  pattern). Neither half works alone: a large stable file is fine; a small thrashing one
  is not.

  `find_hotspots` additionally surfaces **co-change coupling** — files frequently
  committed together despite having no edge between them. This is logical coupling,
  invisible to static analysis, and often where the real architectural decay is.

### Deliberately not tools

"Migrate this to microservices" and "create an ADR" are compositions: Claude calls
`find_cycles`, `find_hotspots`, and `describe_module`, then reasons and writes.
Dedicated tools would bake our opinion into what should be the model's judgment. The ADR
ships as an MCP **prompt** (a template), not a tool.

### 8.1 Rules every tool obeys

1. **Truncate loudly.** Any capped result carries `truncated: true` and `total: N`. A
   silently trimmed list is a wrong answer wearing a right answer's clothes.
2. **Confidence travels with the data**, from edge to response.
3. **Point, don't dump.** Return `file:line`.
4. **Staleness is always visible** (§7.2).

### 8.2 Minimum viable surface

If the build needs to ship earlier: `get_repo_overview`, `search_code`,
`get_dependencies`, and `impact_of` make the tool useful on day one. The remaining six
are additive and require no schema change.

## 9. Error handling and degradation

The system degrades in visible steps. Silence is never an acceptable failure mode.

| Condition | Behavior |
|---|---|
| Unknown language | File gets a `files` row with `lang: null`. It appears in the tree and stays greppable, without symbols. Never silently omitted. |
| Parse errors | Tree-sitter error recovery yields a partial tree. Keep what parsed, increment `files.error_count`. Report in aggregate: "indexed 4,812 files, 23 with parse errors." |
| Unresolvable import | `imports.resolved_file_id` null, specifier retained. Commonly a third-party package; visible as such. |
| Unresolvable call | Stored with `dst_name`, null `dst_symbol_id` (§6.3). |
| Schema version mismatch | Refuse to serve; instruct the user to reindex. No silent migration. |
| Interrupted index | `meta.head_commit` absent, so the index reads as incomplete and the next run starts clean (§7 phase 6). |
| Corrupt database | Detected on open; the directory is discarded and a full reindex is offered. |
| Summarizer unavailable (now permanent — see §5.5) | `describe_module` returns structural data with `summary: null` and a reason. This is the shipped behaviour, not a degradation. |
| Repository is not a git repo | Indexing proceeds with filesystem walk and gitignore parsing; git-dependent tools (`find_hotspots` churn signals) return a clear unavailability reason. |

## 10. Testing strategy

**Fixture repositories are the backbone.** A set of small, hand-built repositories
committed to the test suite, each with a known-correct expected graph: one per supported
language, plus targeted fixtures for a known import cycle, a deliberately ambiguous name
collision, a renamed symbol, and a deleted file. Assertions run against the expected
graph, not against snapshots — a snapshot test tells you something changed, and we need
to know whether it became *wrong*.

Layered from there:

- **Parser** — per language, `ParsedFile` output asserted against hand-written expected
  symbols, imports, and call sites. Includes a deliberately malformed file asserting
  partial recovery.
- **Resolver** — tier assignment is the highest-risk logic in the project and gets the
  densest tests: relative paths, index files, extension probing, ambiguous collisions
  producing fan-out, and unresolved external calls.
- **Graph store** — cycle detection against fixtures with known SCCs; coupling metrics
  against hand-computed `Ca`/`Ce` values.
- **Incremental indexing** — the correctness property worth the most: for a fixture
  repository, assert that *incremental reindex after a commit produces a byte-identical
  graph to a full reindex of the same state*. This single invariant catches the entire
  class of stale-edge and dilation bugs, which are otherwise near-impossible to find.
- **Tools** — contract tests on response shape, truncation flags, and confidence
  propagation.
- **Scale smoke test** — index a large real open-source repository in CI, asserting the
  performance targets in §11 and that error counts stay within bounds.

## 11. Performance targets

| Operation | Target |
|---|---|
| Cold index, 5,000 files | ~60 seconds |
| Incremental reindex, 5–20 changed files | under 1 second |
| Graph query (`get_dependencies`, `impact_of`) | under 100 ms |
| `find_cycles`, whole repo | under 2 seconds |
| Memory ceiling during indexing | **currently O(repo size), not O(batch size)** — see note |

The memory row is an aspiration the implementation does not yet meet, and this spec
previously overstated it. ASTs are discarded per batch as described, but the normalized
`ParsedFile` records and the accumulated `EdgeInput` array are held for the whole run, and
those are the bulk. Measured on a 3,000-file synthetic repository: 876 MB peak RSS, and
cutting the batch size fiftyfold moved that by 11% — batching batches only the persist
step. Meeting the stated target requires streaming records through the resolve phases
instead of materializing them, which is an architectural change, not a patch.
**Milestone 6 (incremental reindex) must not be built on the assumption that a full index
fits in memory.**

## 12. Build order

Each milestone is independently verifiable.

1. **`ParsedFile` contract and the parser** for one language, with fixtures. The contract
   is defended here or never.
2. **Schema and `graph-store`**, with node persistence.
3. **Import resolution** and the confidence tier system.
4. **Call resolution**, completing the graph.
5. **CLI `index` / `status`**, full cold path working end to end.
6. **Incremental reindex**, with the full-versus-incremental equality invariant.
7. **MCP server and the four core tools** (§8.2). *Usable from here onward.*
8. **Remaining tools**, including git-signal analysis.
9. ~~**Summarizer**, lazily cached.~~ **WITHDRAWN** — see §5.5. The MCP consumer is an LLM
   with file access, so an in-tool summarizer duplicates a capability the caller already has.
10. **Additional language grammars** — additive, one directory each.

## 13. Deferred

- TypeScript deep resolver via the compiler API, filling the `exact` tier.
- Interactive architecture visualization, as a separate project over a read-only query
  layer.
- Multi-repository indexing and cross-repository edges.
- Cross-language edge detection (for example, the React Native JS↔native bridge).
- Swift and Kotlin grammars. `@vscode/tree-sitter-wasm` covers TypeScript, TSX,
  JavaScript, Python, Go, Java, Ruby, Rust, C#, C++, PHP, Bash, CSS and
  PowerShell, but not Swift or Kotlin — those require grammars compiled
  separately before React Native native-side indexing is possible.
