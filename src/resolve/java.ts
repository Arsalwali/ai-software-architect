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
 * Number of leading path segments `a` and `b` share, compared
 * SEGMENT-by-segment rather than character-by-character: `'moduleA'` and
 * `'moduleAB'` share zero segments even though they share a long common
 * character prefix, because as path segments they are simply different
 * directory names.
 */
function sharedLeadingSegments(a: string, b: string): number {
  const as = a.split('/')
  const bs = b.split('/')
  let n = 0
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++
  return n
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
 * `sourceRootsFrom`, then RANKS them by how many leading path segments
 * they share with `fromPath` (`sharedLeadingSegments`):
 *
 * - A unique maximum -> `resolved` to that candidate: it is the closest
 *   match to the importing file's own location, by construction the most
 *   plausible "this is the same module/source-set" candidate.
 * - Several candidates tied at the maximum -> `ambiguous`.
 * - No candidates at all -> `unresolved`.
 *
 * An earlier version of this rule (fix round 1) partitioned candidates
 * into two buckets — "same root as `fromPath`" vs "other" — rather than
 * ranking them. That partition could not tell a per-module `main`/`test`
 * split apart from a genuinely unrelated module: a module's own `test`
 * root is never a path-ancestor of that SAME module's `main` root (they
 * are siblings), so the partition treated "my own module's main class"
 * and "some other module's same-named class" identically once the
 * importer was itself under a `test` root, and both fell into the same
 * "other" bucket — producing `ambiguous` where the importer's own module
 * should have won outright. A single ranking by shared leading segments
 * fixes this directly: the importer's own module necessarily shares more
 * leading segments (e.g. `moduleB/src`) than an unrelated module does
 * (0), without needing a same-root/other split at all. This subsumes the
 * round-1 partition and its longest-root-first tiebreak, so both are
 * deleted rather than kept alongside the new rule.
 *
 * `ResolvedImport` holds a single `path`, so an `ambiguous` result cannot
 * list every candidate the way call resolution can — it reports the
 * lexicographically-first tied candidate alongside the `ambiguous` flag
 * rather than `path: null`. `null` would make `ambiguous` and
 * `unresolved` indistinguishable in the graph, silently re-collapsing the
 * two tiers this project does real work to keep apart; `CONFIDENCE_RANK`
 * already ranks `ambiguous` below `heuristic` so downstream tools
 * discount it. The sort is not cosmetic: it is what makes the chosen path
 * deterministic across machines and across a cold vs. incremental run,
 * rather than hostage to `Set`/filesystem iteration order.
 *
 * HONEST LIMITATION: this is a path-pattern approximation, not a real
 * classpath resolver — it never reads a file's own `package` declaration,
 * because nothing upstream of this resolver parses that far ahead of
 * time. Two files in different modules can each legitimately claim the
 * same FQN, and a coincidental directory layout can make an unrelated
 * file look like an equally good match (see task-4-fixes.md finding 2).
 * When a "coincidental deeper" file's path is exactly the real file's
 * directory plus one extra segment before its own filename, the two
 * candidates diverge from `fromPath` at that one extra segment, and which
 * one shares more leading segments depends on what `fromPath` itself has
 * at that exact position: when the importer sits at the divergence point
 * (the ordinary case — importing a neighbour in one's own package), the
 * ranking discriminates correctly and the real file wins outright; when
 * the importer sits elsewhere, both candidates tie and the result is
 * `ambiguous` (task-4-fixes-round2.md and task-4-fixes-round3.md). Both
 * outcomes are intended, not a defect in either direction — the ranking
 * is not "can only tie or lose," it genuinely discriminates when the
 * importer's own path carries the deciding information.
 *
 * A narrower, still-open residual (task-4-fixes-round4.md, item 3, ruled
 * explicitly OUT of scope for this task): the ranking can still return
 * `resolved` on a WRONG file when a decoy sits under a bogus "source
 * root" that happens to be nearer the importer than the real target — for
 * example a checked-in shaded/vendored copy
 * (`…/org/vendor/shaded/com/example/Helper.java`) or a package-shaped
 * test-fixture directory. `sourceRootsFrom` cannot tell a genuine source
 * root from a coincidental directory that merely looks like one, because
 * it works from indexed paths alone. The real fix is to validate a
 * candidate root against that file's own `package` declaration, which
 * needs per-file package metadata plumbed through the resolver seam and
 * the parse pipeline — a change bigger than this resolver, and its own
 * task, not a patch here. The exposure is narrow in practice (shading
 * normally happens to built jars, not to checked-in sources) and the
 * blast radius is one mis-pointed edge, not a systemic failure; this
 * resolver still fails loudly via `ambiguous` whenever it genuinely
 * cannot tell candidates apart, and only fails silently in this specific,
 * narrower decoy shape.
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

    const candidates: string[] = []
    for (const root of roots) {
      const candidate = root.length === 0 ? relative : `${root}/${relative}`
      if (knownPaths.has(candidate)) candidates.push(candidate)
    }
    if (candidates.length === 0) return UNRESOLVED

    let bestScore = -1
    let winners: string[] = []
    for (const candidate of candidates) {
      const score = sharedLeadingSegments(fromPath, candidate)
      if (score > bestScore) {
        bestScore = score
        winners = [candidate]
      } else if (score === bestScore) {
        winners.push(candidate)
      }
    }

    const sorted = [...winners].sort()
    return { path: sorted[0], confidence: winners.length === 1 ? 'resolved' : 'ambiguous' }
  },
}
