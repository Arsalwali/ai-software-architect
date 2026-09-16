import { languageForPath } from '../parser/languages.js'
import type { Confidence } from '../types.js'
import { javascriptResolver } from './javascript.js'
import { pythonResolver } from './python.js'
import { goResolver } from './go.js'
import { javaResolver } from './java.js'

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
   *
   * `repoRoot` is required, not optional, even though most resolvers ignore
   * it: an optional parameter would let a future language-specific resolver
   * silently skip repo context it actually needs, the exact defect Go's
   * resolver originally shipped with (it fell back to `process.cwd()`,
   * which is wrong whenever the indexed repo isn't the running process's
   * cwd — e.g. `arch index /some/other/path`). Requiring it in the
   * signature forces every resolver, including future ones, to receive the
   * real repo root explicitly and decide for itself whether it needs it.
   */
  resolve(fromPath: string, specifier: string, knownPaths: Set<string>, repoRoot: string): ResolvedImport
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
  [javaResolver.id, javaResolver],
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
