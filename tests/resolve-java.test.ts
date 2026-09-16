import { describe, it, expect } from 'vitest'
import { javaResolver, sourceRootsFrom } from '../src/resolve/java.js'

const known = new Set([
  'src/main/java/com/example/Helper.java',
  'src/main/java/com/example/Service.java',
  'com/other/Flat.java',
])

// `repoRoot` is a required fourth parameter (see src/resolve/index.ts); Java
// derives its source roots from `knownPaths` alone and ignores it, but the
// signature still demands it, so every call here passes a placeholder.
const r = (from: string, spec: string) => javaResolver.resolve(from, spec, known, '/repo')

describe('sourceRootsFrom', () => {
  it('derives a Maven source root from an indexed path', () => {
    expect([...sourceRootsFrom(known)]).toContain('src/main/java')
  })

  it('includes the empty root for a flat layout', () => {
    expect([...sourceRootsFrom(known)]).toContain('')
  })
})

describe('javaResolver', () => {
  it('resolves a fully-qualified name under a derived source root', () => {
    expect(r('src/main/java/com/example/Service.java', 'com.example.Helper'))
      .toEqual({ path: 'src/main/java/com/example/Helper.java', confidence: 'resolved' })
  })

  it('resolves a fully-qualified name in a flat layout', () => {
    expect(r('com/other/Main.java', 'com.other.Flat').path).toBe('com/other/Flat.java')
  })

  it('reports a JDK import as unresolved', () => {
    expect(r('src/main/java/com/example/Service.java', 'java.util.List'))
      .toEqual({ path: null, confidence: 'unresolved' })
  })

  // Guard-level only: the tree-sitter-java grammar NEVER produces a
  // `.*`-suffixed specifier capture — `import com.example.*;` parses as the
  // scoped_identifier "com.example" plus a separate `asterisk` token, so the
  // query only ever captures "com.example" (verified against
  // tree-sitter-java.wasm; see task-4 rulings). This test exercises an input
  // the real pipeline cannot produce; it exists only to document and pin the
  // defensive `.endsWith('.*')` branch in src/resolve/java.ts in case a
  // future grammar or query change ever does produce one. The REAL wildcard
  // behaviour — a bare package name resolving to `unresolved` — is covered
  // end-to-end in tests/parser-java.test.ts using a real
  // `import com.example.*;` statement.
  it('[guard, not a real grammar output] treats a literal .*-suffixed specifier as unresolved', () => {
    expect(r('src/main/java/com/example/Service.java', 'com.example.*').path).toBeNull()
  })
})

/**
 * `resolve` must use `fromPath` to prefer a candidate under the IMPORTING
 * file's own source root over a same-named file elsewhere — ignoring
 * `fromPath` (the pre-fix behaviour) means it cannot tell moduleB's own
 * Helper from moduleA's, which is a confident WRONG answer, the exact
 * failure this project exists to prevent. See task-4-fixes.md finding 1+2+3.
 *
 * Fix round 2 (task-4-fixes-round2.md) replaced the same-root/other
 * PARTITION these tests were originally named for with a single RANKING by
 * shared leading path segments — the partition could not tell a
 * per-module `main`/`test` split apart from an unrelated module (see the
 * new test below), and a wrong cross-module edge feeds `get_coupling` /
 * `get_dependencies`, fabricating coupling between modules that don't
 * actually depend on each other. All four pre-existing assertions here are
 * unchanged by that replacement except the last one — see its comment.
 */
