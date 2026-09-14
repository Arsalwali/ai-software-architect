import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist/cli.js')

/** Speaks one JSON-RPC initialize + tools/list exchange over stdio. */
function listToolsOverStdio(): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [CLI, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] })
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
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

    setTimeout(() => { child.kill(); resolvePromise({ stdout, stderr }) }, 4000)
  })
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
})
