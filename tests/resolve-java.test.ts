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
 */
describe('javaResolver same-root partition (fix round 1)', () => {
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

  it('reports ambiguous, with the sorted-first path, when two candidates exist and neither is under the importing file\'s own root', () => {
    const known = new Set([
      'modA/src/main/java/com/example/Helper.java',
      'modB/src/main/java/com/example/Helper.java',
      'modC/src/main/java/com/example/Service.java',
    ])
    expect(javaResolver.resolve(
      'modC/src/main/java/com/example/Service.java', 'com.example.Helper', known, '/repo',
    )).toEqual({ path: 'modA/src/main/java/com/example/Helper.java', confidence: 'ambiguous' })
  })

  it('does not silently resolve to a coincidental deeper root when a shallower, correct same-root candidate exists', () => {
    // 'proj/src/main/java/com' is itself a derived candidate root (it is
    // literally Helper.java's own directory), so a second, unrelated file
    // that happens to sit at that root's "com/Helper.java" position
    // coincidentally also matches the FQN `com.Helper`. The importer here
    // is in a sibling package ('other'), so only the genuine root
    // ('proj/src/main/java') is a prefix of its own path — the coincidental
    // deep root is not, and must not win.
    const known = new Set([
      'proj/src/main/java/com/Helper.java',
      'proj/src/main/java/com/com/Helper.java',
      'proj/src/main/java/other/Service.java',
    ])
    expect(javaResolver.resolve(
      'proj/src/main/java/other/Service.java', 'com.Helper', known, '/repo',
    )).toEqual({ path: 'proj/src/main/java/com/Helper.java', confidence: 'resolved' })
  })
})
