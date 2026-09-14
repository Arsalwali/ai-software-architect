import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { GraphStore, type EdgeInput, type ImportInput } from '../store/graph-store.js'
import { gitHeadCommit } from '../repo/repo-source.js'
import { computeChangeSet } from './changeset.js'
import { resolveImport } from './resolve-imports.js'
import { resolveCallsForFile } from './resolve-calls.js'
import { parseAll } from './parse-pool.js'
import { runColdIndex, type IndexReport } from './pipeline.js'

export interface IncrementalOptions {
  repoRoot: string
  dbPath: string
  onProgress?: (message: string) => void
}

export interface IncrementalReport extends IndexReport {
  changedFiles: number
  deletedFiles: number
  /** Files actually re-parsed: the changed set plus its one-hop dilation. */
  reparsedFiles: number
  fellBackToCold: boolean
}

export async function runIncrementalIndex(options: IncrementalOptions): Promise<IncrementalReport> {
  const { repoRoot, dbPath, onProgress } = options
  const startedAt = Date.now()

  mkdirSync(dirname(dbPath), { recursive: true })

  // A usable incremental run needs a complete index to build on. Anything
  // else — missing, interrupted, schema-bumped — is a cold index, not a
  // repair attempt on an unknown state.
  if (!hasCompleteIndex(dbPath)) {
    onProgress?.('no complete index found, running a full index')
    const cold = await runColdIndex({ repoRoot, dbPath, onProgress })
    return { ...cold, changedFiles: cold.filesIndexed, deletedFiles: 0, reparsedFiles: cold.filesIndexed, fellBackToCold: true }
  }

  const store = GraphStore.open(dbPath)

  try {
    const changes = computeChangeSet(repoRoot, store)
    onProgress?.(`${changes.changed.length} changed, ${changes.deleted.length} deleted`)

    if (changes.changed.length === 0 && changes.deleted.length === 0) {
      // Still refresh the freshness markers so a HEAD-only move (a commit that
      // touched nothing we index) stops reporting stale.
      finalize(store, repoRoot, changes.changed.length + changes.unchanged.length, changes.skipped)
      return report(store, startedAt, changes, 0, false)
    }

    store.setMeta('head_commit', '')
    store.setMeta('index_complete', '')

    // HAZARD 2: capture the dilation as PATHS before anything is deleted.
    const idsByPath = store.fileIdsByPath()
    const pathsById = store.pathsById()
    const dilation = new Set<string>(changes.changed)
    for (const path of [...changes.changed, ...changes.deleted]) {
      const fileId = idsByPath.get(path)
      if (fileId === undefined) continue
      for (const importerId of store.filesImporting(fileId)) {
        const importerPath = pathsById.get(importerId)
        if (importerPath) dilation.add(importerPath)
      }
    }
    // A file that vanished cannot be re-parsed.
    for (const gone of changes.deleted) dilation.delete(gone)

    store.deleteFilesByPath(changes.deleted)

    const toParse = [...dilation].sort()
    const parsed = await parseAll({
      repoRoot,
      paths: toParse,
      onBatch: (done, total) => onProgress?.(`parsed ${done}/${total}`),
    })
    const parsedByPath = new Map(parsed.map(p => [p.path, p]))

    // HAZARD 1: re-persist nodes ONLY for files whose content actually
    // changed. Dilation-only files keep their symbol rows and ids, so edges
    // pointing at them from elsewhere survive.
    const changedSet = new Set(changes.changed)
    const changedParsed = parsed.filter(p => changedSet.has(p.path))
    if (changedParsed.length > 0) store.insertParsedFiles(changedParsed)

    // Ids move when nodes are re-inserted, so re-read every map afterwards.
    const knownPaths = new Set(store.allFilePaths())
    const freshIds = store.fileIdsByPath()

    // Replace imports and outgoing edges for the whole dilation.
    const importRows: ImportInput[] = []
    const importedFileIds = new Map<number, number[]>()

    for (const path of toParse) {
      const fileId = freshIds.get(path)
      const file = parsedByPath.get(path)
      if (fileId === undefined || !file) continue

      store.deleteImportsForFile(fileId)
      store.deleteEdgesFromFile(fileId)

      const targets: number[] = []
      for (const raw of file.imports) {
        const { path: resolvedPath, confidence } = resolveImport(path, raw.specifier, knownPaths)
        const resolvedFileId = resolvedPath ? freshIds.get(resolvedPath) ?? null : null
        if (resolvedFileId !== null) targets.push(resolvedFileId)
        importRows.push({
          fileId, rawSpecifier: raw.specifier, resolvedFileId,
          kind: raw.kind, confidence, line: raw.line,
        })
      }
      importedFileIds.set(fileId, targets)
    }
    store.insertImports(importRows)

    // Re-resolve calls for the dilation against the now-current symbol table.
    const symbolsByFile = store.symbolsByFile()
    const exportedByFile = store.exportedSymbolsByFile()
    const edges: EdgeInput[] = []

    for (const path of toParse) {
      const fileId = freshIds.get(path)
      const file = parsedByPath.get(path)
      if (fileId === undefined || !file || file.callSites.length === 0) continue
      edges.push(...resolveCallsForFile({
        srcFileId: fileId,
        localSymbols: symbolsByFile.get(fileId) ?? [],
        importedFileIds: importedFileIds.get(fileId) ?? [],
        exportedByFile,
        callSites: file.callSites,
      }))
    }
    store.insertEdges(edges)

    finalize(store, repoRoot, knownPaths.size, changes.skipped)
    return report(store, startedAt, changes, toParse.length, false)
  } finally {
    store.close()
  }
}

function hasCompleteIndex(dbPath: string): boolean {
  let store: GraphStore
  try {
    store = GraphStore.open(dbPath)
  } catch {
    return false
  }
  try {
    return store.getMeta('index_complete') === '1'
  } finally {
    store.close()
  }
}

function finalize(
  store: GraphStore,
  repoRoot: string,
  filesIndexed: number,
  skipped: Array<{ reason: string }>,
): void {
  store.analyze()
  store.setMeta('indexed_at', String(Date.now()))
  store.setMeta('files_indexed', String(filesIndexed))
  store.setMeta('files_skipped', String(skipped.length))
  const byReason: Record<string, number> = {}
  for (const entry of skipped) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1
  store.setMeta('files_skipped_by_reason', JSON.stringify(byReason))
  store.setMeta('repo_root', repoRoot)
  // Written last and only on success, exactly as the cold path does it.
  store.setMeta('head_commit', gitHeadCommit(repoRoot) ?? '')
  store.setMeta('index_complete', '1')
}

function report(
  store: GraphStore,
  startedAt: number,
  changes: { changed: string[]; deleted: string[]; unchanged: string[]; skipped: unknown[] },
  reparsedFiles: number,
  fellBackToCold: boolean,
): IncrementalReport {
  return {
    filesIndexed: store.allFilePaths().length,
    filesSkipped: changes.skipped.length,
    symbols: [...store.symbolsByFile().values()].reduce((n, rows) => n + rows.length, 0),
    edges: store.edgeCount(),
    parseErrors: 0,
    durationMs: Date.now() - startedAt,
    changedFiles: changes.changed.length,
    deletedFiles: changes.deleted.length,
    reparsedFiles,
    fellBackToCold,
  }
}
