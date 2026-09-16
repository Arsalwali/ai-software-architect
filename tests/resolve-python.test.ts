import { describe, it, expect } from 'vitest'
import { pythonResolver } from '../src/resolve/python.js'
import { resolverFor } from '../src/resolve/index.js'

const known = new Set([
  'pkg/__init__.py', 'pkg/helper.py', 'pkg/service.py', 'main.py',
  'pkg/sub/__init__.py', 'pkg/sub/deep.py', 'pkg/util.py',
])
const r = (from: string, spec: string) => pythonResolver.resolve(from, spec, known)

describe('pythonResolver', () => {
  it('resolves an absolute dotted module', () => {
    expect(r('main.py', 'pkg.helper')).toEqual({ path: 'pkg/helper.py', confidence: 'resolved' })
  })

  it('resolves a dotted package to its __init__.py', () => {
    expect(r('main.py', 'pkg').path).toBe('pkg/__init__.py')
  })

  it('resolves a single-dot relative import against the importing package', () => {
    expect(r('pkg/service.py', '.helper')).toEqual({ path: 'pkg/helper.py', confidence: 'resolved' })
  })

  it('resolves a two-dot relative import against the parent package', () => {
    expect(r('pkg/sub/deep.py', '..util').path).toBe('pkg/util.py')
  })

  it('resolves a bare single dot to the current package __init__', () => {
    expect(r('pkg/service.py', '.').path).toBe('pkg/__init__.py')
  })

  it('reports a standard-library import as unresolved, not ambiguous', () => {
    expect(r('main.py', 'os')).toEqual({ path: null, confidence: 'unresolved' })
    expect(r('main.py', 'typing')).toEqual({ path: null, confidence: 'unresolved' })
  })

  it('does not escape the repository root', () => {
    expect(r('main.py', '....secrets').path).toBeNull()
  })
})

describe('resolverFor dispatches by language', () => {
  it('selects the python resolver for a .py file and the javascript resolver for a .ts file', () => {
    expect(resolverFor('a.py').id).toBe('python')
    expect(resolverFor('a.ts').id).toBe('javascript')
  })
})
