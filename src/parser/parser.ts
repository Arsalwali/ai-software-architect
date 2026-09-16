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
        symbols: extractSymbols(compiled.symbols, tree.rootNode, def.id),
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

/**
 * Node types whose presence in a definition's ancestor chain means the
 * definition is a method rather than a top-level function, keyed by
 * language id. Only languages whose grammar has no distinct method node
 * need an entry: there, a method parses as an ordinary function nested in a
 * class body, so `symbols.scm` alone cannot tell it apart and this ancestry
 * check does. TypeScript/JavaScript already capture methods explicitly via
 * `def.method` in their query and need no entry here — Rust will add one
 * for `impl_item` in a later task.
 */
const METHOD_CONTAINER_TYPES: Record<string, string[]> = {
  python: ['class_definition'],
}

/**
 * Node types that count as a method's "enclosing class" for `parentName`,
 * keyed by language id. Every language defaults to just `class_declaration`
 * (see `enclosingClassName`'s fallback); Java overrides this because its
 * grammar also lets a method live directly in an `interface_declaration` or
 * an `enum_declaration` body, and `parentName` should name that container
 * too — an interface's method is still "a member of Runner", not parentless.
 * Scoped by language, not applied globally, so TypeScript/JavaScript,
 * Python and Go's `parentName` behaviour is unaffected.
 */
const ENCLOSING_CLASS_TYPES: Record<string, string[]> = {
  java: ['class_declaration', 'interface_declaration', 'enum_declaration'],
}
const DEFAULT_ENCLOSING_CLASS_TYPES = ['class_declaration']

function extractSymbols(query: Query, root: Node, langId: string): SourceSymbol[] {
  const methodContainers = METHOD_CONTAINER_TYPES[langId]
  const symbols: SourceSymbol[] = []
  for (const match of query.matches(root)) {
    const nameCapture = match.captures.find(c => c.name === 'name')
    const defCapture = match.captures.find(c => c.name.startsWith('def.'))
    if (!nameCapture || !defCapture) continue

    let kind = defCapture.name.slice('def.'.length) as SymbolKind
    const node = defCapture.node
    let parentName: string | null = null

    if (kind === 'method') {
      parentName = langId === 'go' ? goReceiverTypeName(node) : enclosingClassName(node, langId)
    } else if (kind === 'function' && methodContainers) {
      const container = enclosingContainerOfType(node, methodContainers)
      if (container) {
        kind = 'method'
        parentName = container.childForFieldName('name')?.text ?? null
      }
    }

    symbols.push({
      name: nameCapture.node.text,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: isExported(node, langId, nameCapture.node.text),
      signature: signatureOf(node),
      parentName,
    })
  }
  return symbols
}

/** Walks ancestors looking for the nearest node whose type is in `types`. */
function enclosingContainerOfType(node: Node, types: string[]): Node | null {
  let current = node.parent
  while (current) {
    if (types.includes(current.type)) return current
    current = current.parent
  }
  return null
}

/**
 * Whether a declaration is part of a file's importable surface, by each
 * language's own visibility rule.
 *
 * TypeScript/JavaScript: an `export_statement` sits above it. For
 * `export const x = () => {}` the variable_declarator is two levels deeper
 * (declarator -> lexical_declaration -> export_statement), so walk a bounded
 * number of ancestors rather than assuming a fixed depth.
 *
 * Python has no export keyword — every module-level definition is
 * importable by name (`from module import _name` still works even for a
 * leading-underscore name; the convention only affects `import *`). So the
 * rule there is simply "is this definition's parent the module itself", the
 * same test that already keeps a class's methods from being misclassified
 * as exported.
 *
 * Go has no export keyword OR modifier either, but unlike Python the rule
 * is not "everything is importable" — it is purely capitalisation. An
 * identifier is part of a package's public API if and only if its first
 * character is uppercase (`Help` is exported, `help` is not). That check
 * has to run against the symbol's NAME, not this node's source text: for a
 * `function_declaration` the text starts with the `func` keyword, whose
 * first letter is lowercase regardless of the function's own name.
 */
