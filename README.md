# ai-software-architect

Indexes a repository into a queryable architecture graph — files, symbols,
imports, and call/extends/implements/instantiates edges with an honest
confidence tier on each one — and exposes it to Claude Code (or any MCP
client) as a set of tools for answering "how does this codebase work"
questions.

## CLI

```bash
arch index [repo]    # build or incrementally update the index (default: .)
arch status [repo]   # report index freshness: current, stale, incomplete, or missing
arch serve            # run the MCP server on stdio
```

`arch index` is incremental by default — pass `-F`/`--full` to force a cold
rebuild, or `-f`/`--force` to delete a broken index (e.g. after a schema
version mismatch) before rebuilding. `-q`/`--quiet` suppresses progress
output.

## Using it from Claude Code

Index a repository once, then register the server:

```bash
arch index /path/to/repo
claude mcp add architect -- node /absolute/path/to/dist/cli.js serve
```

Or add it to `.mcp.json` in a project:

```json
{
  "mcpServers": {
    "architect": {
      "command": "node",
      "args": ["/absolute/path/to/dist/cli.js", "serve"]
    }
  }
}
```

Every tool takes an optional `repo` argument and defaults to the working
directory. The index refreshes itself: a small change is absorbed on the next
tool call, and a large one comes back labelled `stale` with a count rather than
blocking the call.

**A caveat about that default matters for how you register the server.**
`repo` defaults to `process.cwd()`, and for a spawned MCP server that
directory is frozen at spawn time — whatever the client's working directory
happened to be when it launched the process. Project-scoped registration
(the `.mcp.json` form above, or `claude mcp add` run from inside the project)
is fine, because the client spawns the server with the project root as its
cwd. It is silently wrong for a **user-level or global** registration: the
server will index whatever directory it happens to be spawned from — not
necessarily the repository you're asking about — and return a confident,
wrong-repo answer with no error to signal the mismatch. If you register
`architect` globally for use across multiple repositories, pass `repo`
explicitly on every call (or have the client do so) rather than relying on
the default.

### The ten tools

**Orientation**

- `get_repo_overview` — structural overview of an indexed repository: file
  and symbol totals, languages, top-level modules, detected entry points,
  skipped files by reason, and the edge confidence breakdown. Start here.
- `describe_module` — a module's files, exported surface, dependencies and
  dependents with weights, and coupling metrics. Covers only files directly
  inside the named directory; files in a nested directory belong to their
  own module. `subModules` lists those nested module paths so you can query
  each one in turn.

**Search and navigation**

- `search_code` — find symbols and text in the indexed repository, ranked
  exact-symbol then partial-symbol then full text.
- `get_symbol` — definition site, signature, export status, and
  caller/callee counts for every symbol matching a name.

**Graph traversal**

- `get_dependencies` — walk the dependency graph from a file, directory, or
  symbol, in either direction, with a confidence filter.
- `impact_of` — what could break if a symbol changes, as transitive
  references bucketed by evidence.
- `trace_flow` — forward call-graph walk from an entry point, as a tree
  annotated with files and module boundaries crossed. `depthLimited` means
  the walk was cut short by `maxDepth`; `limitReached` means it was cut
  short instead because the node budget (`limit`) ran out — a separate,
  equally load-bearing reason the tree may be incomplete.

**Analysis**

- `find_cycles` — strongly-connected components in the dependency graph, at
  module or file scope.
- `get_coupling` — per-module afferent/efferent coupling and instability,
  plus the heaviest module-to-module dependencies.
- `find_hotspots` — technical-debt candidates ranked by structural weight
  multiplied by git churn, with every raw signal reported alongside the
  score.

The three analysis tools are built to be honest about their own limits
rather than to look more authoritative than the data supports. `get_coupling`
weights each module-to-module edge by the number of distinct file-to-file
dependencies crossing the boundary, not by import statement count, so a file
that imports the same neighbour twice is not double-counted. `find_hotspots`
depends on git history for its churn signal; outside a git repository (or
when history collection otherwise fails) it reports `gitAvailable: false`
and degrades to a structural-only ranking rather than fabricating a churn
number. `find_cycles` flags a module-scope cycle's `aggregationArtifact` as
`true` when it exists only because unrelated files happen to share a parent
directory, not because anything in the code actually depends circularly —
that distinction is the difference between a result worth investigating and
one worth ignoring. And across every tool, any list capped by `limit`
reports its true, uncapped total in a `truncated` field rather than
silently trimming the answer.

