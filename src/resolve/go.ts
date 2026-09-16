import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportResolver, ResolvedImport } from './index.js'

const UNRESOLVED: ResolvedImport = { path: null, confidence: 'unresolved' }

/**
 * Extracts the module path from a `go.mod`'s `module` line, e.g.
 * `module example.com/m` -> `example.com/m`. Tolerates leading whitespace
 * and a trailing `//` comment (matched greedily up to the first run of
 * whitespace, so the comment marker itself is simply left unconsumed).
 * Returns null when no `module` line is present.
 */
export function modulePrefixFrom(goModContents: string): string | null {
  for (const line of goModContents.split('\n')) {
    const match = /^\s*module\s+(\S+)/.exec(line)
    if (match) return match[1]
  }
  return null
}

// go.mod is per-repository, not per-import, so its module prefix is read at
// most once per repository root and cached here rather than re-read on
// every specifier. Keyed by the root path a caller resolved against.
const prefixCache = new Map<string, string | null>()

function prefixForRoot(root: string): string | null {
  let cached = prefixCache.get(root)
  if (cached === undefined) {
    cached = null
    try {
      cached = modulePrefixFrom(readFileSync(join(root, 'go.mod'), 'utf8'))
    } catch {
      cached = null
    }
    prefixCache.set(root, cached)
  }
  return cached
}

function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * Go import resolution against the indexed path set.
 *
 * A Go import specifier is a full module path, e.g. `example.com/m/helper`.
 * Its prefix (`example.com/m`) is declared by `go.mod`'s `module` line; what
 * remains after stripping the prefix and a following slash names a
 * DIRECTORY, not a file — a Go package is one or more `.go` files sharing a
 * directory, any of which may hold the symbol a caller wants. This resolver
 * picks the first indexed `.go` file in that directory by sorted path order.
 * That is a deliberate, documented choice rather than an arbitrary one: any
 * file in the package directory shares the caller-visible symbol table, so
 * for the purposes of this graph (which resolves an IMPORT, not a specific
 * symbol) any file in the directory is an equally valid target, and "first
 * by sort order" is simply the deterministic tiebreaker.
 *
 * A specifier that does not start with the module prefix is external
 * (standard library or third-party) and resolves as `unresolved` — never
 * `ambiguous`, since nothing matched at all.
 *
 * The module prefix is not part of the shared `ImportResolver` contract (no
 * other language needs one), so `resolve` takes it as an optional fourth
 * argument rather than widening that interface for one language. When the
 * caller omits it (as the generic `resolverFor(...).resolve(...)` dispatch
 * path does — see `src/indexer/resolve-imports.ts`), the resolver falls
 * back to reading `go.mod` itself, lazily and cached per root, from the
 * process's current working directory — the same "repo root defaults to
 * cwd" convention `src/mcp/server.ts` already uses, and true for how this
 * tool is normally run (`arch serve` / `arch index` from inside the target
 * repo). A repository with no `go.mod` (or no `module` line) resolves every
 * internal import to `unresolved`, which is honest: without a module prefix
 * nothing can be told apart from an external import.
 */
export const goResolver: ImportResolver & {
  resolve(
    fromPath: string,
    specifier: string,
    knownPaths: Set<string>,
    modulePrefix?: string | null,
  ): ResolvedImport
} = {
  id: 'go',

  resolve(
    fromPath: string,
    specifier: string,
    knownPaths: Set<string>,
    modulePrefix?: string | null,
  ): ResolvedImport {
    const prefix = modulePrefix === undefined ? prefixForRoot(process.cwd()) : modulePrefix
    if (prefix === null) return UNRESOLVED

    let dir: string
    if (specifier === prefix) dir = ''
    else if (specifier.startsWith(`${prefix}/`)) dir = specifier.slice(prefix.length + 1)
    else return UNRESOLVED

    const filesInDir = [...knownPaths]
      .filter(path => path.endsWith('.go') && directoryOf(path) === dir)
      .sort()

    if (filesInDir.length === 0) return UNRESOLVED
    return { path: filesInDir[0], confidence: 'resolved' }
  },
}
