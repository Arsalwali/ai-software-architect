import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { resolve } from 'node:path'
import { withIndex, toolText } from '../tools/envelope.js'
import { buildOverview } from '../tools/overview.js'
import { searchCode } from '../tools/search.js'
import { getDependencies } from '../tools/dependencies.js'
import { impactOf } from '../tools/impact.js'
import { findCycles } from '../tools/cycles.js'
import { getCoupling } from '../tools/coupling.js'
import { findHotspots } from '../tools/hotspots.js'
import { getSymbol } from '../tools/symbol.js'
import { describeModule } from '../tools/module.js'
import { traceFlow } from '../tools/flow.js'

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

  server.registerTool('find_cycles', {
    title: 'Find circular dependencies',
    description:
      'Strongly-connected components in the dependency graph. Scope "module" finds cycles ' +
      'between directories, which are the architecturally interesting ones; scope "file" finds ' +
      'them between individual files, including inside a single module. Ranked by size, then ' +
      'by how many edges run inside the cycle.',
    inputSchema: {
      repo: repoArg,
      scope: z.enum(['module', 'file']).default('module'),
      minSize: z.number().int().min(1).max(100).default(2)
        .describe('Smallest cycle to report. 2 excludes self-referential single nodes.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, scope, minSize, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(repoRoot, store =>
      findCycles(store, { scope, minSize, limit }), dbFor(repoRoot)))
  })

  server.registerTool('get_coupling', {
    title: 'Get module coupling',
    description:
      'Per-module afferent and efferent coupling with instability, plus the heaviest ' +
      'module-to-module dependencies. Weight counts distinct file-to-file dependencies ' +
      'crossing the module boundary, not import statements, so a file importing the same ' +
      'neighbour twice is not double-counted.',
    inputSchema: {
      repo: repoArg,
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(repoRoot, store =>
      getCoupling(store, { limit }), dbFor(repoRoot)))
  })

  server.registerTool('find_hotspots', {
    title: 'Find technical-debt hotspots',
    description:
      'Technical-debt candidates ranked by structural weight multiplied by git churn, with ' +
      'every raw signal reported alongside the score. `gitAvailable: false` means the target ' +
      'is not a git repository (or has no history in the window), and the ranking falls back ' +
      'to structural weight only.',
    inputSchema: {
      repo: repoArg,
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      windowDays: z.number().int().min(1).max(3650).default(180)
        .describe('How far back to look for git churn and co-change signals.'),
    },
  }, async ({ repo, limit, windowDays }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(repoRoot, store =>
      findHotspots(store, repoRoot, { limit, windowDays }), dbFor(repoRoot)))
  })

  server.registerTool('get_symbol', {
    title: 'Get symbol details',
    description:
      'Definition site, signature, export status, and caller/callee counts for every symbol ' +
      'matching the name. Use `file` to disambiguate when several symbols share a name.',
    inputSchema: {
      repo: repoArg,
      name: z.string().min(1).describe('Symbol name to look up.'),
      file: z.string().optional().describe('Disambiguate by restricting to a path prefix.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, name, file, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(repoRoot, store =>
      getSymbol(store, { name, file, limit }), dbFor(repoRoot)))
  })

  server.registerTool('describe_module', {
    title: 'Describe a module',
    description:
      'A module\'s files, exported surface, dependencies and dependents with weights, and ' +
      'coupling metrics. `summary` is null until the summarizer is built; ' +
      '`summaryUnavailableReason` explains why.',
    inputSchema: {
      repo: repoArg,
      path: z.string().min(1).describe('Directory path of the module to describe.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, path, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(repoRoot, store =>
      describeModule(store, { path, limit }), dbFor(repoRoot)))
  })

  server.registerTool('trace_flow', {
    title: 'Trace a call-graph flow',
    description:
      'Forward call-graph walk from an entry point, as a tree annotated with files crossed ' +
      'and module boundaries crossed. `repeated: true` marks a node already expanded ' +
      'elsewhere in the tree (its own expansion is not repeated); `depthLimited` marks a walk ' +
      'cut short by `maxDepth`.',
    inputSchema: {
      repo: repoArg,
      entry: z.string().min(1).describe('Symbol name to start the walk from.'),
      file: z.string().optional().describe('Disambiguate the entry by restricting to a path prefix.'),
      maxDepth: z.number().int().min(1).max(10).default(4)
        .describe('How many hops to traverse. Results are limited to this depth; the response\'s ' +
          '`depthLimited` flag is true when more exists beyond it.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, entry, file, maxDepth, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(repoRoot, store =>
      traceFlow(store, { entry, file, maxDepth, limit }), dbFor(repoRoot)))
  })

  return server
}
