import { describe, it, expect } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { buildFixture } from './fixture-builder.js'
import { withTestHome } from './test-home.js'

const CLI = join(process.cwd(), 'dist/cli.js')
const { env: TEST_ENV } = withTestHome()

/**
 * Speaks a JSON-RPC `initialize` + `notifications/initialized` handshake
 * over stdio against `arch serve`, then sends any additional messages
 * supplied by the caller. Collects everything written to stdout and stderr
 * for the caller to inspect.
 */
function runStdioSession(
  extraMessages: unknown[] = [],
  timeoutMs = 4000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [CLI, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'], env: TEST_ENV })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' },
    } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    for (const msg of extraMessages) send(msg)

    setTimeout(() => { child.kill(); resolvePromise({ stdout, stderr }) }, timeoutMs)
  })
}

/** Speaks one JSON-RPC initialize + tools/list exchange over stdio. */
function listToolsOverStdio(): Promise<{ stdout: string; stderr: string }> {
  return runStdioSession([{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }])
}

describe('arch serve', () => {
  it('speaks JSON-RPC on stdout and lists the four tools', async () => {
    const { stdout } = await listToolsOverStdio()
    expect(stdout).toContain('"result"')
    for (const name of ['get_repo_overview', 'search_code', 'get_dependencies', 'impact_of']) {
      expect(stdout).toContain(name)
    }
  }, 20_000)

  it('writes nothing but JSON-RPC to stdout', async () => {
    const { stdout } = await listToolsOverStdio()
    const lines = stdout.split('\n').filter(l => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  }, 20_000)

  it('keeps stdout as pure JSON-RPC during a tool call that reindexes mid-request', async () => {
    // A real index, built by the compiled CLI, exactly as a user would.
    const fixture = buildFixture()
    execFileSync('node', [CLI, 'index', fixture], { stdio: 'ignore', env: TEST_ENV })

    // Dirty the tree after indexing so the freshness gate has an actual
    // delta to absorb inside the upcoming tool call, rather than hitting
    // the no-op "already current" path. This is what exercises the
    // mid-request incremental reindex — the exact hazard this test file
    // exists to catch a regression in.
    appendFileSync(
      join(fixture, 'src/helper.ts'),
      '\nexport function extra(): number {\n  return 2;\n}\n',
    )

    const { stdout } = await runStdioSession([
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'get_repo_overview', arguments: { repo: fixture },
      } },
    ], 6000)

    const lines = stdout.split('\n').filter(l => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    const responses = lines.map(line => {
      expect(() => JSON.parse(line)).not.toThrow()
      return JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
    })

    const callResponse = responses.find(r => r.id === 2)
    expect(callResponse).toBeDefined()
    expect(callResponse!.error).toBeUndefined()
    expect(callResponse!.result).toBeDefined()
  }, 20_000)
})
