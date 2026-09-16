import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { GraphStore, type EdgeInput, type ImportInput } from '../store/graph-store.js'
import { gitHeadCommit } from '../repo/repo-source.js'
import { computeChangeSet } from './changeset.js'
import { resolveImport } from './resolve-imports.js'
import { resolveCallsForFile } from './resolve-calls.js'
import { groupBySamePackage, sameDirectoryFileIds } from './same-package.js'
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

  // A usable incremental run needs a complete index to build on. A missing
  // or interrupted index runs a cold index instead of attempting a repair on
  // an unknown state. A schema-bumped index is NOT routed to the cold path:
  // GraphStore.open throws for it, and that throw is left to propagate out
  // of hasCompleteIndex rather than being swallowed, so it surfaces here
  // directly. Per spec §9 ("refuse to serve; instruct the user to reindex —
  // no silent migration"), the actionable "arch index --force" message the
  // store already composes is what the caller sees; routing it through a
  // cold index would either silently rebuild (spec violation) or re-throw
  // the identical error by coincidence via a second open of the same file.
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

    // The path set that will be "known" once this run's changes land, usable
    // BEFORE any mutation because it is derived purely from the ChangeSet:
    // `changed` already includes newly-added files, and `unchanged` already
    // excludes deleted ones.
    const futurePaths = new Set<string>([...changes.changed, ...changes.unchanged])

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

    // The filesImporting walk above only finds importers through a RESOLVED
    // edge into a changed file. An added file cannot have one pointing at it
    // yet — by definition nothing resolved to it before it existed — so it
    // is invisible to that walk even when it fixes a previously-unresolved
    // import, or shadows an existing resolution to a different file entirely
    // (e.g. "./mod" resolving to mod.ts instead of mod/index.ts once mod.ts
    // is added). Catch both by recomputing each indexed file's import
    // resolutions against the post-change path set and widening the
    // dilation wherever a target would change. No parsing needed: the raw
    // specifier is already stored and resolveImport is pure.
    for (const [path, fileId] of idsByPath) {
      if (dilation.has(path)) continue
      for (const imp of store.importsForFile(fileId)) {
        const { path: recomputed } = resolveImport(path, imp.rawSpecifier, futurePaths, repoRoot)
        const stored = imp.resolvedFileId === null ? null : pathsById.get(imp.resolvedFileId) ?? null
        if (recomputed !== stored) {
          dilation.add(path)
          break
        }
      }
    }

    // Same-package (same-directory) dilation, for Go/Java only (see
    // same-package.ts): sibling files in one directory reference each
    // other WITHOUT any import at all, so neither of the two widenings
    // above -- both walking RESOLVED IMPORT edges -- can ever discover that
    // relationship. Any changed, added, or deleted file must dilate every
    // OTHER file sharing its (language, directory) key, checked against
    // BOTH the pre-change and post-change known-path sets: a file moving
    // into or out of a directory changes its siblings' candidate pool
    // exactly as an import target appearing or disappearing does above.
    const sameDirGroupByPath = new Map<string, string[]>()
    for (const bucket of groupBySamePackage(new Set([...idsByPath.keys(), ...futurePaths])).values()) {
      for (const path of bucket) sameDirGroupByPath.set(path, bucket)
    }
    for (const path of [...changes.changed, ...changes.deleted]) {
      for (const sibling of sameDirGroupByPath.get(path) ?? []) {
        if (sibling !== path) dilation.add(sibling)
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
        const { path: resolvedPath, confidence } = resolveImport(path, raw.specifier, knownPaths, repoRoot)
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
    // Go/Java only: same-directory siblings need no import at all, so their
    // candidate symbols are gathered separately from the import-based
    // `exportedByFile` above -- mirrors pipeline.ts's cold-index path.
    const sameDirFileIds = sameDirectoryFileIds(knownPaths, freshIds)
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
        sameDirectorySymbols: (sameDirFileIds.get(fileId) ?? []).flatMap(id => symbolsByFile.get(id) ?? []),
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
  // No file on disk is unambiguously "no usable index yet" -- there is
  // nothing to fail to open. Anything that exists but throws on open
  // (schema mismatch, corruption) is a different situation entirely and
  // must NOT be swallowed into "false": per spec §9 a schema mismatch has to
  // refuse to serve, not be silently treated as "run a cold index over it",
  // so that throw is left to propagate to the caller.
  if (!existsSync(dbPath)) return false

  const store = GraphStore.open(dbPath)
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
    // Read back from the `files` table rather than tallied only over this
    // run's re-parsed subset (`toParse`/`reparsedFiles`): a SUM over the
    // whole table reflects the WHOLE repository's index, including files a
    // previous run indexed with errors that this run's dilation never
    // touched. Spec §9 requires parse errors be reported in aggregate; a
    // per-run tally would silently under-report whenever the erroring file
    // itself was untouched by the current incremental pass.
    parseErrors: store.totalParseErrors(),
    durationMs: Date.now() - startedAt,
    changedFiles: changes.changed.length,
    deletedFiles: changes.deleted.length,
    reparsedFiles,
    fellBackToCold,
  }
}
