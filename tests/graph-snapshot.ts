import type { GraphStore } from '../src/store/graph-store.js'

/**
 * An ID-free, order-free projection of a graph, for asserting that two
 * differently-built indexes are the same graph.
 *
 * Row ids cannot be compared directly: a full index assigns them in
 * discovery order while an incremental one reuses existing ids and appends,
 * so the same graph legitimately has different ids. Everything here is
 * expressed as paths and names instead, then sorted.
 *
 * Known narrowing: symbol `signature` and `parentName` are omitted because
 * `SymbolRow` does not carry them, and import `line`/`kind` are omitted for
 * the same reason. All four are pure functions of the same parse of the same
 * bytes, so a divergence in them implies a divergence in something this
 * projection does cover.
 */
export function canonicalGraph(store: GraphStore): string {
  const lines: string[] = []
  const pathsById = store.pathsById()

  for (const path of store.allFilePaths()) {
    const row = store.fileRow(path)!
    lines.push(`F|${row.path}|${row.lang ?? ''}|${row.contentHash}|${row.errorCount}`)
  }

  for (const [fileId, symbols] of store.symbolsByFile()) {
    const path = pathsById.get(fileId) ?? '?'
    for (const s of symbols) {
      lines.push(`S|${path}|${s.name}|${s.kind}|${s.startLine}|${s.endLine}|${s.exported}`)
    }
  }

  for (const [path, fileId] of store.fileIdsByPath()) {
    for (const imp of store.importsForFile(fileId)) {
      const target = imp.resolvedFileId === null ? '' : pathsById.get(imp.resolvedFileId) ?? '?'
      lines.push(`I|${path}|${imp.rawSpecifier}|${target}|${imp.confidence}`)
    }
  }

  for (const e of store.allEdgeDetails()) {
    lines.push(
      `E|${e.srcPath}|${e.srcSymbolName ?? ''}|${e.dstPath ?? ''}|` +
      `${e.dstSymbolName ?? ''}|${e.dstName}|${e.kind}|${e.confidence}|${e.line}`,
    )
  }

  return lines.sort().join('\n')
}
