import { dirname } from 'node:path'
import { languageForPath } from '../parser/languages.js'

/**
 * Languages whose package/namespace scope IS the directory: files in the
 * same directory reference each other's declarations WITHOUT any import at
 * all (Go: same `package` clause; Java: same package, same-package access
 * needs no `import`). Cross-file call resolution for these languages must
 * therefore also search sibling files in the same directory, not only files
 * reached through a resolved import -- see task-6-fixes.md. This is the
 * failure the multi-language integration gate exists to catch: symbols and
 * `edgeConfidence` both look healthy while the entire intra-package call
 * graph is silently invisible.
 *
 * Deliberately excludes typescript/tsx/javascript/jsx/python/rust: those
 * languages genuinely require an import to reference another file's
 * declaration (even a same-directory one), so adding same-directory
 * candidates there would fabricate edges that do not exist in the source.
 */
export const SAME_PACKAGE_LANGS: ReadonlySet<string> = new Set(['go', 'java'])

/**
 * Groups paths by "language + directory" for languages in
 * `SAME_PACKAGE_LANGS` only. Returns one entry per same-package group,
 * keyed by an opaque composite string; paths in every other language are
 * omitted entirely, not grouped alone.
 */
export function groupBySamePackage(paths: Iterable<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const lang = languageForPath(path)?.id
    if (!lang || !SAME_PACKAGE_LANGS.has(lang)) continue
    const key = `${lang}\n${dirname(path)}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(path)
    else groups.set(key, [path])
  }
  return groups
}

/**
 * For every path in `paths` that belongs to a same-package language, the
 * file ids of its OTHER same-directory, same-language siblings (never
 * itself). A file whose language is outside `SAME_PACKAGE_LANGS` never
 * appears as a key, so `resolveCallsForFile`'s `sameDirectorySymbols` stays
 * empty for it -- the lookup below is `Map.get(...) ?? []` at every call
 * site, not a default entry inserted here.
 */
export function sameDirectoryFileIds(
  paths: Iterable<string>,
  fileIdByPath: Map<string, number>,
): Map<number, number[]> {
  const result = new Map<number, number[]>()
  for (const bucket of groupBySamePackage(paths).values()) {
    const ids = bucket
      .map(p => fileIdByPath.get(p))
      .filter((id): id is number => id !== undefined)
    for (const id of ids) {
      result.set(id, ids.filter(other => other !== id))
    }
  }
  return result
}
