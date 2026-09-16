import { describe, it, expect } from 'vitest'
import { resolverFor } from '../src/resolve/index.js'
import { resolveImport } from '../src/indexer/resolve-imports.js'

describe('resolverFor', () => {
  it('picks the javascript resolver for TypeScript and JavaScript files', () => {
    for (const p of ['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.jsx']) {
      expect(resolverFor(p).id).toBe('javascript')
    }
  })

  it('falls back to the javascript resolver for an unknown extension', () => {
    // A file with no registered language still gets a resolver rather than
    // throwing; it simply will not resolve anything.
    expect(resolverFor('notes.md').id).toBe('javascript')
  })
})

describe('resolveImport still behaves exactly as before the seam', () => {
  const known = new Set(['src/helper.ts', 'src/widgets/index.ts', 'src/legacy.js'])
  const repoRoot = '/repo'

  it('resolves a relative sibling', () => {
    expect(resolveImport('src/main.ts', './helper', known, repoRoot))
      .toEqual({ path: 'src/helper.ts', confidence: 'resolved' })
  })

  it('resolves a directory to its index file', () => {
    expect(resolveImport('src/main.ts', './widgets', known, repoRoot).path).toBe('src/widgets/index.ts')
  })

  it('prefers the .ts source for an explicit .js specifier', () => {
    expect(resolveImport('src/main.ts', './helper.js', known, repoRoot).path).toBe('src/helper.ts')
  })

  it('leaves a bare package specifier unresolved', () => {
    expect(resolveImport('src/main.ts', 'react', known, repoRoot))
      .toEqual({ path: null, confidence: 'unresolved' })
  })

  it('never escapes the repository root', () => {
    expect(resolveImport('src/main.ts', '../../../etc/passwd', known, repoRoot).path).toBeNull()
  })
})
