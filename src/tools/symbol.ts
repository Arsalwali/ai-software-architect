import type { GraphStore } from '../store/graph-store.js'
import { escapeLikeWildcards, type Truncation } from './envelope.js'

export interface SymbolOptions {
  name: string
  /** Disambiguate by restricting to a path prefix. */
  file?: string
  limit: number
}

export interface SymbolMatch {
  name: string
  path: string
  line: number
  endLine: number
  kind: string
  exported: boolean
  signature: string | null
  parentName: string | null
  callerCount: number
  calleeCount: number
}

export interface SymbolResult {
  name: string
  matches: SymbolMatch[]
  totalMatches: number
  note?: string
  truncated?: Truncation
}

export function getSymbol(store: GraphStore, options: SymbolOptions): SymbolResult {
  const filter = {
    name: options.name,
    pathPrefix: options.file === undefined ? undefined : escapeLikeWildcards(options.file),
  }
  const total = store.countSymbols(filter)
  // Fetch only `limit` rows -- `total` above already supplies the honest
  // count from an independent query, so fetching every match just to
  // discard all but `limit` of them would buy nothing but N-1 wasted
  // caller/callee edge queries per discarded row.
  const hits = store.findSymbols({ ...filter, limit: options.limit })

  if (hits.length === 0) {
    return {
      name: options.name,
      matches: [],
      totalMatches: 0,
      note: `Symbol "${options.name}" not found in the index. It may be external, ` +
        `misspelled, or in a file that was skipped at index time.`,
    }
  }

  const matches: SymbolMatch[] = hits.map(hit => ({
    name: hit.name,
    path: hit.path,
    line: hit.startLine,
    endLine: hit.endLine,
    kind: hit.kind,
    exported: hit.exported,
    signature: hit.signature,
    parentName: hit.parentName,
    callerCount: store.edgesToSymbol(hit.id).length,
    calleeCount: store.edgesFromSymbol(hit.id).length,
  }))

  const truncated: Truncation | undefined =
    total > options.limit ? { returned: matches.length, total } : undefined
  return { name: options.name, matches, totalMatches: total, truncated }
}
