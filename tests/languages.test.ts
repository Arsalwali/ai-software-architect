import { describe, it, expect } from 'vitest'
import { languageForPath, loadLanguage } from '../src/parser/languages.js'

describe('language registry', () => {
  it('maps TypeScript extensions to the typescript grammar', () => {
    expect(languageForPath('src/a.ts')?.id).toBe('typescript')
    expect(languageForPath('src/a.tsx')?.id).toBe('tsx')
  })

  it('returns null for unknown extensions', () => {
    expect(languageForPath('README.md')).toBeNull()
    expect(languageForPath('data.bin')).toBeNull()
  })

  it('loads a grammar that can parse source', async () => {
    const def = languageForPath('a.ts')!
    const lang = await loadLanguage(def)
    expect(lang.nodeTypeCount).toBeGreaterThan(0)
  })

  it('memoizes grammar loading', async () => {
    const def = languageForPath('a.ts')!
    expect(await loadLanguage(def)).toBe(await loadLanguage(def))
  })
})
