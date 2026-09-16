import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RepoParser } from '../src/parser/parser.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildRustFixture } from './fixtures-multilang.js'

const HELPER_SOURCE = 'pub fn help(n: i32) -> i32 {\n    n + 1\n}\n'

// `private_helper` is a second method on the same impl block, carrying no
// `visibility_modifier` — it exercises both halves of Ruling 3's ancestry
// claim (declaration_list < impl_item < source_file reaches BOTH methods)
// and Ruling 4's export rule (only `place` has a visibility_modifier).
const SERVICE_SOURCE =
  'use crate::helper::help;\n\npub struct Service {\n    pub n: i32,\n}\n\n' +
  'impl Service {\n' +
  '    pub fn place(&self) -> i32 {\n        help(self.n)\n    }\n\n' +
  '    fn private_helper(&self) -> i32 {\n        1\n    }\n' +
  '}\n'

// `main` is deliberately non-pub (a free function, not a method) so the
// export rule is exercised on a top-level function too, not just a method.
const MAIN_SOURCE =
  'mod helper;\nmod service;\n\nuse crate::service::Service;\n\n' +
  'fn main() {\n    let s = Service { n: 2 };\n    println!("{}", s.place());\n}\n'

// Exercises enum_item, type_item and trait_item AS SYMBOLS, none of which
// appear in the end-to-end fixture. All three node names and their
// symbols.scm patterns were verified against the real grammar
// (tree-sitter-rust.wasm) with a throwaway probe before being relied on.
//
// It does NOT exercise `trait_item`'s OTHER role, as a
// METHOD_CONTAINER_TYPES.rust entry (final-fixes.md item 5): `fn go(&self);`
// is bodiless, so it parses as a `function_signature_item`, which
// symbols.scm never captures -- nothing here ever reaches the container
// promotion. TRAIT_DEFAULT_SOURCE below is what covers that.
const KINDS_SOURCE =
  'pub enum Color {\n    Red,\n    Green,\n}\n\n' +
  'pub type Alias = i32;\n\n' +
  'pub trait Runner {\n    fn go(&self);\n}\n'

// A trait method WITH A DEFAULT BODY. Verified against the real grammar:
// this parses as a `function_item` nested in `trait_item` -- structurally
// identical to a method inside an `impl_item`, and indistinguishable from a
// free function by symbols.scm alone. Only METHOD_CONTAINER_TYPES.rust's
// `trait_item` entry (src/parser/parser.ts) tells them apart, so without
// it `go` is reported as a top-level `function` with no parent. `required`
// is deliberately kept bodiless alongside it: it parses as a
// `function_signature_item`, which symbols.scm does not capture at all,
// and asserting its absence pins the boundary between the two.
const TRAIT_DEFAULT_SOURCE =
  'pub trait Runner {\n' +
  '    fn go(&self) -> i32 {\n        1\n    }\n\n' +
  '    fn required(&self) -> i32;\n' +
  '}\n'

let parser: RepoParser
beforeAll(async () => { parser = await RepoParser.create() })

