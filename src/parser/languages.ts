import { Parser, Language } from 'web-tree-sitter'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

export interface LanguageDef {
  id: string
  extensions: string[]
  wasmPath: string
  queryDir: string
  /** Key into the resolver registry (`src/resolve`); see note below. */
  resolverId: string
}

function def(
  id: string,
  wasmName: string,
  queryDirName: string,
  extensions: string[],
  resolverId: string,
): LanguageDef {
  return {
    id,
    extensions,
    wasmPath: require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${wasmName}.wasm`),
    queryDir: join(here, 'queries', queryDirName),
    resolverId,
  }
}

// The wasm grammar, the query directory and the resolver are all chosen
// independently. The TypeScript grammar is a syntactic superset of
// JavaScript, so `javascript` and `jsx` deliberately load the
// TypeScript/TSX wasm grammars rather than tree-sitter-javascript.wasm
// (whose grammar lacks TS-only node kinds that the shared symbols.scm
// references, and so cannot compile that query at all). `id` still
// reflects the source language, since it flows into files.lang in the
// database and downstream reporting. `resolverId` likewise need not match
// `id` or the query directory: it only selects which import-resolution
// strategy (see `src/resolve`) applies to files of this language, and
// languages that share an import syntax can share a resolver.
//
// Adding a language means adding one entry here plus a queries/<dir> with
// symbols.scm, imports.scm and calls.scm. Nothing else in the codebase changes.
export const LANGUAGES: LanguageDef[] = [
  def('typescript', 'typescript', 'typescript', ['.ts', '.mts', '.cts'], 'javascript'),
  def('tsx', 'tsx', 'typescript', ['.tsx'], 'javascript'),
  def('javascript', 'typescript', 'typescript', ['.js', '.mjs', '.cjs'], 'javascript'),
  def('jsx', 'tsx', 'typescript', ['.jsx'], 'javascript'),
  def('python', 'python', 'python', ['.py'], 'python'),
]

const byExtension = new Map<string, LanguageDef>()
for (const language of LANGUAGES) {
  for (const ext of language.extensions) byExtension.set(ext, language)
}

export function languageForPath(path: string): LanguageDef | null {
  return byExtension.get(extname(path)) ?? null
}

let initialized: Promise<void> | null = null
const loaded = new Map<string, Promise<Language>>()

export function loadLanguage(def: LanguageDef): Promise<Language> {
  initialized ??= Parser.init()
  let existing = loaded.get(def.wasmPath)
  if (!existing) {
    existing = initialized.then(() => Language.load(def.wasmPath))
    loaded.set(def.wasmPath, existing)
  }
  return existing
}
