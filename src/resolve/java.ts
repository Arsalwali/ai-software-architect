import type { ImportResolver, ResolvedImport } from './index.js'

const UNRESOLVED: ResolvedImport = { path: null, confidence: 'unresolved' }

/**
 * Candidate source roots derived from the indexed `.java` paths, cached per
 * `knownPaths` identity so it is computed once per index run rather than
 * once per import (`resolve` is called once per import statement, and the
 * root set does not change within a single run). The cached value is
 * already the SORTED array, not just the `Set` — sorting is O(n log n) and
 * measurably expensive on a large repo (~1000+ roots), so re-sorting it on
 * every `resolve` call would silently defeat the "computed once" intent
 * this cache exists for.
 */
const sortedRootsCache = new WeakMap<Set<string>, string[]>()

function sortedRootsFrom(knownPaths: Set<string>): string[] {
  const cached = sortedRootsCache.get(knownPaths)
  if (cached) return cached

  const roots = new Set<string>([''])
  for (const path of knownPaths) {
    if (!path.endsWith('.java')) continue
    const cut = path.lastIndexOf('/')
    if (cut === -1) continue
    const segments = path.slice(0, cut).split('/')
    for (let i = 1; i <= segments.length; i++) roots.add(segments.slice(0, i).join('/'))
  }

  // Longest first purely for readability of a trace/debugger session (a
  // nested layout's real root sorts before its own shallower prefixes).
  // Correctness no longer depends on this order: `resolve` below collects
  // EVERY matching candidate regardless of which root produced it, rather
  // than returning on the first hit, so traversal order cannot change the
  // result the way it did before this fix (see task-4-fixes.md finding 2).
  const sorted = [...roots].sort((a, b) => b.length - a.length)
  sortedRootsCache.set(knownPaths, sorted)
  return sorted
}

/**
 * Derives every plausible Java source root from the indexed path set.
 *
 * The package a file declares is not recoverable from its path alone
 * (nothing on disk says where `com/example` starts), so instead of trying
 * to find "the" source root, this collects every PREFIX of a `.java`
 * file's directory chain as a candidate: for `a/b/c/D.java` that is `''`,
 * `'a'`, `'a/b'` and `'a/b/c'`. One of those prefixes is genuinely the
 * project's source root (e.g. `src/main/java` for a Maven layout) and the
 * rest are simply never a prefix an FQN-derived path will also start with,
 * so they cost nothing at resolution time beyond a wasted lookup — except
 * on the rare occasion one of them ALSO happens to coincide with a real
 * file (see `resolve`'s handling of that below).
 *
 * The empty string is always included so a flat, no-source-root layout
 * (the FQN path IS the repo-relative path) still resolves.
 *
 * Exposed as a `Set` (tests and any external caller want set semantics);
 * `resolve` itself uses the cached sorted array directly rather than
 * rebuilding one from this Set on every call.
 */
export function sourceRootsFrom(knownPaths: Set<string>): Set<string> {
  return new Set(sortedRootsFrom(knownPaths))
}

/**
 * True iff `root` is a path-PREFIX of `path` at a segment boundary — i.e.
 * `root` is `path` itself, or `path` continues immediately after `root`
 * with a `/`. Plain `startsWith` would wrongly accept `'src/ma'` as a
 * prefix of `'src/main/...'`; requiring the boundary rules that out. The
 * empty root is a prefix of everything (a flat layout has no root
 * segments to fail to match).
 */
function isPathPrefix(root: string, path: string): boolean {
  if (root === '') return true
  return path === root || path.startsWith(`${root}/`)
}

