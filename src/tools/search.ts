import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GraphStore } from '../store/graph-store.js'
import { truncate, escapeLikeWildcards, type Truncation } from './envelope.js'

export interface SearchOptions {
  query: string
  kind?: string
  lang?: string
  path?: string
  limit: number
}

export interface SearchHit {
  path: string
  line: number
  kind: 'symbol' | 'text'
  symbolName?: string
  symbolKind?: string
  exported?: boolean
  snippet: string
  score: number
}

const SCORE_EXACT_SYMBOL = 100
const SCORE_PARTIAL_SYMBOL = 60
const SCORE_TEXT = 20
const SNIPPET_MAX = 200

export function searchCode(
  store: GraphStore,
  repoRoot: string,
  options: SearchOptions,
): { hits: SearchHit[]; truncated?: Truncation } {
  const { query, limit } = options
  if (query.length === 0) return { hits: [] }

  const hits: SearchHit[] = []
  const seen = new Set<string>()

  const push = (hit: SearchHit): void => {
    const key = `${hit.path}:${hit.line}`
    if (seen.has(key)) return
    seen.add(key)
    hits.push(hit)
  }

  // Escaped once and reused for both findSymbols calls below: pathPrefix
  // flows into a LIKE pattern too, so it carries the same wildcard risk as
  // `contains` and gets the same literal-match treatment.
  const pathPrefix = options.path !== undefined ? escapeLikeWildcards(options.path) : undefined
  const escapedQuery = escapeLikeWildcards(query)
  // The filter set that defines "a symbol matches this search" — shared by
  // the `contains` findSymbols call below and by countSymbols, so the rows
  // fetched can never disagree with what was actually counted.
  const symbolFilter = { contains: escapedQuery, kind: options.kind, pathPrefix, lang: options.lang }

  // The true number of matching symbols, computed BEFORE fetching any rows
  // so it can size that fetch: passing it as the `findSymbols` LIMIT (for
  // both calls below) guarantees every matching row reaches `push()`'s
  // dedup rather than being cut off in SQL first. An exact-name match is
  // always also a `contains` match, so this one count safely bounds both
  // queries — the exact-name result set can never be larger than the
  // `contains` one, so no second count is needed for it.
  const symbolTotal = store.countSymbols(symbolFilter)

  for (const symbol of store.findSymbols({ name: query, kind: options.kind, pathPrefix, lang: options.lang, limit: symbolTotal })) {
    push(symbolHit(symbol, SCORE_EXACT_SYMBOL))
  }
  for (const symbol of store.findSymbols({ ...symbolFilter, limit: symbolTotal })) {
    push(symbolHit(symbol, SCORE_PARTIAL_SYMBOL))
  }

  // Full-text half. Only files that were indexed are scanned, so anything
  // skipped at index time — vendored, binary, minified, oversized — stays
  // unreachable here too, and the two views of the repo agree. This path
  // uses plain string methods (startsWith/includes), not SQL LIKE, so it
  // has no wildcard-escaping concern of its own, and — like the symbol
  // queries above, now that they are sized to symbolTotal — it is
  // exhaustive: every matching line reaches `push()`, uncapped.
  if (options.kind === undefined) {
    const needle = query.toLowerCase()
    for (const path of store.allFilePaths()) {
      if (options.path !== undefined && !path.startsWith(options.path)) continue
      if (options.lang !== undefined && store.fileRow(path)?.lang !== options.lang) continue

      let source: string
      try {
        source = readFileSync(join(repoRoot, path), 'utf8')
      } catch {
        continue   // file vanished since indexing; the freshness gate reports that separately
      }
      if (!source.toLowerCase().includes(needle)) continue

      const lines = source.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue
        push({
          path,
          line: i + 1,
          kind: 'text',
          snippet: lines[i].trim().slice(0, SNIPPET_MAX),
          score: SCORE_TEXT,
        })
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
  // `hits` now holds every distinct matching `path:line` location exactly
  // once: the symbol queries above are sized to `symbolTotal` so nothing is
  // dropped by SQL before it reaches `push()`'s dedup, and the full-text
  // scan was always exhaustive. That makes `hits.length` the true total —
  // including the overlap where a symbol's own declaration line is also a
  // full-text match, which `seen` already collapses to one entry — so
  // `truncate()` can derive `total` directly with no separate counting or
  // arithmetic (summing independently-computed counts would double-count
  // exactly that overlap).
  const { items, truncated } = truncate(hits, limit)
  return { hits: items, truncated }
}

function symbolHit(
  symbol: { path: string; startLine: number; name: string; kind: string; exported: boolean; signature: string | null },
  score: number,
): SearchHit {
  return {
    path: symbol.path,
    line: symbol.startLine,
    kind: 'symbol',
    symbolName: symbol.name,
    symbolKind: symbol.kind,
    exported: symbol.exported,
    snippet: (symbol.signature ?? symbol.name).slice(0, SNIPPET_MAX),
    score,
  }
}
