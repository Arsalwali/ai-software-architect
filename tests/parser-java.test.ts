import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RepoParser } from '../src/parser/parser.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildJavaFixture } from './fixtures-multilang.js'

// `packagePrivate` carries no modifier at all, so it exercises the "no
// public modifier, not an interface member" half of the export rule.
// `place` carries an explicit `public` modifier. The wildcard import is
// real Java (`import com.example.*;`), not a fabricated specifier — see the
// task-4 ruling on why a `.*`-suffixed specifier capture never happens.
const SERVICE_SOURCE =
  'package com.example;\n\n' +
  'import com.example.Helper;\n' +
  'import com.example.*;\n\n' +
  'public class Service {\n' +
  '  public int place(int n) { return Helper.help(n); }\n' +
  '  int packagePrivate(int n) { return n; }\n' +
  '}\n'

// Interface members carry no modifiers node at all in this grammar, yet are
// implicitly public — the other half of the export rule.
const RUNNER_SOURCE =
  'package com.example;\n\n' +
  'public interface Runner {\n' +
  '  void go();\n' +
  '}\n'

let parser: RepoParser
beforeAll(async () => { parser = await RepoParser.create() })

describe('java parsing', () => {
  it('recognises .java as java', () => {
    expect(parser.parse('a.java', SERVICE_SOURCE).lang).toBe('java')
  })

  it('extracts a class, an interface and methods with their kinds', () => {
    const serviceNames = parser.parse('Service.java', SERVICE_SOURCE).symbols
      .map(s => `${s.kind}:${s.name}`).sort()
    expect(serviceNames).toEqual(['class:Service', 'method:packagePrivate', 'method:place'])

    const runnerNames = parser.parse('Runner.java', RUNNER_SOURCE).symbols
      .map(s => `${s.kind}:${s.name}`).sort()
    expect(runnerNames).toEqual(['interface:Runner', 'method:go'])
  })

  it('attributes a class method to its class via parentName', () => {
    const place = parser.parse('Service.java', SERVICE_SOURCE).symbols.find(s => s.name === 'place')!
    expect(place.kind).toBe('method')
    expect(place.parentName).toBe('Service')
  })

  it('attributes an interface method to its interface via parentName', () => {
    const go = parser.parse('Runner.java', RUNNER_SOURCE).symbols.find(s => s.name === 'go')!
    expect(go.kind).toBe('method')
    expect(go.parentName).toBe('Runner')
  })

  it('exports a method carrying an explicit public modifier', () => {
    const place = parser.parse('Service.java', SERVICE_SOURCE).symbols.find(s => s.name === 'place')!
    expect(place.exported).toBe(true)
  })

  it('does not export a package-private method with no modifier', () => {
    const packagePrivate = parser.parse('Service.java', SERVICE_SOURCE).symbols
      .find(s => s.name === 'packagePrivate')!
    expect(packagePrivate.exported).toBe(false)
  })

  it('exports an interface method even though it carries no modifier at all', () => {
    const go = parser.parse('Runner.java', RUNNER_SOURCE).symbols.find(s => s.name === 'go')!
    expect(go.exported).toBe(true)
  })

  it('extracts a named import and a real wildcard import as the bare package name', () => {
    const specs = parser.parse('Service.java', SERVICE_SOURCE).imports.map(i => i.specifier).sort()
    expect(specs).toEqual(['com.example', 'com.example.Helper'])
  })

  it('attributes a call inside a method to that method', () => {
    const calls = parser.parse('Service.java', SERVICE_SOURCE).callSites
    const call = calls.find(c => c.name === 'help')!
    expect(call.enclosingSymbol).toBe('place')
    expect(call.kind).toBe('calls')
  })

  it('counts lines in a file actually recognised as java', () => {
    // `loc` alone is computed before language dispatch (see RepoParser.parse
    // in src/parser/parser.ts), so a loc-only assertion here would still
    // pass even with Java support deleted entirely — the reviewer proved
    // this against `Runner.zzz`. Asserting `lang` in the SAME test closes
    // that gap: delete Java support and this test fails, because `lang`
    // reverts to `null`.
    const parsed = parser.parse('Runner.java', RUNNER_SOURCE)
    expect(parsed.lang).toBe('java')
    expect(parsed.loc).toBe(5)
  })

  it('does not export a method through a nested type\'s enclosing interface', () => {
    // Only the NEAREST enclosing type governs the implicit-public rule.
    // `hidden` is private and lives in `class Inner`, which happens to be
    // nested inside `interface Outer` — but `Inner` is a class, not an
    // interface, so `hidden` must NOT inherit Outer's implicit-public
    // treatment. See task-4-fixes.md finding 5.
    const NESTED_SOURCE =
      'package com.example;\n\n' +
      'public interface Outer {\n' +
      '  class Inner {\n' +
      '    private int hidden() { return 1; }\n' +
      '  }\n' +
      '}\n'
    const hidden = parser.parse('Outer.java', NESTED_SOURCE).symbols.find(s => s.name === 'hidden')!
    expect(hidden.exported).toBe(false)
  })

  it('does not export a method through a record nested in a sealed interface (fix round 4, item 1)', () => {
    // `record_declaration` was missing from ENCLOSING_CLASS_TYPES.java, so
    // the nearest-type walk skipped straight past the record and landed on
    // the enclosing (sealed) interface, wrongly exporting `secret` via the
    // interface-implicit-public rule. Verified `record_declaration` against
    // the real grammar (tree-sitter-java.wasm) before relying on it — a
    // sealed interface with a nested record is idiomatic modern Java.
    const RECORD_SOURCE =
      'package com.example;\n\n' +
      'public sealed interface Shape {\n' +
      '  record Circle(int r) implements Shape {\n' +
      '    private int secret() { return 1; }\n' +
      '  }\n' +
      '}\n'
    const secret = parser.parse('Shape.java', RECORD_SOURCE).symbols.find(s => s.name === 'secret')!
    expect(secret.exported).toBe(false)
  })

  it('exports a type nested directly in an annotation type, whose members are implicitly public (fix round 4, item 1)', () => {
    // A method_declaration can never be a direct child of an annotation
    // type's body in this grammar (an element such as `String value();`
    // parses as `annotation_type_element_declaration`, not
    // `method_declaration`, and isn't captured by symbols.scm at all) — so
    // the record-style "private method wrongly exported" case cannot arise
    // for an annotation type. What CAN sit directly inside an annotation
    // type's body, and IS captured, is a nested type declaration (verified
    // against the real grammar: `class_declaration` parses as a direct
    // child of `annotation_type_body`). Per JLS 9.6, every member of an
    // annotation type — including a nested type — is implicitly public,
    // the same rule already applied to interface members. Before this fix,
    // `annotation_type_declaration` was missing from
    // ENCLOSING_CLASS_TYPES.java, so the nearest-type walk skipped past
    // `Outer` entirely (finding no enclosing type at all, since `Outer` is
    // top-level) and `Inner` — a package-private class with no modifier of
    // its own — came back `exported: false`, which is wrong.
    const ANNOTATION_SOURCE =
      'package com.example;\n\n' +
      'public @interface Outer {\n' +
      '  class Inner {\n' +
      '    int field;\n' +
      '  }\n' +
      '}\n'
    const inner = parser.parse('Outer.java', ANNOTATION_SOURCE).symbols.find(s => s.name === 'Inner')!
    expect(inner.exported).toBe(true)
  })
})

describe('java produces a real graph', () => {
  it('resolves a named import, leaves a wildcard import unresolved, and finds a cross-file call edge', async () => {
    const fixture = buildJavaFixture({ git: true })
    const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-java-db-')), 'index.db')

    await runColdIndex({ repoRoot: fixture, dbPath })

    const store = GraphStore.open(dbPath)
    try {
      const serviceId = store.fileIdByPath('src/main/java/com/example/Service.java')!
      const helperId = store.fileIdByPath('src/main/java/com/example/Helper.java')!

      const imports = store.importsForFile(serviceId)

      const named = imports.find(i => i.rawSpecifier === 'com.example.Helper')!
      expect(named.resolvedFileId).toBe(helperId)
      expect(named.confidence).toBe('resolved')

      // `import com.example.*;` captures as the bare package name
      // `com.example`, which names a directory, not a file: genuinely
      // unresolved, not a fabricated guess.
      const wildcard = imports.find(i => i.rawSpecifier === 'com.example')!
      expect(wildcard.resolvedFileId).toBeNull()
      expect(wildcard.confidence).toBe('unresolved')

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
