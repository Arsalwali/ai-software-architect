import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve } from 'node:path'
import { withIndex, toolText } from '../tools/envelope.js'
import { buildOverview } from '../tools/overview.js'
import { searchCode } from '../tools/search.js'
import { getDependencies } from '../tools/dependencies.js'
import { impactOf } from '../tools/impact.js'

export interface ArchServerOptions {
  /** Test seam: point the server at a specific index instead of ~/.arch. */
  dbPathOverride?: (repoRoot: string) => string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

export function createArchServer(options: ArchServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'ai-software-architect', version: '0.2.0' })
  const dbFor = (repoRoot: string): string | undefined => options.dbPathOverride?.(repoRoot)

  const repoArg = z.string().optional()
    .describe('Path to the repository. Defaults to the current working directory.')

  server.registerTool('get_repo_overview', {
    title: 'Repository overview',
    description:
      'Structural overview of an indexed repository: file and symbol totals, languages, ' +
      'top-level modules, detected entry points, skipped files by reason, and the edge ' +
      'confidence breakdown. Start here when asked to explain an architecture. Cheap and ' +
      'fully structural — reads the index only, never the source.',
    inputSchema: { repo: repoArg },
  }, async ({ repo }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(repoRoot, store => buildOverview(store, repoRoot), dbFor(repoRoot)))
  })

  server.registerTool('search_code', {
    title: 'Search code',
    description:
      'Find symbols and text in the indexed repository. Returns file:line pointers with a ' +
      'one-line snippet, ranked exact-symbol then partial-symbol then full text. Use this to ' +
      'locate where something lives (for example "where is authentication implemented"), then ' +
      'read the files it points at.',
    inputSchema: {
      repo: repoArg,
      query: z.string().min(1).describe('Symbol name or text to search for.'),
      kind: z.enum(['function', 'method', 'class', 'interface', 'type', 'enum', 'variable'])
        .optional().describe('Restrict to one symbol kind. Disables the full-text half.'),
      lang: z.string().optional().describe('Restrict to one language id, e.g. "typescript".'),
      path: z.string().optional().describe('Restrict to paths beginning with this prefix.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, query, kind, lang, path, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(
      repoRoot,
      store => searchCode(store, repoRoot, { query, kind, lang, path, limit }),
      dbFor(repoRoot),
    ))
  })

  server.registerTool('get_dependencies', {
    title: 'Get dependencies',
    description:
      'Walk the dependency graph from a file, directory, or symbol. direction "out" gives what ' +
      'the target depends on; "in" gives what depends on it. Files and directories traverse ' +
      'imports; symbols traverse call edges and each result carries its confidence tier.',
    inputSchema: {
      repo: repoArg,
      target: z.string().min(1).describe('A file path, a directory, or a symbol name.'),
      direction: z.enum(['in', 'out']).default('out'),
      depth: z.number().int().min(1).max(10).default(2)
        .describe('How many hops to traverse. Results are limited to this depth; the response\'s ' +
          '`depthLimited` flag is true when more exists beyond it.'),
      kind: z.enum(['calls', 'extends', 'implements', 'instantiates', 'references'])
        .optional().describe('Restrict to one edge kind. Symbol targets only.'),
      minConfidence: z.enum(['exact', 'resolved', 'heuristic', 'ambiguous', 'unresolved'])
        .optional().describe('Drop edges ranked below this tier.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, target, direction, depth, kind, minConfidence, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(
      repoRoot,
      store => getDependencies(store, { target, direction, depth, kind, minConfidence, limit }),
      dbFor(repoRoot),
    ))
  })

  server.registerTool('impact_of', {
    title: 'Impact of changing a symbol',
    description:
      'What could break if this symbol changes. Returns transitive references bucketed by ' +
      'evidence: "verified" (a type resolver confirmed the binding), "likely" (the name matched ' +
      'exactly one candidate), and "ambiguous" (the name matched several, all of which are ' +
      'reported). Treat ambiguous results as candidates to check, not as confirmed callers. ' +
      'Also reports whether a matched symbol is exported from a detected entry point ' +
      '(a conventional filename or a path declared in package.json); false means "not ' +
      'detected by this check", not "safe to change".',
    inputSchema: {
      repo: repoArg,
      symbol: z.string().min(1).describe('The symbol name to analyse.'),
      file: z.string().optional().describe('Disambiguate by restricting to a path prefix.'),
      maxDepth: z.number().int().min(1).max(10).default(3)
        .describe('How many hops to traverse. Results are limited to this depth; the response\'s ' +
          '`depthLimited` flag is true when more exists beyond it.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, symbol, file, maxDepth, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(
      repoRoot,
      store => impactOf(store, { symbol, file, maxDepth, limit, repoRoot }),
      dbFor(repoRoot),
    ))
  })

  return server
}
