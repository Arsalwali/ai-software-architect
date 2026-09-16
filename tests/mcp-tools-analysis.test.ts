import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { createArchServer } from '../src/mcp/server.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let client: Client

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args })
  if (res.isError) throw new Error(String((res.content as any)[0]?.text))
  return JSON.parse(String((res.content as any)[0].text))
}

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-mcp2-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  const server = createArchServer({ dbPathOverride: () => dbPath })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

describe('the full tool surface', () => {
  it('exposes all ten tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'describe_module', 'find_cycles', 'find_hotspots', 'get_coupling',
      'get_dependencies', 'get_repo_overview', 'get_symbol', 'impact_of',
      'search_code', 'trace_flow',
    ])
  })

  it('gives every tool a substantive description', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(40)
  })
})

describe('each new tool answers through the MCP layer', () => {
  it('find_cycles', async () => {
    const r = await call('find_cycles', { repo: fixture })
    expect(Array.isArray(r.result.cycles)).toBe(true)
    expect(r.index.state).toBe('current')
  })

  it('get_coupling', async () => {
    const r = await call('get_coupling', { repo: fixture })
    expect(r.result.modules.length).toBeGreaterThan(0)
    expect(r.result.modules[0]).toHaveProperty('instability')
  })

  it('find_hotspots reaches git, proving repoRoot was threaded', async () => {
    const r = await call('find_hotspots', { repo: fixture })
    // The fixture IS a git repo, so a handler that dropped repoRoot would
    // report gitAvailable false here.
    expect(r.result.gitAvailable).toBe(true)
    expect(r.result.hotspots.length).toBeGreaterThan(0)
  })

  it('get_symbol', async () => {
    const r = await call('get_symbol', { repo: fixture, name: 'helper' })
    expect(r.result.matches[0].path).toBe('src/helper.ts')
  })

  it('describe_module', async () => {
    const r = await call('describe_module', { repo: fixture, path: 'src/services' })
    expect(r.result.files.length).toBeGreaterThan(0)
    expect(r.result.summary).toBeNull()
    expect(r.result.summaryUnavailableReason).toBeTruthy()
  })

  it('trace_flow', async () => {
    const r = await call('trace_flow', { repo: fixture, entry: 'place' })
    expect(r.result.root.name).toBe('place')
  })
})

describe('input validation on the new tools', () => {
  it('rejects an invalid cycle scope', async () => {
    const res = await client.callTool({ name: 'find_cycles', arguments: { repo: fixture, scope: 'galaxy' } })
    expect(res.isError).toBe(true)
  })

  it('rejects a missing required argument', async () => {
    const res = await client.callTool({ name: 'get_symbol', arguments: { repo: fixture } })
    expect(res.isError).toBe(true)
  })
})
