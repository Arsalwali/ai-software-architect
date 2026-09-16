import { describe, it, expect } from 'vitest'
import { goResolver, modulePrefixFrom } from '../src/resolve/go.js'

const known = new Set(['go.mod', 'helper/helper.go', 'service/service.go', 'main.go'])
const r = (from: string, spec: string, prefix = 'example.com/m') =>
  goResolver.resolve(from, spec, known, prefix)

describe('modulePrefixFrom', () => {
  it('reads the module line', () => {
    expect(modulePrefixFrom('module example.com/m\n\ngo 1.22\n')).toBe('example.com/m')
  })

  it('tolerates leading whitespace and trailing comments', () => {
    expect(modulePrefixFrom('  module   example.com/m // root\n')).toBe('example.com/m')
  })

  it('returns null when there is no module line', () => {
    expect(modulePrefixFrom('go 1.22\n')).toBeNull()
  })
})

describe('goResolver', () => {
  it('resolves an internal import to a file in the package directory', () => {
    expect(r('service/service.go', 'example.com/m/helper'))
      .toEqual({ path: 'helper/helper.go', confidence: 'resolved' })
  })

  it('reports a standard-library import as unresolved', () => {
    expect(r('main.go', 'fmt')).toEqual({ path: null, confidence: 'unresolved' })
  })

  it('reports a third-party import as unresolved', () => {
    expect(r('main.go', 'github.com/pkg/errors')).toEqual({ path: null, confidence: 'unresolved' })
  })

  it('reports everything unresolved when the module prefix is unknown', () => {
    expect(goResolver.resolve('service/service.go', 'example.com/m/helper', known, null).path)
      .toBeNull()
  })
})
