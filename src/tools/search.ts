import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GraphStore } from '../store/graph-store.js'
import { truncate, type Truncation } from './envelope.js'

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

  for (const symbol of store.findSymbols({ name: query, kind: options.kind, pathPrefix, limit: symbolLimit })) {
    push(symbolHit(symbol, SCORE_EXACT_SYMBOL))
  }
  for (const symbol of store.findSymbols({
    contains: escapeLikeWildcards(query),
    kind: options.kind,
    pathPrefix,
    limit: symbolLimit,
  })) {
    push(symbolHit(symbol, SCORE_PARTIAL_SYMBOL))
  }

  // Full-text half. Only files that were indexed are scanned, so anything
  // skipped at index time — vendored, binary, minified, oversized — stays
  // unreachable here too, and the two views of the repo agree. This path
  // uses plain string methods (startsWith/includes), not SQL LIKE, so it
  // has no wildcard-escaping concern of its own.
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
