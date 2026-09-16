import { languageForPath } from '../parser/languages.js'
import type { Confidence } from '../types.js'
import { javascriptResolver } from './javascript.js'
import { pythonResolver } from './python.js'
import { goResolver } from './go.js'

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
const RESOLVERS = new Map<string, ImportResolver>([
  [javascriptResolver.id, javascriptResolver],
  [pythonResolver.id, pythonResolver],
  [goResolver.id, goResolver],
])

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
