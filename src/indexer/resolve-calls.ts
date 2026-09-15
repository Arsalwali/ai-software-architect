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
  callSites: CallSite[]
}

/**
 * Spec §6.3. The candidate set for a call is: symbols declared in this file,
 * plus symbols exported by files this file resolves an import to.
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
  const { srcFileId, localSymbols, importedFileIds, exportedByFile, callSites } = args

  const localByName = groupByName(localSymbols)

  const importedByName = new Map<string, SymbolRow[]>()

  // Deduplicated here, at the shared chokepoint both the cold and
  // incremental pipelines funnel through, rather than at either call site:
  // `importedFileIds` carries one entry PER IMPORT ROW (pipeline.ts and
  // incremental.ts both `push` per raw import), so an everyday pattern like
  // `import { helper } from './m'` plus `import type { Opts } from './m'`
  // puts the same file id in twice. Without this dedup, every exported
  // symbol of that file enters `importedByName` twice, manufacturing a
  // `candidates.length === 2` and a false `ambiguous` edge out of what is
  // really a single, unambiguous candidate.
  for (const fileId of new Set(importedFileIds)) {
    for (const symbol of exportedByFile.get(fileId) ?? []) {
      const bucket = importedByName.get(symbol.name)
      if (bucket) bucket.push(symbol)
      else importedByName.set(symbol.name, [symbol])
    }
  }

  const symbolIdByName = new Map(localSymbols.map(s => [s.name, s.id]))
  const edges: EdgeInput[] = []

  for (const site of callSites) {
    const srcSymbolId = site.enclosingSymbol
      ? symbolIdByName.get(site.enclosingSymbol) ?? null
      : null

    // A local declaration shadows imports, so it wins outright rather than
    // producing a spurious ambiguity.
    const candidates = localByName.get(site.name) ?? importedByName.get(site.name) ?? []

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
