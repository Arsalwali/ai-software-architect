import { describe, it, expect, beforeAll } from 'vitest'
import { RepoParser } from '../src/parser/parser.js'

const SOURCE = `import { helper } from "./helper";
import fs from "node:fs";
const lazy = await import("./lazy");
const legacy = require("./legacy");
export class Service {
  run() { return helper(1); }
}
function internal() { return new Service(); }
topLevelCall();
export const handler = async (req) => { return notify(2); };
`

let parser: RepoParser
beforeAll(async () => { parser = await RepoParser.create() })

describe('import extraction', () => {
  it('captures static, dynamic and require imports with their kind', () => {
    const imports = parser.parse('src/a.ts', SOURCE).imports
    expect(imports.map(i => `${i.kind}:${i.specifier}`).sort()).toEqual([
      'dynamic:./lazy',
      'require:./legacy',
      'static:./helper',
      'static:node:fs',
    ])
  })

  it('records 1-based import lines', () => {
    const imports = parser.parse('src/a.ts', SOURCE).imports
    expect(imports.find(i => i.specifier === './helper')!.line).toBe(1)
  })
})

describe('call-site extraction', () => {
  it('captures calls and attributes them to the enclosing symbol', () => {
    const calls = parser.parse('src/a.ts', SOURCE).callSites
    const byName = new Map(calls.map(c => [c.name, c]))
    expect(byName.get('helper')!.enclosingSymbol).toBe('run')
    expect(byName.get('Service')!.enclosingSymbol).toBe('internal')
    expect(byName.get('topLevelCall')!.enclosingSymbol).toBeNull()
  })

  it('attributes a call inside an arrow function assigned to a const to the const name', () => {
    const calls = parser.parse('src/a.ts', SOURCE).callSites
    expect(calls.find(c => c.name === 'notify')!.enclosingSymbol).toBe('handler')
  })

  it('distinguishes instantiation from invocation', () => {
    const calls = parser.parse('src/a.ts', SOURCE).callSites
    expect(calls.find(c => c.name === 'Service')!.kind).toBe('instantiates')
    expect(calls.find(c => c.name === 'helper')!.kind).toBe('calls')
  })

  it('excludes import mechanisms from call sites', () => {
    const calls = parser.parse('src/a.ts', SOURCE).callSites
    expect(calls.map(c => c.name)).not.toContain('require')
  })
})

describe('error recovery', () => {
  const BROKEN = `function good() { return 1; }
function BROKEN( { { {
`
  it('keeps symbols that parsed and records the error', () => {
    const parsed = parser.parse('src/broken.ts', BROKEN)
    expect(parsed.symbols.map(s => s.name)).toContain('good')
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(parsed.errors[0].line).toBe(2)
  })

  it('reports no errors for a clean file', () => {
    expect(parser.parse('src/a.ts', SOURCE).errors).toEqual([])
  })
})