function isExported(node: Node, langId: string, name: string): boolean {
  if (langId === 'python') return node.parent?.type === 'module'
  if (langId === 'go') return isGoExportedName(name)
  if (langId === 'java') return isJavaExported(node)

  let current: Node | null = node
  for (let depth = 0; current && depth < 3; depth++) {
    if (current.type === 'export_statement') return true
    current = current.parent
  }
  return false
}

/**
 * Java's export rule: a declaration is part of a file's importable surface
 * iff it carries an explicit `public` modifier, OR its enclosing type is an
 * interface — interface members are implicitly public regardless of any
 * modifier, and an explicit-`public`-only rule would wrongly mark every
 * interface method `exported: false`, silently producing zero cross-file
 * call edges into any interface (the exact failure this project's Python
 * support hit before its own export rule was corrected).
 *
 * `public` is detected by walking the `modifiers` node's own children and
 * testing `child.type === 'public'` — never by substring-matching the
 * modifiers' text, which would false-positive on an annotation such as
 * `@PublicApi`. A declaration with no modifier at all (package-private, or
 * an interface member) has no `modifiers` node as a child at all in this
 * grammar, not an empty one.
 */
function isJavaExported(node: Node): boolean {
  const modifiers = node.children.find(child => child?.type === 'modifiers') ?? null
  if (modifiers && modifiers.children.some(child => child?.type === 'public')) return true
  return enclosingContainerOfType(node, ['interface_declaration']) !== null
}

/**
 * Go's capitalisation export rule. `charAt(0)` on an empty string returns
 * `''`, and comparing `''.toUpperCase() === ''.toLowerCase()` is true, so an
 * empty or non-letter first character (digit, underscore, symbol) correctly
 * falls through to `false` without throwing.
 */
function isGoExportedName(name: string): boolean {
  const first = name.charAt(0)
  return first !== '' && first === first.toUpperCase() && first !== first.toLowerCase()
}

function signatureOf(node: Node): string | null {
  const body = node.childForFieldName('body')
  const end = body ? body.startIndex : node.endIndex
  const text = node.text.slice(0, end - node.startIndex).trim()
  return text.length > 0 ? text.slice(0, 300) : null
}

function enclosingClassName(node: Node, langId: string): string | null {
  const types = ENCLOSING_CLASS_TYPES[langId] ?? DEFAULT_ENCLOSING_CLASS_TYPES
  let current = node.parent
  while (current) {
    if (types.includes(current.type)) {
      return current.childForFieldName('name')?.text ?? null
    }
    current = current.parent
  }
  return null
}

/**
 * Go has no class nesting at all: a `method_declaration` is a top-level
 * sibling of everything else, and the type it belongs to is named by its
 * `receiver` field (`func (s *Service) Place() int`) rather than by an
 * ancestor node — so this reads a field off `node` itself, unlike
 * `enclosingClassName`'s ancestor walk. The receiver's declared type is
 * either a bare `type_identifier` (value receiver) or a `pointer_type`
 * wrapping one (pointer receiver); both name the same type.
 */
function goReceiverTypeName(node: Node): string | null {
  const receiver = node.childForFieldName('receiver')
  const declaration = receiver?.namedChild(0) ?? null
  const type = declaration?.childForFieldName('type') ?? null
  if (!type) return null
  return type.type === 'pointer_type' ? type.namedChild(0)?.text ?? null : type.text
}

/** Names that are import mechanisms, not real call targets. */
const IMPORT_MECHANISMS = new Set(['require', 'import'])

const ENCLOSING_SYMBOL_NODES = new Set([
  'function_declaration', 'method_definition', 'arrow_function', 'function_expression',
  // Python has one node for both a function and a method.
  'function_definition',
  // Go's method_declaration is captured explicitly as def.method (unlike
  // Python, it needs no METHOD_CONTAINER_TYPES entry) but is still a
  // distinct node type from function_declaration, so it needs its own
  // entry here too; it shapes its `name` field identically.
  'method_declaration',
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