describe('javaResolver ranked by shared leading path segments (fix round 2)', () => {
  it('resolves a multi-module ambiguous name to the file under the IMPORTING file\'s own module, not another module\'s same-named file', () => {
    const known = new Set([
      'moduleA/src/main/java/com/example/Helper.java',
      'moduleB/src/main/java/com/example/Helper.java',
      'moduleB/src/main/java/com/example/Service.java',
    ])
    expect(javaResolver.resolve(
      'moduleB/src/main/java/com/example/Service.java', 'com.example.Helper', known, '/repo',
    )).toEqual({ path: 'moduleB/src/main/java/com/example/Helper.java', confidence: 'resolved' })
  })

  it('resolves a Maven test-root file importing a main-root class, since the test root has no copy of its own', () => {
    const known = new Set([
      'proj/src/main/java/com/example/Config.java',
      'proj/src/test/java/com/example/FooTest.java',
    ])
    expect(javaResolver.resolve(
      'proj/src/test/java/com/example/FooTest.java', 'com.example.Config', known, '/repo',
    )).toEqual({ path: 'proj/src/main/java/com/example/Config.java', confidence: 'resolved' })
  })

  it('reports ambiguous, with the sorted-first path, when two candidates exist and neither shares any leading segment with the importing file', () => {
    const known = new Set([
      'modA/src/main/java/com/example/Helper.java',
      'modB/src/main/java/com/example/Helper.java',
      'modC/src/main/java/com/example/Service.java',
    ])
    expect(javaResolver.resolve(
      'modC/src/main/java/com/example/Service.java', 'com.example.Helper', known, '/repo',
    )).toEqual({ path: 'modA/src/main/java/com/example/Helper.java', confidence: 'ambiguous' })
  })

  // Fix round 2's own gap: round 1's same-root partition could not
  // distinguish "my own module's main tree" from "an unrelated module",
  // because neither is a path-ancestor of a `test` file's own directory.
  // Ranking by shared leading segments fixes it: moduleB's own Config
  // shares 'moduleB/src' (2 segments) with the test file, moduleA's Config
  // shares nothing (0) — a unique max, so it resolves cleanly instead of
  // falling back to `ambiguous`. This is the exact case the coordinator
  // reproduced against the round-1 build and overruled my judgment that it
  // could stay: a wrong cross-module edge here silently fabricates
  // coupling between moduleA and moduleB in get_coupling/get_dependencies.
  it('resolves a per-module test file to its OWN module\'s main-tree class over a same-named class in a sibling module', () => {
    const known = new Set([
      'moduleA/src/main/java/com/example/Config.java',
      'moduleB/src/main/java/com/example/Config.java',
      'moduleB/src/test/java/com/example/ConfigTest.java',
    ])
    expect(javaResolver.resolve(
      'moduleB/src/test/java/com/example/ConfigTest.java', 'com.example.Config', known, '/repo',
    )).toEqual({ path: 'moduleB/src/main/java/com/example/Config.java', confidence: 'resolved' })
  })

  // This is finding 2 as the reviewer actually demonstrated it (fix round
  // 3 restores it — round 2 covered a DIFFERENT, non-representative
  // fixture here; see the "genuine tie" test below and task-4-report.md
  // for how the two diverged). The importer lives in the SAME package as
  // the real target, which is the ordinary case: a class importing a
  // neighbour declared right next to it. The two candidates share
  // 'src/main/java/com/example' with fromPath up through 'example' vs
  // 'com' — the divergence point — so the ranking discriminates cleanly:
  // the real file matches one more segment ('example') than the
  // coincidental one (whose corresponding segment is 'com'), 5 shared
  // segments vs 4, and wins outright rather than tying.
  it('resolves to the real file, not a coincidental deeper-directory collision, when the importer sits at the divergence point', () => {
    const known = new Set([
      'src/main/java/com/example/Helper.java',
      'src/main/java/com/com/example/Helper.java',
      'src/main/java/com/example/Service.java',
    ])
    expect(javaResolver.resolve(
      'src/main/java/com/example/Service.java', 'com.example.Helper', known, '/repo',
    )).toEqual({ path: 'src/main/java/com/example/Helper.java', confidence: 'resolved' })
  })

  // A genuine equidistant tie — NOT the com/com finding above. Here the
  // importer ('other/Service.java') sits OFF the divergence point between
  // the two candidates entirely: it shares nothing with either candidate's
  // 'com' vs 'com/com' segment, so both candidates tie on shared leading
  // segments and the outcome is correctly `ambiguous`, not `resolved`.
  // The ranking's behaviour depends on WHERE the importer sits relative to
  // the divergence point — it discriminates when the importer sits there
  // (the test above) and ties when it does not (this test) — both are the
  // intended, correct behaviour of the same rule, not a defect in either
  // direction.
  it('reports a genuine tie as ambiguous when the importer sits off the divergence point between two equidistant candidates', () => {
    const known = new Set([
      'proj/src/main/java/com/Helper.java',
      'proj/src/main/java/com/com/Helper.java',
      'proj/src/main/java/other/Service.java',
    ])
    const result = javaResolver.resolve(
      'proj/src/main/java/other/Service.java', 'com.Helper', known, '/repo',
    )
    expect(result.confidence).toBe('ambiguous')
    // Deterministic (sorted-first) rather than asserting which specific
    // one of the tied candidates wins — that pick is arbitrary by design.
    expect(result.path).toBe([...known].filter(p => p.endsWith('Helper.java')).sort()[0])
  })
})