### What the confidence tiers mean

Every edge carries the evidence behind it, and the distinction matters. The
five literal tier values — the strings you'll actually see in
`get_repo_overview`'s `edgeConfidence` and in `get_dependencies`'
`minConfidence` enum — are:

- **exact** — a type resolver confirmed the binding. Nothing emits this yet.
- **resolved** — the tier an import edge carries when its specifier resolves
  to a file inside this repository.
- **heuristic** — the name matched exactly one candidate reachable from the
  file's imports.
- **ambiguous** — the name matched several candidates. All are reported,
  because under-reporting what might break is worse than over-reporting it.
- **unresolved** — no candidate in this repository. External, builtin, or
  third-party. Not uncertainty, just an absent target.

`unresolved` and `ambiguous` are never conflated: an absent target and a
genuinely uncertain one are different findings, and merging them would hide
which case you're in.

`impact_of` reports a coarser, three-way grouping in its `buckets` field
instead of the five raw tiers, because it's answering "how sure are we,"
not "which mechanism produced this edge":

| `impact_of` bucket | built from tier(s)   |
| ------------------- | -------------------- |
| `verified`           | `exact`               |
| `likely`             | `resolved`, `heuristic` |
| `ambiguous`          | `ambiguous`           |

`unresolved` edges cannot appear in `impact_of`'s buckets at all — they
point at no symbol, so a reverse-reachability search from a symbol never
reaches them.

`impact_of` additionally reports whether a matched symbol is exported from a
file it recognises as a package entry point, as `exportedFromEntryPoint`.
`false` means only "not detected as an entry point by this check" — it is
not a safety verdict, and it is not a claim that changing the symbol is safe.
An unconventionally named entry file, or one with no matching `package.json`
declaration, will also read `false`.

Entry points are detected by conventional basename plus, for JavaScript and
TypeScript, `package.json`'s `main`/`module`/`bin`/`exports`. Each language
declares its own basenames in the parser's language registry — `index.*`,
`main.*`, `server.*`, `app.*` and `cli.*` for JS/TS, `main.go`, `main.rs`,
`__main__.py` and `Main.java` for the rest.

## Language support

Symbols, imports and call sites are extracted for **TypeScript, TSX,
JavaScript, JSX, Python, Go, Java, and Rust**. Each language pairs a
tree-sitter grammar with a resolver that turns raw import specifiers into
edges between files:

- **Python** — resolves `import`/`from ... import` specifiers as module
  paths relative to the repository root (absolute, e.g. `pkg.service`) and
  relative to the importing file (`from .helper import helper`), matching
  them against indexed `.py` files and `__init__.py` packages. For the
  `from <module> import <name>` form the imported name is part of the
  target: `from pkg import service` resolves to `pkg/service.py` when that
  submodule exists, and falls back to `pkg/__init__.py` when the name is an
  item defined there (`from pkg import Service`) rather than a submodule.
- **Go** — strips the module path declared in `go.mod`'s `module` line from
  the front of the import specifier; what remains names a package
  **directory**, not a file (a Go package is one or more `.go` files sharing
  a directory). The resolver does not consult the importing file's own
  location at all — only the specifier and `go.mod` — and picks the first
  `.go` file in the target directory by sorted path as the `imports` table's
  single `resolvedFileId`, a deterministic tiebreaker for a relationship
  that is really directory-to-directory. Call resolution then considers
  every file in that directory, not only the one the import row points at
  (see below) — otherwise a multi-file package's calls into a file other
  than the sorted-first one would silently stay unresolved.
