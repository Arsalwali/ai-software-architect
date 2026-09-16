import { Parser, Query, type Language, type Node } from 'web-tree-sitter'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LANGUAGES, languageForPath, loadLanguage, type LanguageDef } from './languages.js'
import type { ParsedFile, SourceSymbol, SymbolKind, RawImport, CallSite, ParseError } from '../types.js'

interface Compiled {
  language: Language
  symbols: Query
  imports: Query
  calls: Query
}

export class RepoParser {
  private constructor(
    private readonly parser: Parser,
    private readonly compiled: Map<string, Compiled>,
  ) {}

  static async create(): Promise<RepoParser> {
    const compiled = new Map<string, Compiled>()
    for (const def of LANGUAGES) {
      const language = await loadLanguage(def)
      compiled.set(def.id, {
        language,
        symbols: new Query(language, readQuery(def, 'symbols')),
        imports: new Query(language, readQuery(def, 'imports')),
        calls: new Query(language, readQuery(def, 'calls')),
      })
    }
    return new RepoParser(new Parser(), compiled)
  }

  parse(path: string, source: string): ParsedFile {
    const contentHash = createHash('sha256').update(source).digest('hex')
    // A trailing newline does not start a new line, so an n-line file with a
    // final newline splits into n+1 parts. Counting non-final parts gives n.
    const loc = source.length === 0 ? 0 : source.split('\n').length - (source.endsWith('\n') ? 1 : 0)
    const def = languageForPath(path)
    if (!def) {
      return { path, lang: null, contentHash, loc, symbols: [], imports: [], callSites: [], errors: [] }
    }

    const compiled = this.compiled.get(def.id)!
    this.parser.setLanguage(compiled.language)
    const tree = this.parser.parse(source)
    if (!tree) {
      return {
        path, lang: def.id, contentHash, loc, symbols: [], imports: [], callSites: [],
        errors: [{ line: 1, message: 'parser returned no tree' }],
      }
    }

    try {
      return {
        path,
        lang: def.id,
        contentHash,
        loc,
        symbols: extractSymbols(compiled.symbols, tree.rootNode),
        imports: extractImports(compiled.imports, tree.rootNode),
        callSites: extractCalls(compiled.calls, tree.rootNode),
        errors: extractErrors(tree.rootNode),
      }
    } finally {
      tree.delete()
    }
  }
}

function readQuery(def: LanguageDef, name: string): string {
  return readFileSync(join(def.queryDir, `${name}.scm`), 'utf8')
}

function extractSymbols(query: Query, root: Node): SourceSymbol[] {
  const symbols: SourceSymbol[] = []
  for (const match of query.matches(root)) {
    const nameCapture = match.captures.find(c => c.name === 'name')
    const defCapture = match.captures.find(c => c.name.startsWith('def.'))
    if (!nameCapture || !defCapture) continue

    const kind = defCapture.name.slice('def.'.length) as SymbolKind
    const node = defCapture.node
    symbols.push({
      name: nameCapture.node.text,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(node),
      signature: signatureOf(node),
      parentName: kind === 'method' ? enclosingClassName(node) : null,
    })
  }
  return symbols
}

/**
 * A declaration is exported when an `export_statement` sits above it. For
 * `export const x = () => {}` the variable_declarator is two levels deeper
 * (declarator -> lexical_declaration -> export_statement), so walk a bounded
 * number of ancestors rather than assuming a fixed depth.
 */
function isExported(node: Node): boolean {
  let current: Node | null = node
  for (let depth = 0; current && depth < 3; depth++) {
    if (current.type === 'export_statement') return true
    current = current.parent
  }
  return false
}

function signatureOf(node: Node): string | null {
  const body = node.childForFieldName('body')
  const end = body ? body.startIndex : node.endIndex
  const text = node.text.slice(0, end - node.startIndex).trim()
  return text.length > 0 ? text.slice(0, 300) : null
}

function enclosingClassName(node: Node): string | null {
  let current = node.parent
  while (current) {
    if (current.type === 'class_declaration') {
      return current.childForFieldName('name')?.text ?? null
    }
    current = current.parent
  }
  return null
}

/** Names that are import mechanisms, not real call targets. */
const IMPORT_MECHANISMS = new Set(['require', 'import'])

const ENCLOSING_SYMBOL_NODES = new Set([
  'function_declaration', 'method_definition', 'arrow_function', 'function_expression',
])

function extractImports(query: Query, root: Node): RawImport[] {
  const imports: RawImport[] = []
  for (const match of query.matches(root)) {
    const specifier = match.captures.find(c => c.name === 'specifier')
    const tagged = match.captures.find(c => c.name.startsWith('import.'))
    if (!specifier || !tagged) continue
    imports.push({
      specifier: specifier.node.text,
      kind: tagged.name.slice('import.'.length) as RawImport['kind'],
      line: tagged.node.startPosition.row + 1,
    })
  }
  return imports
}

function extractCalls(query: Query, root: Node): CallSite[] {
  const calls: CallSite[] = []
  for (const match of query.matches(root)) {
    const callee = match.captures.find(c => c.name === 'callee')
    const site = match.captures.find(c => c.name === 'call' || c.name === 'new')
    if (!callee || !site) continue
    if (IMPORT_MECHANISMS.has(callee.node.text)) continue
    calls.push({
      name: callee.node.text,
      line: callee.node.startPosition.row + 1,
      enclosingSymbol: enclosingSymbolName(callee.node),
      kind: site.name === 'new' ? 'instantiates' : 'calls',
    })
  }
  return calls
}

/**
 * Walk up to the nearest enclosing function-like node and read its name. An
 * arrow function assigned to a variable takes the variable's name, which is
 * how `export const handler = () => {}` gets attributed to `handler`.
 */
function enclosingSymbolName(node: Node): string | null {
  let current = node.parent
  while (current) {
    if (ENCLOSING_SYMBOL_NODES.has(current.type)) {
      const named = current.childForFieldName('name')
      if (named) return named.text
      if (current.parent?.type === 'variable_declarator') {
        return current.parent.childForFieldName('name')?.text ?? null
      }
    }
    current = current.parent
  }
  return null
}

function extractErrors(root: Node): ParseError[] {
  if (!root.hasError) return []
  return root.descendantsOfType('ERROR').map(node => ({
    line: node.startPosition.row + 1,
    message: `syntax error near ${JSON.stringify(node.text.slice(0, 40))}`,
  }))
}
