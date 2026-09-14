import { Parser, Query, type Language, type Node } from 'web-tree-sitter'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LANGUAGES, languageForPath, loadLanguage, type LanguageDef } from './languages.js'
import type { ParsedFile, SourceSymbol, SymbolKind } from '../types.js'

interface Compiled {
  language: Language
  symbols: Query
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
      })
    }
    return new RepoParser(new Parser(), compiled)
  }

  parse(path: string, source: string): ParsedFile {
    const contentHash = createHash('sha256').update(source).digest('hex')
    const def = languageForPath(path)
    if (!def) {
      return { path, lang: null, contentHash, symbols: [], imports: [], callSites: [], errors: [] }
    }

    const compiled = this.compiled.get(def.id)!
    this.parser.setLanguage(compiled.language)
    const tree = this.parser.parse(source)
    if (!tree) {
      return {
        path, lang: def.id, contentHash, symbols: [], imports: [], callSites: [],
        errors: [{ line: 1, message: 'parser returned no tree' }],
      }
    }

    try {
      return {
        path,
        lang: def.id,
        contentHash,
        symbols: extractSymbols(compiled.symbols, tree.rootNode),
        imports: [],
        callSites: [],
        errors: [],
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
