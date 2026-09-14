import { dirname, join, normalize } from 'node:path'
import type { Confidence, RawImport } from '../types.js'

export interface ResolvedImport {
  path: string | null
  confidence: Confidence
}

/** Extensions probed, in order, when a specifier carries none. */
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const INDEX_BASENAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs']

/**
 * Resolves against the set of *indexed* paths rather than the filesystem. This
 * is both faster and more correct: an import can only produce a graph edge if
 * its target is a file we actually indexed.
 */
export function resolveImport(
  fromPath: string,
  specifier: string,
  knownPaths: Set<string>,
): ResolvedImport {
  if (!specifier.startsWith('.')) {
    return { path: null, confidence: 'ambiguous' }
  }

  const base = normalize(join(dirname(fromPath), specifier)).replace(/\\/g, '/')
  if (base.startsWith('..')) {
    return { path: null, confidence: 'ambiguous' }
  }

  for (const candidate of candidatesFor(base)) {
    if (knownPaths.has(candidate)) {
      return { path: candidate, confidence: 'resolved' }
    }
  }
  return { path: null, confidence: 'ambiguous' }
}

function* candidatesFor(base: string): Generator<string> {
  yield base

  // TypeScript source for an explicit JS specifier: "./helper.js" -> "./helper.ts"
  const jsExtension = /\.(js|jsx|mjs|cjs)$/.exec(base)
  if (jsExtension) {
    const stem = base.slice(0, -jsExtension[0].length)
    for (const ext of PROBE_EXTENSIONS) yield stem + ext
  }

  for (const ext of PROBE_EXTENSIONS) yield base + ext
  for (const basename of INDEX_BASENAMES) yield `${base}/${basename}`
}

export function resolveImportsForFile(
  fromPath: string,
  imports: RawImport[],
  knownPaths: Set<string>,
): Array<{ raw: RawImport; resolvedPath: string | null; confidence: Confidence }> {
  return imports.map(raw => {
    const { path, confidence } = resolveImport(fromPath, raw.specifier, knownPaths)
    return { raw, resolvedPath: path, confidence }
  })
}
