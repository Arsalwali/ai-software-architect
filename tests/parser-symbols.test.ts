import { describe, it, expect, beforeAll } from 'vitest'
import { RepoParser } from '../src/parser/parser.js'

const SOURCE = `import { helper } from "./helper";
export interface Config { port: number }
export type Alias = string;
export enum Mode { A, B }
export class Service {
  run() { return helper(1); }
}
export const handler = async (req) => { return 1; };
function internal() { return 2; }
`

let parser: RepoParser

beforeAll(async () => { parser = await RepoParser.create() })

describe('symbol extraction', () => {
  it('extracts every top-level declaration with its kind', () => {
    const parsed = parser.parse('src/service.ts', SOURCE)
    const found = parsed.symbols.map(s => `${s.kind}:${s.name}`).sort()
    expect(found).toEqual([
      'class:Service',
      'enum:Mode',
      'function:handler',
      'function:internal',
      'interface:Config',
      'method:run',
      'type:Alias',
    ])
  })

  it('records export status', () => {
    const parsed = parser.parse('src/service.ts', SOURCE)
    const byName = new Map(parsed.symbols.map(s => [s.name, s]))
    expect(byName.get('Service')!.exported).toBe(true)
    expect(byName.get('handler')!.exported).toBe(true)
    expect(byName.get('internal')!.exported).toBe(false)
  })

  it('attributes methods to their enclosing class', () => {
    const parsed = parser.parse('src/service.ts', SOURCE)
    expect(parsed.symbols.find(s => s.name === 'run')!.parentName).toBe('Service')
    expect(parsed.symbols.find(s => s.name === 'internal')!.parentName).toBeNull()
  })

  it('records 1-based line spans', () => {
    const parsed = parser.parse('src/service.ts', SOURCE)
    const service = parsed.symbols.find(s => s.name === 'Service')!
    expect(service.startLine).toBe(5)
    expect(service.endLine).toBe(7)
  })

  it('sets lang to null and returns empty results for unknown extensions', () => {
    const parsed = parser.parse('README.md', '# hello')
    expect(parsed.lang).toBeNull()
    expect(parsed.symbols).toEqual([])
    expect(parsed.contentHash).toHaveLength(64)
  })

  it('produces a stable content hash', () => {
    const a = parser.parse('src/service.ts', SOURCE)
    const b = parser.parse('src/other.ts', SOURCE)
    expect(a.contentHash).toBe(b.contentHash)
  })
})
