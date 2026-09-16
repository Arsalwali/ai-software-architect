import { resolverFor, type ResolvedImport } from '../resolve/index.js'

export type { ResolvedImport }

/**
 * Resolves against the set of *indexed* paths rather than the filesystem. This
 * is both faster and more correct: an import can only produce a graph edge if
 * its target is a file we actually indexed.
 *
 * Dispatches to the resolver for `fromPath`'s language; see `src/resolve`.
 */
export function resolveImport(
  fromPath: string,
  specifier: string,
  knownPaths: Set<string>,
): ResolvedImport {
  return resolverFor(fromPath).resolve(fromPath, specifier, knownPaths)
}