/**
 * Java import resolution against the indexed path set.
 *
 * `import com.example.Helper` names the class `Helper` in package
 * `com.example`, which by convention lives at `com/example/Helper.java` —
 * but nested under a source root such as `src/main/java` in almost every
 * real project, and a real repository can have MANY such roots (one per
 * Maven/Gradle module, plus a `main`/`test` split within each). So instead
 * of returning on the first matching root, this collects EVERY candidate
 * path that exists in `knownPaths` across every root from
 * `sourceRootsFrom`, then picks among them:
 *
 * 1. Partition the candidates into those whose root is a path-prefix of
 *    `fromPath` ("same-root" — plausibly the importing file's own module)
 *    and those that aren't ("other").
 * 2. Exactly one same-root candidate -> `resolved` to it: the importing
 *    file's own module has exactly one file that could satisfy this FQN.
 * 3. Several same-root candidates -> `ambiguous`: more than one file in
 *    the importer's own module claims this FQN, and nothing here can tell
 *    them apart.
 * 4. No same-root candidate: fall back to the "other" bucket with the same
 *    exactly-one/several/none rule. This is what makes a Maven `main`/
 *    `test` split work — a test file has no source-root candidate of its
 *    own for a main-tree class, so it correctly falls through to the
 *    single real candidate under `src/main/java`.
 *
 * `ResolvedImport` holds a single `path`, so an `ambiguous` result cannot
 * list every candidate the way call resolution can — it reports the
 * lexicographically-first candidate alongside the `ambiguous` flag rather
 * than `path: null`. `null` would make `ambiguous` and `unresolved`
 * indistinguishable in the graph, silently re-collapsing the two tiers
 * this project does real work to keep apart; `CONFIDENCE_RANK` already
 * ranks `ambiguous` below `heuristic` so downstream tools discount it. The
 * sort is not cosmetic: it is what makes the chosen path deterministic
 * across machines and across a cold vs. incremental run, rather than
 * hostage to `Set`/filesystem iteration order.
 *
 * HONEST LIMITATION: this is a path-pattern approximation, not a real
 * classpath resolver — it never reads a file's own `package` declaration,
 * because nothing upstream of this resolver parses that far ahead of time.
 * Two files in different modules can each legitimately claim the same FQN
 * (or, rarer, a coincidental directory layout can make an unrelated file
 * look like a match — see task-4-fixes.md finding 2), and this resolver
 * cannot always tell them apart. Where it can't, it reports `ambiguous`
 * rather than guessing — failing loudly instead of silently returning a
 * confident wrong answer.
 *
 * A wildcard import (`import com.example.*;`) names a package, not a
 * class, so it can never identify one file — resolving it would be a
 * fabricated guess. In THIS grammar the import query's `@specifier`
 * capture is the `scoped_identifier` node only, which for a wildcard
 * import is the package name with no trailing `.*` at all (`com.example`,
 * not `com.example.*`) — verified against tree-sitter-java.wasm. That
 * specifier is simply looked up like any other FQN and correctly comes
 * back `unresolved` because `com/example` is a directory, not a file, and
 * `com/example.java` does not exist. The `.*` guard below is therefore
 * dead code against this grammar today; it is kept anyway as a cheap
 * defense against a future grammar or query change that starts including
 * the asterisk in the capture.
 *
 * Anything that maps to no indexed file at all — a JDK type or a
 * third-party dependency — is `unresolved`, never `ambiguous`: nothing
 * matched, so there is no ambiguity to report.
 */
export const javaResolver: ImportResolver = {
  id: 'java',

  // `_repoRoot`: unused. Java derives its source roots from the indexed
  // path set itself (`sourceRootsFrom`), unlike Go which needs the repo
  // root to locate and read `go.mod`. Named and prefixed rather than
  // omitted so a reader can see the omission is deliberate, not a
  // signature that fell out of date.
  resolve(fromPath: string, specifier: string, knownPaths: Set<string>, _repoRoot: string): ResolvedImport {
    if (specifier.endsWith('.*')) return UNRESOLVED

    const relative = specifier.split('.').join('/') + '.java'
    const roots = sortedRootsFrom(knownPaths)

    const sameRoot: string[] = []
    const other: string[] = []
    for (const root of roots) {
      const candidate = root.length === 0 ? relative : `${root}/${relative}`
      if (!knownPaths.has(candidate)) continue
      ;(isPathPrefix(root, fromPath) ? sameRoot : other).push(candidate)
    }

    const bucket = sameRoot.length > 0 ? sameRoot : other
    if (bucket.length === 0) return UNRESOLVED

    const sorted = [...bucket].sort()
    return { path: sorted[0], confidence: bucket.length === 1 ? 'resolved' : 'ambiguous' }
  },
}
