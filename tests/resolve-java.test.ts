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
