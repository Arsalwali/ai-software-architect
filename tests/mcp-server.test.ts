import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { createArchServer } from '../src/mcp/server.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string
let client: Client

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args })
  if (res.isError) throw new Error(String((res.content as any)[0]?.text))
  return JSON.parse(String((res.content as any)[0].text))
}

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-mcp-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })

  const server = createArchServer({ dbPathOverride: () => dbPath })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

describe('tool registration', () => {
  it('exposes exactly the four core tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(
      ['get_dependencies', 'get_repo_overview', 'impact_of', 'search_code'],
    )
  })

  it('gives every tool a description', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(20)
  })

  it('publishes a JSON Schema for each tool', async () => {
    const { tools } = await client.listTools()
    const impact = tools.find(t => t.name === 'impact_of')!
    expect(impact.inputSchema.type).toBe('object')
    expect(Object.keys(impact.inputSchema.properties!)).toContain('symbol')
  })
})

describe('every response carries the index status', () => {
  it('on get_repo_overview', async () => {
    const r = await call('get_repo_overview', { repo: fixture })
    expect(r.index.state).toBe('current')
    expect(r.index.repoRoot).toBe(fixture)
  })

  it('on search_code', async () => {
    const r = await call('search_code', { repo: fixture, query: 'helper' })
    expect(r.index).toHaveProperty('state')
  })
})

describe('the tools answer real questions', () => {
  it('get_repo_overview reports separate confidence tiers', async () => {
    const r = await call('get_repo_overview', { repo: fixture })
    expect(r.result.edgeConfidence.unresolved).toBeGreaterThan(0)
    expect(r.result.edgeConfidence).toHaveProperty('ambiguous')
    expect(r.result.totals.files).toBeGreaterThan(0)
  })

  it('search_code finds a symbol and points at file:line', async () => {
    const r = await call('search_code', { repo: fixture, query: 'helper' })
    expect(r.result.hits[0].path).toBe('src/helper.ts')
    expect(r.result.hits[0].line).toBeGreaterThan(0)
  })

  it('get_dependencies walks imports', async () => {
    const r = await call('get_dependencies', { repo: fixture, target: 'src/helper.ts', direction: 'in' })
    expect(r.result.nodes.map((n: any) => n.path)).toContain('src/services/order.ts')
  })

  it('impact_of buckets by confidence', async () => {
    const r = await call('impact_of', { repo: fixture, symbol: 'helper' })
    expect(r.result.buckets.likely).toBeGreaterThan(0)
    expect(r.result.buckets).toHaveProperty('verified')
    expect(r.result.buckets).toHaveProperty('ambiguous')
  })

  it('impact_of explains itself when a symbol is unknown', async () => {
    const r = await call('impact_of', { repo: fixture, symbol: 'definitelyNotHere' })
    expect(r.result.note).toMatch(/not found/i)
  })
})

describe('impact_of passes repoRoot through, so package.json entry points are detected', () => {
  // The shared fixture's src/index.ts exports nothing, so it cannot prove
  // this: exportedFromEntryPoint would read false there regardless of
  // whether repoRoot reaches impactOf. This dedicated fixture (following
  // the pattern in tests/tools-impact.test.ts) declares its entry point
  // ONLY via package.json's "main", at a non-conventional basename
  // (src/public.ts, not index.ts/main.ts/...), so the assertion below can
  // only pass if the MCP handler actually threads repoRoot into impactOf.
  let entryFixture: string
  let entryClient: Client

  beforeAll(async () => {
    entryFixture = mkdtempSync(join(tmpdir(), 'arch-mcp-entry-'))
    mkdirSync(join(entryFixture, 'src'), { recursive: true })
    writeFileSync(
      join(entryFixture, 'src/public.ts'),
      'export function DeclaredEntry(): number {\n  return 2;\n}\n',
    )
    writeFileSync(
      join(entryFixture, 'src/consumer.ts'),
      'import { DeclaredEntry } from "./public";\n\n' +
      'export function useIt(): number {\n  return DeclaredEntry();\n}\n',
    )
    writeFileSync(
      join(entryFixture, 'package.json'),
      JSON.stringify({ name: 'mcp-entry-fixture', main: 'src/public.ts' }, null, 2),
    )

    const entryDbPath = join(mkdtempSync(join(tmpdir(), 'arch-mcp-entry-db-')), 'index.db')
    await runColdIndex({ repoRoot: entryFixture, dbPath: entryDbPath })

    const entryServer = createArchServer({ dbPathOverride: () => entryDbPath })
    const [entryClientTransport, entryServerTransport] = InMemoryTransport.createLinkedPair()
    entryClient = new Client({ name: 'entry-test-client', version: '1.0.0' })
    await Promise.all([
      entryServer.connect(entryServerTransport),
      entryClient.connect(entryClientTransport),
    ])
  })

  it('flags a symbol declared as package.json "main" even though its filename is not conventional', async () => {
    const res = await entryClient.callTool({
      name: 'impact_of',
      arguments: { repo: entryFixture, symbol: 'DeclaredEntry' },
    })
    if (res.isError) throw new Error(String((res.content as any)[0]?.text))
    const body = JSON.parse(String((res.content as any)[0].text))
    expect(body.result.exportedFromEntryPoint).toBe(true)
  })
})

describe('input validation', () => {
  it('rejects a missing required argument as a tool error, not a crash', async () => {
    const res = await client.callTool({ name: 'impact_of', arguments: { repo: fixture } })
    expect(res.isError).toBe(true)
  })

  it('rejects an out-of-range depth', async () => {
    const res = await client.callTool({
      name: 'get_dependencies',
      arguments: { repo: fixture, target: 'src/helper.ts', direction: 'in', depth: 999 },
    })
    expect(res.isError).toBe(true)
  })

  it('rejects an invalid direction', async () => {
    const res = await client.callTool({
      name: 'get_dependencies',
      arguments: { repo: fixture, target: 'src/helper.ts', direction: 'sideways' },
    })
    expect(res.isError).toBe(true)
  })
})

describe('truncation is always visible', () => {
  it('reports the true total when a result is capped', async () => {
    const r = await call('search_code', { repo: fixture, query: 'e', limit: 2 })
    expect(r.result.hits).toHaveLength(2)
    expect(r.result.truncated.total).toBeGreaterThan(2)
  })
})

describe('freshness is reflected, not hidden', () => {
  it('absorbs a small edit and reports current', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n + 42; }\n')
    const r = await call('get_repo_overview', { repo: fixture })
    expect(r.index.state).toBe('current')
  })
})
