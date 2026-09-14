import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createArchServer } from './server.js'

/**
 * Runs the MCP server over stdio. Resolves when the transport closes.
 *
 * stdout carries JSON-RPC and nothing else — a stray console.log here
 * corrupts the protocol for the whole session. Diagnostics go to stderr.
 */
export async function serveStdio(): Promise<void> {
  const server = createArchServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('ai-software-architect MCP server ready on stdio\n')
  await new Promise<void>(resolvePromise => {
    transport.onclose = () => resolvePromise()
  })
}
