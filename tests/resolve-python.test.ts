import { describe, it, expect } from 'vitest'
import { pythonResolver } from '../src/resolve/python.js'
import { resolverFor } from '../src/resolve/index.js'

const known = new Set([
  'pkg/__init__.py', 'pkg/helper.py', 'pkg/service.py', 'main.py',
  'pkg/sub/__init__.py', 'pkg/sub/deep.py', 'pkg/util.py',
])
const r = (from: string, spec: string) => pythonResolver.resolve(from, spec, known, '/repo')

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

  // final-fixes.md item 4. `from pkg import service` composes to the
  // specifier `pkg.service` (see src/parser/queries/python/imports.scm), so
  // the resolver now sees a path whose last segment may be a submodule OR
  // an item defined in the package's `__init__`. Longest-first, then drop
  // the item -- the same two-attempt shape javaResolver and rustResolver
  // already use.
  it('prefers the submodule file over the package __init__ for a from-import', () => {
    // The defect: this used to be asked as the bare `pkg` and answered
    // `pkg/__init__.py`, so the subsequent `service.place()` call could
    // never resolve.
    expect(r('main.py', 'pkg.service')).toEqual({ path: 'pkg/service.py', confidence: 'resolved' })
  })

  it('falls back to the package __init__ when the trailing segment names an item, not a module', () => {
    // `from pkg import Service` -- a class defined in `pkg/__init__.py`.
    // There is no `pkg/Service.py`, so dropping the item is the right
    // answer and must NOT regress to unresolved.
    expect(r('main.py', 'pkg.Service')).toEqual({ path: 'pkg/__init__.py', confidence: 'resolved' })
  })

  it('applies the same preference to a relative from-import', () => {
    expect(r('main.py', '.pkg.service').path).toBe('pkg/service.py')
    expect(r('pkg/service.py', '.helper.helper').path).toBe('pkg/helper.py')
  })

  it('does not manufacture a target from a single-segment specifier by dropping it', () => {
    // Dropping the only segment would leave an empty module path; `os` must
    // stay unresolved rather than resolving to whatever an empty path
    // happens to build.
    expect(r('main.py', 'os')).toEqual({ path: null, confidence: 'unresolved' })
    expect(r('main.py', 'nosuch.module')).toEqual({ path: null, confidence: 'unresolved' })
  })
})

describe('resolverFor dispatches by language', () => {
  it('selects the python resolver for a .py file and the javascript resolver for a .ts file', () => {
    expect(resolverFor('a.py').id).toBe('python')
    expect(resolverFor('a.ts').id).toBe('javascript')
  })
})
