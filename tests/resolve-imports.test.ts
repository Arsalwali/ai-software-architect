import { describe, it, expect } from 'vitest'
import { resolveImport } from '../src/indexer/resolve-imports.js'

const KNOWN = new Set([
  'src/helper.ts',
  'src/helper.js',
  'src/services/order.ts',
  'src/services/notify.ts',
  'src/widgets/index.ts',
  'src/legacy.js',
])

describe('resolveImport', () => {
  it('resolves a relative sibling by probing extensions', () => {
    expect(resolveImport('src/services/order.ts', './notify', KNOWN))
      .toEqual({ path: 'src/services/notify.ts', confidence: 'resolved' })
  })

  it('resolves a parent-directory specifier', () => {
    expect(resolveImport('src/services/order.ts', '../helper', KNOWN))
      .toEqual({ path: 'src/helper.ts', confidence: 'resolved' })
  })

  it('resolves a directory to its index file', () => {
    expect(resolveImport('src/index.ts', './widgets', KNOWN))
      .toEqual({ path: 'src/widgets/index.ts', confidence: 'resolved' })
  })

  it('resolves an explicit .js specifier to the .ts source', () => {
    expect(resolveImport('src/index.ts', './helper.js', KNOWN).path).toBe('src/helper.ts')
  })

  it('prefers the .ts source even when both .js and .ts are indexed', () => {
    expect(resolveImport('src/index.ts', './helper.js', KNOWN))
      .toEqual({ path: 'src/helper.ts', confidence: 'resolved' })
  })

  it('leaves bare package specifiers unresolved', () => {
    expect(resolveImport('src/index.ts', 'react', KNOWN))
      .toEqual({ path: null, confidence: 'ambiguous' })
    expect(resolveImport('src/index.ts', 'node:fs', KNOWN))
      .toEqual({ path: null, confidence: 'ambiguous' })
  })

  it('leaves a relative specifier pointing nowhere unresolved', () => {
    expect(resolveImport('src/index.ts', './missing', KNOWN))
      .toEqual({ path: null, confidence: 'ambiguous' })
  })

  it('never resolves outside the set of indexed files', () => {
    expect(resolveImport('src/index.ts', '../../../etc/passwd', KNOWN).path).toBeNull()
  })
})
