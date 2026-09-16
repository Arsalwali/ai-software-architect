import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LANGUAGES } from '../parser/languages.js'

/**
 * Conventional entry-file basenames: the union of every registered
 * language's `entryBasenames` (src/parser/languages.ts). Held in the
 * registry rather than as a literal here because omitting a language fails
 * SILENTLY -- for the whole of the multi-language plan this list was
 * JS-only, so `get_repo_overview` told every Go, Rust, Python and Java
 * repository that it had no entry points, and `impact_of`'s
 * `exportedFromEntryPoint` was false for every symbol in them.
 *
 * A union rather than a per-file language lookup, deliberately: the union
 * is exactly what the flat literal was, so moving the data into the
 * registry changed no answer for any path.
 *
 * Shared by `overview.ts` (which lists every detected entry point) and `impact.ts` (which checks whether a
 * matched symbol is exported from one) so the two surfaces can never
 * disagree about what counts as an entry point — they previously held
 * byte-identical copies of this set that drifted when only one of them
 * learned to also read `package.json`.
 */
export const ENTRY_BASENAMES = new Set(LANGUAGES.flatMap(language => language.entryBasenames))

/**
 * Collects repo-relative entry-point paths declared in `package.json`:
 * `main`, `module`, `bin` (a string, or an object of name -> string), and
 * `exports` (a string, or an object whose direct values are strings — one
 * level of nesting; a conditional-exports map nested deeper than that is
 * out of scope here). Returns an empty set, never throws, when there is no
 * `package.json` or it fails to parse.
 */
export function entryPointsFromPackageJson(repoRoot: string): Set<string> {
  const entries = new Set<string>()

  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return entries
  }

  const add = (value: unknown): void => {
    if (typeof value === 'string') entries.add(value.replace(/^\.\//, '').replace(/\\/g, '/'))
  }

  const addStringOrShallowObject = (value: unknown): void => {
    if (typeof value === 'string') { add(value); return }
    if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) add(v)
    }
  }

  add(pkg.main)
  add(pkg.module)
  addStringOrShallowObject(pkg.bin)
  addStringOrShallowObject(pkg.exports)

  return entries
}

/** True when `path` is recognised as a package entry point by either check. */
export function isEntryPoint(path: string, packageEntryPoints: Set<string>): boolean {
  const basename = path.slice(path.lastIndexOf('/') + 1)
  return ENTRY_BASENAMES.has(basename) || packageEntryPoints.has(path)
}
