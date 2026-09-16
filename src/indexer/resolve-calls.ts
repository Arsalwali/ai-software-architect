import type { EdgeInput, SymbolRow } from '../store/graph-store.js'
import type { CallSite } from '../types.js'

export interface ResolveCallsArgs {
  srcFileId: number
  /** Every symbol declared in the source file. */
  localSymbols: SymbolRow[]
  /** File ids this file imports through `resolved` imports. */
  importedFileIds: number[]
  /** Exported symbols grouped by file id, for the whole repository. */
  exportedByFile: Map<number, SymbolRow[]>
  /**
   * Symbols declared in OTHER files that share this file's package scope --
   * only non-empty for languages where the package IS the directory (Go,
   * Java; see `same-package.ts`), where same-package files reference each
   * other WITHOUT any import at all. Always `[]` for every other language:
   * adding same-directory candidates where an import is genuinely required
   * would fabricate edges that do not exist in the source.
   *
   * Deliberately NOT filtered by `exported`, unlike `exportedByFile` above.
   * Exported-ness gates CROSS-package access; within a package, Go sees
   * lowercase identifiers and Java sees package-private members, and both
   * are ordinary, resolvable same-package calls. Filtering this list by
   * `exported` would leave most real intra-package calls unresolved while
   * making the fix look like it worked.
   */
  sameDirectorySymbols: SymbolRow[]
  callSites: CallSite[]
}

/**
 * Spec §6.3, extended by task-6-fixes.md. The candidate set for a call is:
 * symbols declared in this file, plus symbols exported by files this file
 * resolves an import to, plus -- for Go and Java only -- symbols declared in
 * other files sharing this file's directory (see `sameDirectorySymbols`'
 * doc above for why those two languages need this and no others do).
 *
 * One candidate  -> `heuristic`
 * Several        -> `ambiguous`, fanned out to all of them
 * None           -> `unresolved`, an edge carrying only the name
 *
 * `unresolved` and `ambiguous` are deliberately distinct tiers: an
 * unresolved call (console.log, a third-party function, a builtin) carries
 * no uncertainty at all, whereas an ambiguous one genuinely could be several
 * things. Conflating them would manufacture false uncertainty at the exact
 * ratio real ambiguity is buried in.
 *
 * Ambiguous matches are stored, never dropped. Under-reporting on "what could
 * break?" is the failure that destroys trust; over-reporting with a label does not.
 */
export function resolveCallsForFile(args: ResolveCallsArgs): EdgeInput[] {
  const { srcFileId, localSymbols, importedFileIds, exportedByFile, sameDirectorySymbols, callSites } = args

  const localByName = groupByName(localSymbols)

  // Imported-file exports and same-directory siblings both feed the SAME
  // non-local candidate pool -- a name that matches one imported symbol and
  // one same-package sibling is genuinely ambiguous between the two, not a
  // case where one silently wins. Deduplicated by symbol id, not merely
  // grouped, so a same-package file that is ALSO (redundantly) imported
  // never counts its own export twice and manufactures a false `ambiguous`.
  //
  // `importedFileIds` carries one entry PER IMPORT ROW (pipeline.ts and
  // incremental.ts both `push` per raw import), so an everyday pattern like
  // `import { helper } from './m'` plus `import type { Opts } from './m'`
  // puts the same file id in twice; the `new Set(...)` below absorbs that
  // before it ever reaches the per-name id map.
  const nonLocalById = new Map<string, Map<number, SymbolRow>>()
  const addNonLocal = (symbol: SymbolRow): void => {
    let byId = nonLocalById.get(symbol.name)
    if (!byId) { byId = new Map(); nonLocalById.set(symbol.name, byId) }
    byId.set(symbol.id, symbol)
  }
  for (const fileId of new Set(importedFileIds)) {
    for (const symbol of exportedByFile.get(fileId) ?? []) addNonLocal(symbol)
  }
  for (const symbol of sameDirectorySymbols) addNonLocal(symbol)

  const symbolIdByName = new Map(localSymbols.map(s => [s.name, s.id]))
  const edges: EdgeInput[] = []

  for (const site of callSites) {
    const srcSymbolId = site.enclosingSymbol
      ? symbolIdByName.get(site.enclosingSymbol) ?? null
      : null

    // A local declaration shadows both imports and same-directory siblings,
    // so it wins outright rather than producing a spurious ambiguity.
    // Non-local candidates are sorted by (fileId, id) so the result never
    // depends on Set/Map insertion order upstream -- required for the
    // incremental-vs-full equality invariant.
    const local = localByName.get(site.name)
    const nonLocal = nonLocalById.get(site.name)
    const candidates = local ?? (nonLocal
      ? [...nonLocal.values()].sort((a, b) => a.fileId - b.fileId || a.id - b.id)
      : [])

    if (candidates.length === 0) {
      edges.push({
        srcFileId,
        srcSymbolId,
        dstFileId: null,
        dstSymbolId: null,
        dstName: site.name,
        kind: site.kind,
        confidence: 'unresolved',
        line: site.line,
      })
      continue
    }

    const confidence = candidates.length === 1 ? 'heuristic' : 'ambiguous'
    for (const candidate of candidates) {
      edges.push({
        srcFileId,
        srcSymbolId,
        dstFileId: candidate.fileId,
        dstSymbolId: candidate.id,
        dstName: site.name,
        kind: site.kind,
        confidence,
        line: site.line,
      })
    }
  }

  return edges
}

function groupByName(symbols: SymbolRow[]): Map<string, SymbolRow[]> {
  const grouped = new Map<string, SymbolRow[]>()
  for (const symbol of symbols) {
    const bucket = grouped.get(symbol.name)
    if (bucket) bucket.push(symbol)
    else grouped.set(symbol.name, [symbol])
  }
  return grouped
}
