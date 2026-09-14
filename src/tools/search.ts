import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GraphStore } from '../store/graph-store.js'
import type { Truncation } from './envelope.js'

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
/** Scan headroom above the caller's limit, so ranking has something to choose from. */
const SCAN_MULTIPLIER = 5

/**
 * Escapes SQL LIKE metacharacters so a caller-supplied query is matched
 * literally by `GraphStore.findSymbols`'s `contains`/`pathPrefix` filters,
 * which wrap the value into a `LIKE '%...%'` pattern without escaping it.
 * Without this, a query containing `_` (matches any single character) or
 * `%` (matches any run of characters) would be silently reinterpreted as a
 * wildcard — e.g. searching for `foo_bar` would also match `fooXbar`, and
 * `50%` would match far more than the literal string "50%". `\` is escaped
 * first (and is itself the escape character) so a query that already
 * contains a backslash cannot smuggle a live wildcard back in. Paired with
 * the `ESCAPE '\'` clause added to those LIKE expressions in graph-store.ts.
 */
function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

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

  const symbolLimit = limit * SCAN_MULTIPLIER
  // Escaped once and reused for both findSymbols calls below: pathPrefix
  // flows into a LIKE pattern too, so it carries the same wildcard risk as
  // `contains` and gets the same literal-match treatment.
  const pathPrefix = options.path !== undefined ? escapeLikeWildcards(options.path) : undefined
  const escapedQuery = escapeLikeWildcards(query)
  // The filter set that defines "a symbol matches this search" — shared by
  // the `contains` findSymbols call below and by countSymbols, so the total
  // it reports can never disagree with what was actually searched for.
  const symbolFilter = { contains: escapedQuery, kind: options.kind, pathPrefix, lang: options.lang }

  for (const symbol of store.findSymbols({ name: query, kind: options.kind, pathPrefix, lang: options.lang, limit: symbolLimit })) {
    push(symbolHit(symbol, SCORE_EXACT_SYMBOL))
  }
  for (const symbol of store.findSymbols({ ...symbolFilter, limit: symbolLimit })) {
    push(symbolHit(symbol, SCORE_PARTIAL_SYMBOL))
  }

  // The true number of matching symbols, independent of `symbolLimit`. An
  // exact-name match is always also a `contains` match, so this single
  // count — not the sum of the two findSymbols calls above — is the right
  // total: adding them would double-count every exact match.
  const symbolTotal = store.countSymbols(symbolFilter)

  // Full-text half. Only files that were indexed are scanned, so anything
  // skipped at index time — vendored, binary, minified, oversized — stays
  // unreachable here too, and the two views of the repo agree. This path
  // uses plain string methods (startsWith/includes), not SQL LIKE, so it
  // has no wildcard-escaping concern of its own, and it is never capped
  // before counting, so its count needs no separate "true total" query.
  let textHitCount = 0
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
        textHitCount += 1
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
  // `truncate()` would infer the total from `hits.length`, but `hits` can
  // already be short of reality: `findSymbols` applies `symbolLimit` in
  // SQL, so a query with more symbol matches than `symbolLimit` never gets
  // the excess rows into `hits` to begin with — they're not truncated by
  // `truncate()`, they're simply never fetched. Reporting `hits.length` as
  // the total in that case would be a wrong number, not an honest cap, so
  // the true total is computed independently from `symbolTotal` (a real
  // COUNT, unconstrained by symbolLimit) plus the full-text count (already
  // exhaustive, since the file scan has no SQL-style cap of its own).
  const total = symbolTotal + textHitCount
  const items = hits.slice(0, limit)
  const truncated: Truncation | undefined = items.length < total ? { returned: items.length, total } : undefined
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
