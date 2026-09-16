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
 * A specifier's LAST segment may name an item rather than a module: the
 * import query composes `from pkg import service` into `pkg.service` (see
 * src/parser/queries/python/imports.scm), and the imported name is a
 * submodule for that form but an `__init__` attribute for `from pkg import
 * Service`. Both are tried, longest first — see `resolve` below.
 *
 * Anything that maps to no indexed file is `unresolved`, which is the right
 * answer for a standard-library or site-packages import. It is never
 * `ambiguous`: nothing matched, so there is no ambiguity to report.
 */
export const pythonResolver: ImportResolver = {
  id: 'python',

  // `_repoRoot`: unused. Python resolution only needs the dotted specifier
  // and the indexed path set — nothing repo-level like Go's go.mod prefix.
  // Named and prefixed rather than omitted so a reader can see the omission
  // is deliberate, not a signature that fell out of date.
  resolve(fromPath: string, specifier: string, knownPaths: Set<string>, _repoRoot: string): ResolvedImport {
    const base = specifier.startsWith('.')
      ? relativeBase(fromPath, specifier)
      : { dir: '', rest: specifier }

    if (base === null) return UNRESOLVED

    const segments = base.rest.length === 0 ? [] : base.rest.split('.')

    // A specifier's last segment may name an ITEM inside a module rather
    // than a module of its own — `from pkg import Service` composes to
    // `pkg.Service` (see python/imports.scm), and `Service` is a class, not
    // a file. So the FULL path is tried first (longest form, so a real
    // `pkg/service.py` submodule wins over `pkg/__init__.py`'s attribute of
    // the same name — which is the binding Python itself produces for
    // `from pkg import service`), then the path with its last segment
    // dropped. The same two-attempt shape javaResolver and rustResolver
    // already use, for the same reason.
    //
    // The dropped attempt is skipped when it would leave nothing: a
    // single-segment absolute specifier such as `os` or `typing` must stay
    // `unresolved`, not fall through to a candidate built from an empty
    // module path.
    const attempts = segments.length > 1 ? [segments, segments.slice(0, -1)] : [segments]
    for (const attempt of attempts) {
      const joined = [base.dir, ...attempt].filter(s => s.length > 0).join('/')
      if (joined.length === 0) continue
      for (const candidate of [`${joined}.py`, `${joined}/__init__.py`]) {
        if (knownPaths.has(candidate)) return { path: candidate, confidence: 'resolved' }
      }
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
