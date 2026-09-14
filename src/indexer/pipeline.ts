import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RepoParser } from '../parser/parser.js'
import { GraphStore, type EdgeInput, type ImportInput } from '../store/graph-store.js'
import { gitHeadCommit } from '../repo/repo-source.js'
import { discoverFiles } from './discover.js'
import { resolveImport } from './resolve-imports.js'
import { resolveCallsForFile } from './resolve-calls.js'
import type { ParsedFile } from '../types.js'

export interface ColdIndexOptions {
  repoRoot: string
  dbPath: string
  batchSize?: number
  onProgress?: (message: string) => void
}

export interface IndexReport {
  filesIndexed: number
  filesSkipped: number
  symbols: number
  edges: number
  parseErrors: number
  durationMs: number
}

const DEFAULT_BATCH_SIZE = 500

export async function runColdIndex(options: ColdIndexOptions): Promise<IndexReport> {
  const { repoRoot, dbPath, batchSize = DEFAULT_BATCH_SIZE, onProgress } = options
  const startedAt = Date.now()

  mkdirSync(dirname(dbPath), { recursive: true })
  const store = GraphStore.open(dbPath)

  try {
    // Phase 6's guarantee starts here: clear head_commit so an interrupted run
    // is visibly incomplete rather than silently half-written.
    store.setMeta('head_commit', '')
    store.clear()

    // Phase 1 — discover
    const { files, skipped } = discoverFiles(repoRoot)
    onProgress?.(`discovered ${files.length} files, skipped ${skipped.length}`)

    // Phases 2–3 — parse and persist nodes, in batches, discarding ASTs
    const parser = await RepoParser.create()
    let parseErrors = 0
    let symbolCount = 0

    for (let start = 0; start < files.length; start += batchSize) {
      const batch: ParsedFile[] = []
      for (const path of files.slice(start, start + batchSize)) {
        const parsed = parseOne(parser, repoRoot, path)
        parseErrors += parsed.errors.length
        symbolCount += parsed.symbols.length
        batch.push(parsed)
      }
      store.insertParsedFiles(batch)
      onProgress?.(`parsed ${Math.min(start + batchSize, files.length)}/${files.length}`)
    }

    // Phase 4a — resolve imports
    const knownPaths = new Set(store.allFilePaths())
    const fileIdByPath = new Map<string, number>()
    for (const path of knownPaths) fileIdByPath.set(path, store.fileIdByPath(path)!)

    const importRows: ImportInput[] = []
    const importedFileIds = new Map<number, number[]>()

    for (const path of files) {
      const fileId = fileIdByPath.get(path)
      if (fileId === undefined) continue
      const parsed = parseOne(parser, repoRoot, path)
      const targets: number[] = []

      for (const raw of parsed.imports) {
        const { path: resolvedPath, confidence } = resolveImport(path, raw.specifier, knownPaths)
        const resolvedFileId = resolvedPath ? fileIdByPath.get(resolvedPath) ?? null : null
        if (resolvedFileId !== null) targets.push(resolvedFileId)
        importRows.push({
          fileId,
          rawSpecifier: raw.specifier,
          resolvedFileId,
          kind: raw.kind,
          confidence,
          line: raw.line,
        })
      }
      importedFileIds.set(fileId, targets)
    }
    store.insertImports(importRows)

    // Phase 4b — resolve calls against the now-complete symbol table
    const symbolsByFile = store.symbolsByFile()
    const exportedByFile = store.exportedSymbolsByFile()
    const edges: EdgeInput[] = []

    for (const path of files) {
      const fileId = fileIdByPath.get(path)
      if (fileId === undefined) continue
      const parsed = parseOne(parser, repoRoot, path)
      if (parsed.callSites.length === 0) continue

      edges.push(...resolveCallsForFile({
        srcFileId: fileId,
        localSymbols: symbolsByFile.get(fileId) ?? [],
        importedFileIds: importedFileIds.get(fileId) ?? [],
        exportedByFile,
        callSites: parsed.callSites,
      }))
    }

    // Phase 5 — persist edges
    store.insertEdges(edges)

    // Phase 6 — finalize. head_commit is written last and only on success.
    store.analyze()
    store.setMeta('indexed_at', String(Date.now()))
    store.setMeta('files_indexed', String(files.length))
    store.setMeta('files_skipped', String(skipped.length))
    store.setMeta('repo_root', repoRoot)
    store.setMeta('head_commit', gitHeadCommit(repoRoot) ?? '')

    return {
      filesIndexed: files.length,
      filesSkipped: skipped.length,
      symbols: symbolCount,
      edges: edges.length,
      parseErrors,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    store.close()
  }
}

function parseOne(parser: RepoParser, repoRoot: string, path: string): ParsedFile {
  let source: string
  try {
    source = readFileSync(join(repoRoot, path), 'utf8')
  } catch {
    source = ''
  }
  return parser.parse(path, source)
}