describe('rust parsing', () => {
  it('recognises .rs as rust', () => {
    expect(parser.parse('a.rs', HELPER_SOURCE).lang).toBe('rust')
  })

  it('extracts a struct, enum, trait, type alias and function with their mapped kinds', () => {
    const helperNames = parser.parse('helper.rs', HELPER_SOURCE).symbols
      .map(s => `${s.kind}:${s.name}`).sort()
    expect(helperNames).toEqual(['function:help'])

    const serviceNames = parser.parse('service.rs', SERVICE_SOURCE).symbols
      .map(s => `${s.kind}:${s.name}`).sort()
    expect(serviceNames).toEqual(['class:Service', 'method:place', 'method:private_helper'])

    const kindsNames = parser.parse('kinds.rs', KINDS_SOURCE).symbols
      .map(s => `${s.kind}:${s.name}`).sort()
    expect(kindsNames).toEqual(['enum:Color', 'interface:Runner', 'type:Alias'])
  })

  it('promotes a trait method with a DEFAULT BODY to a method of that trait (final-fixes.md item 5)', () => {
    const symbols = parser.parse('runner.rs', TRAIT_DEFAULT_SOURCE).symbols
    // `go` is a `function_item`, exactly like a free function; only
    // METHOD_CONTAINER_TYPES.rust's `trait_item` entry makes it a method.
    const go = symbols.find(s => s.name === 'go')!
    expect(go.kind).toBe('method')
    expect(go.parentName).toBe('Runner')
    // And the bodiless sibling stays uncaptured, so this test cannot pass
    // by the query suddenly capturing every trait member.
    expect(symbols.map(s => `${s.kind}:${s.name}`).sort())
      .toEqual(['interface:Runner', 'method:go'])
  })

  it('attributes an impl method to its struct via parentName (Ruling 3: impl_item has no name field, only type)', () => {
    const place = parser.parse('service.rs', SERVICE_SOURCE).symbols.find(s => s.name === 'place')!
    expect(place.kind).toBe('method')
    expect(place.parentName).toBe('Service')

    const privateHelper = parser.parse('service.rs', SERVICE_SOURCE).symbols
      .find(s => s.name === 'private_helper')!
    expect(privateHelper.kind).toBe('method')
    expect(privateHelper.parentName).toBe('Service')
  })

  it('leaves a free function with no parentName', () => {
    const help = parser.parse('helper.rs', HELPER_SOURCE).symbols.find(s => s.name === 'help')!
    expect(help.kind).toBe('function')
    expect(help.parentName).toBeNull()
  })

  it('exports a function carrying a visibility_modifier', () => {
    const help = parser.parse('helper.rs', HELPER_SOURCE).symbols.find(s => s.name === 'help')!
    expect(help.exported).toBe(true)

    const place = parser.parse('service.rs', SERVICE_SOURCE).symbols.find(s => s.name === 'place')!
    expect(place.exported).toBe(true)
  })

  it('does not export a function or method carrying no visibility_modifier (Ruling 4)', () => {
    const privateHelper = parser.parse('service.rs', SERVICE_SOURCE).symbols
      .find(s => s.name === 'private_helper')!
    expect(privateHelper.exported).toBe(false)

    const main = parser.parse('main.rs', MAIN_SOURCE).symbols.find(s => s.name === 'main')!
    expect(main.exported).toBe(false)
  })

  it('extracts a use declaration specifier', () => {
    const specs = parser.parse('service.rs', SERVICE_SOURCE).imports.map(i => i.specifier)
    expect(specs).toEqual(['crate::helper::help'])
  })

  it('attributes a call inside a method to that method', () => {
    const calls = parser.parse('service.rs', SERVICE_SOURCE).callSites
    const call = calls.find(c => c.name === 'help')!
    expect(call.enclosingSymbol).toBe('place')
    expect(call.kind).toBe('calls')
  })

  it('counts lines in a file actually recognised as rust', () => {
    const parsed = parser.parse('helper.rs', HELPER_SOURCE)
    expect(parsed.lang).toBe('rust')
    expect(parsed.loc).toBe(3)
  })
})

describe('rust produces a real graph', () => {
  it('resolves a crate-relative import and finds a cross-file call edge', async () => {
    const fixture = buildRustFixture({ git: true })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-rust-db-')), 'index.db')

    await runColdIndex({ repoRoot: fixture, dbPath })

    const store = GraphStore.open(dbPath)
    try {
      const serviceId = store.fileIdByPath('src/service.rs')!
      const helperId = store.fileIdByPath('src/helper.rs')!
      const mainId = store.fileIdByPath('src/main.rs')!

      const serviceImports = store.importsForFile(serviceId)
      const helperImport = serviceImports.find(i => i.rawSpecifier === 'crate::helper::help')!
      expect(helperImport.resolvedFileId).toBe(helperId)
      expect(helperImport.confidence).toBe('resolved')

      const mainImports = store.importsForFile(mainId)
      const serviceImport = mainImports.find(i => i.rawSpecifier === 'crate::service::Service')!
      expect(serviceImport.resolvedFileId).toBe(serviceId)
      expect(serviceImport.confidence).toBe('resolved')

      const intoHelper = store.edgesInto(helperId)
      const call = intoHelper.find(e => e.dstName === 'help')!
      expect(call).toBeDefined()
      expect(call.confidence).toBe('heuristic')
      expect(call.srcFileId).toBe(serviceId)
    } finally {
      store.close()
    }
  })
})
