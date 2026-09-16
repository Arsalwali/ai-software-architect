import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { GraphStore, type EdgeInput, type ImportInput } from '../store/graph-store.js'
import { gitHeadCommit } from '../repo/repo-source.js'
import { discoverFiles } from './discover.js'
import { resolveImport } from './resolve-imports.js'
import { resolveCallsForFile } from './resolve-calls.js'
import { sameDirectoryFileIds } from './same-package.js'
import { parseAll } from './parse-pool.js'

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
    // is visibly incomplete rather than silently half-written. head_commit
    // alone can't carry that signal for non-git repos (it's '' on success
    // there too), so index_complete is a dedicated completion flag.
    store.setMeta('head_commit', '')
    store.setMeta('index_complete', '')
    store.clear()

    // Phase 1 — discover
    const { files, skipped } = discoverFiles(repoRoot)
    onProgress?.(`discovered ${files.length} files, skipped ${skipped.length}`)

    // Phase 2 — parse once, across cores
    const parsed = await parseAll({
      repoRoot,
      paths: files,
      onBatch: (done, total) => onProgress?.(`parsed ${done}/${total}`),
    })

    let parseErrors = 0
    let symbolCount = 0
    for (const file of parsed) {
      parseErrors += file.errors.length
      symbolCount += file.symbols.length
    }

    // Phase 3 — persist nodes in batches
    for (let start = 0; start < parsed.length; start += batchSize) {
      store.insertParsedFiles(parsed.slice(start, start + batchSize))
    }

    // Phase 4a — resolve imports
    const knownPaths = new Set(store.allFilePaths())
    const fileIdByPath = new Map<string, number>()
    for (const path of knownPaths) fileIdByPath.set(path, store.fileIdByPath(path)!)

    const importRows: ImportInput[] = []
    const importedFileIds = new Map<number, number[]>()

    for (const file of parsed) {
      const fileId = fileIdByPath.get(file.path)
      if (fileId === undefined) continue
      const targets: number[] = []

      for (const raw of file.imports) {
        const { path: resolvedPath, confidence } = resolveImport(file.path, raw.specifier, knownPaths, repoRoot)
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
    // Go/Java only (see same-package.ts): same-directory siblings need no
    // import at all, so their candidate symbols must be gathered separately
    // from the import-based `exportedByFile` above.
    const sameDirFileIds = sameDirectoryFileIds(knownPaths, fileIdByPath)
    const edges: EdgeInput[] = []

    for (const file of parsed) {
      const fileId = fileIdByPath.get(file.path)
      if (fileId === undefined || file.callSites.length === 0) continue
      edges.push(...resolveCallsForFile({
        srcFileId: fileId,
        localSymbols: symbolsByFile.get(fileId) ?? [],
        importedFileIds: importedFileIds.get(fileId) ?? [],
        exportedByFile,
        sameDirectorySymbols: (sameDirFileIds.get(fileId) ?? []).flatMap(id => symbolsByFile.get(id) ?? []),
        callSites: file.callSites,
      }))
    }

    // Phase 5 — persist edges
    store.insertEdges(edges)

    // Phase 6 — finalize. head_commit and index_complete are written last
    // and only on success.
    store.analyze()
    store.setMeta('indexed_at', String(Date.now()))
    store.setMeta('files_indexed', String(files.length))
    store.setMeta('files_skipped', String(skipped.length))
    // Every skip already carries a specific reason (discover.ts classifies
    // all six); persist the breakdown too so a user can ask *why* a file is
    // missing from the graph, not just that some files were skipped.
    const skippedByReason: Partial<Record<string, number>> = {}
    for (const entry of skipped) {
      skippedByReason[entry.reason] = (skippedByReason[entry.reason] ?? 0) + 1
    }
    store.setMeta('files_skipped_by_reason', JSON.stringify(skippedByReason))
    store.setMeta('repo_root', repoRoot)
    store.setMeta('head_commit', gitHeadCommit(repoRoot) ?? '')
    store.setMeta('index_complete', '1')

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
