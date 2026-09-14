/**
 * Descending confidence order. `unresolved` and `ambiguous` are distinct
 * outcomes (spec §6.2/§6.3) and must never be conflated:
 *   - unresolved: no candidate matched at all — external, builtin, or
 *     third-party. There is no uncertainty here, just an absent target.
 *   - ambiguous: several candidates matched; all are stored, fanned out,
 *     rather than guessing one. This is the genuine "we're not sure" signal.
 */
export type Confidence = 'exact' | 'resolved' | 'heuristic' | 'unresolved' | 'ambiguous'

export type EdgeKind = 'calls' | 'extends' | 'implements' | 'instantiates' | 'references'

export type SymbolKind =
  | 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable'

/** A code symbol. Named SourceSymbol because `Symbol` is a JS global. */
export interface SourceSymbol {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
  exported: boolean
  signature: string | null
  /** Enclosing class name for methods, otherwise null. */
  parentName: string | null
}

export interface RawImport {
  specifier: string
  kind: 'static' | 'dynamic' | 'require'
  line: number
}

export interface CallSite {
  name: string
  line: number
  /** Name of the enclosing function/method, or null at file top level. */
  enclosingSymbol: string | null
  kind: 'calls' | 'instantiates'
}

export interface ParseError {
  line: number
  message: string
}

/**
 * The normalized output of the parser and the load-bearing contract of this
 * project. No module downstream of the parser knows what language a file was
 * written in. Keep it that way.
 */
export interface ParsedFile {
  path: string
  lang: string | null
  contentHash: string
  symbols: SourceSymbol[]
  imports: RawImport[]
  callSites: CallSite[]
  errors: ParseError[]
}