- **Java** — derives one or more source roots (e.g. `src/main/java`) from the
  indexed paths themselves rather than assuming a convention, then resolves
  a named import's fully-qualified name against `<sourceRoot>/<package
  path>/<Type>.java`. A `com.example.*` wildcard captures as the bare
  package name, which names a directory, not a file, and resolves
  `unresolved` rather than guessing a member.
- **Rust** — resolves `use` paths as a module tree rooted at each file's own
  crate root (the nearest ancestor `main.rs`/`lib.rs`), handling
  `crate::`/`self::`/`super::` paths, module-directory `mod.rs` files, and
  crate-root items (`crate::Item` falling through to `lib.rs`/`main.rs`
  itself).

**An unresolved import yields no edge.** A repository whose import style the
resolver does not recognise will index with real symbols and files but a
sparse dependency graph: `get_repo_overview`'s `edgeConfidence` and per-file
`imports.confidence` make this visible rather than hiding it behind a
confident-looking but empty answer. `ambiguous` (several candidates matched)
and `unresolved` (no candidate matched — an external package, the standard
library, or an import form not yet understood) are reported as distinct
tiers; never assume one when you see the other.

**Go and Java scope names by directory, not by import.** Neither language
requires an import between two files in the same package — a common idiom
(one package split across many files in a single directory, e.g.
spf13/cobra; two classes in one Java package) means calls between those
sibling files carry no import edge at all. Cross-file call resolution for
these two languages therefore also searches every OTHER file in the same
directory, not only files reached through a resolved import, and does so
without filtering by export status: Go sees lowercase identifiers and Java
sees package-private members within their own package, and both are
ordinary, resolvable same-package calls — filtering them out would leave
most real intra-package calls unresolved. TypeScript, JavaScript, Python,
and Rust are unaffected: those languages genuinely require an import (or a
`use`/`crate::` path) to reference another file's declaration, so no
same-directory fallback is applied there.

This fixes `impact_of`, `trace_flow`, and `get_dependencies` for
same-package Go/Java calls — re-indexing spf13/cobra after this fix went
from 0 to 1,437 cross-file heuristic call edges among its own `.go` files.
It does **not** change `get_coupling` or `find_cycles`: both build their
module graph from resolved *imports* aggregated by directory, and a
same-package call is by definition a same-directory one, which that
aggregation always drops as internal to one module regardless of how the
call itself resolves. A Go package that is one directory with no
subpackages — cobra's own root package is exactly this shape — will
therefore always show `efferent: 0` for that module in `get_coupling`, not
because the call graph is invisible (it is not, once you ask `trace_flow`
or `impact_of`) but because inter-module coupling has nothing to measure
when a package never crosses a directory boundary. A per-module count of
purely-internal (both ends inside the same module) call pairs would answer
the question a single-package repo's user actually has here; it does not
exist today and is recorded as a recommended follow-up, not a defect in
this plan.

**Go's package-directory resolution has the same blind spot, one level out,
and is fixed the same way.** `goResolver` resolves a package import to only
the first `.go` file in its directory by sorted path (see above) — a fine
choice for the `imports` table's one-file-per-row shape, but a real Go
package's exported symbol can live in any file in that directory, so a
call into a symbol defined in a file other than the sorted-first one used
to silently resolve to `unresolved`. Call resolution for Go imports now
expands to every file sharing the resolved import's directory, the same
way same-package resolution does above. Re-indexing spf13/cobra with both
fixes applied: cross-file heuristic call edges rose further, from 1,437 to
1,608. This does **not** move the *import*-resolution percentage (cobra's
stays 12/190, 6.3%): that number was never about which file a resolved
import's directory picked, only about how many of cobra's import
specifiers name an external package (standard library, `spf13/pflag`, …)
that isn't in the repository at all — genuinely `unresolved`, not a
resolver defect. See
`.superpowers/sdd/2026-09-16-multi-language/task-6-report.md` for the full
before/after measurement and the kill-the-resolver verification matrix.

**Not supported.** The following grammars ship inside the installed
`@vscode/tree-sitter-wasm` package but have no query files and no resolver:
Ruby, C#, PHP, C++, bash, CSS, INI, PowerShell, and regex. A file in one of
these languages is still discovered and indexed, but with `lang: null` and
no symbols — it contributes to `totals.files` but not to `totals.symbols`,
and shows up in `get_repo_overview`'s language breakdown as a `null`-language
row rather than silently vanishing.
