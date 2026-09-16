import type { GraphStore } from '../store/graph-store.js'
import { escapeLikeWildcards, truncate, type Truncation } from './envelope.js'

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
  const hits = store.findSymbols({ ...filter, limit: Math.max(total, 1) })

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

  const { items, truncated } = truncate(matches, options.limit)
  return { name: options.name, matches: items, totalMatches: matches.length, truncated }
}
