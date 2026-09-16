import type { ImportResolver, ResolvedImport } from './index.js'

const UNRESOLVED: ResolvedImport = { path: null, confidence: 'unresolved' }

/**
 * Candidate source roots derived from the indexed `.java` paths, cached per
 * `knownPaths` identity so it is computed once per index run rather than
 * once per import (`resolve` is called once per import statement, and the
 * root set does not change within a single run).
 */
const rootsCache = new WeakMap<Set<string>, Set<string>>()

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
 * so they cost nothing at resolution time beyond a wasted lookup.
 *
 * The empty string is always included so a flat, no-source-root layout
 * (the FQN path IS the repo-relative path) still resolves.
 */
export function sourceRootsFrom(knownPaths: Set<string>): Set<string> {
  const cached = rootsCache.get(knownPaths)
  if (cached) return cached

  const roots = new Set<string>([''])
  for (const path of knownPaths) {
    if (!path.endsWith('.java')) continue
    const cut = path.lastIndexOf('/')
    if (cut === -1) continue
    const segments = path.slice(0, cut).split('/')
    for (let i = 1; i <= segments.length; i++) roots.add(segments.slice(0, i).join('/'))
  }

  rootsCache.set(knownPaths, roots)
  return roots
}

/**
 * Java import resolution against the indexed path set.
 *
 * `import com.example.Helper` names the class `Helper` in package
 * `com.example`, which by convention lives at `com/example/Helper.java` —
 * but nested under a source root such as `src/main/java` in almost every
 * real project. So the FQN-as-path is tried under every candidate root from
 * `sourceRootsFrom`, LONGEST root first, so a nested layout (the common
 * case) wins over a coincidental shallow match rather than the reverse.
 *
 * A wildcard import (`import com.example.*;`) names a package, not a class,
 * so it can never identify one file — resolving it would be a fabricated
 * guess. In THIS grammar the import query's `@specifier` capture is the
 * `scoped_identifier` node only, which for a wildcard import is the package
 * name with no trailing `.*` at all (`com.example`, not `com.example.*`) —
 * verified against tree-sitter-java.wasm. That specifier is simply looked
 * up like any other FQN and correctly comes back `unresolved` because
 * `com/example` is a directory, not a file, and `com/example.java` does not
 * exist. The `.*` guard below is therefore dead code against this grammar
 * today; it is kept anyway as a cheap defense against a future grammar or
 * query change that starts including the asterisk in the capture.
 *
 * Anything that maps to no indexed file — a JDK type, a third-party
 * dependency, or a wildcard — is `unresolved`. It is never `ambiguous`:
 * nothing matched, so there is no ambiguity to report.
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
    const roots = [...sourceRootsFrom(knownPaths)].sort((a, b) => b.length - a.length)

    for (const root of roots) {
      const candidate = root.length === 0 ? relative : `${root}/${relative}`
      if (knownPaths.has(candidate)) return { path: candidate, confidence: 'resolved' }
    }
    return UNRESOLVED
  },
}
