import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Confidence, EdgeKind, ParsedFile } from '../types.js'

export const SCHEMA_VERSION = 1

const here = dirname(fileURLToPath(import.meta.url))

export interface FileRow {
  id: number
  path: string
  lang: string | null
  contentHash: string
  loc: number
  errorCount: number
}

export interface SymbolRow {
  id: number
  fileId: number
  name: string
  kind: string
  startLine: number
  endLine: number
  exported: boolean
}

export interface EdgeInput {
  srcFileId: number
  srcSymbolId: number | null
  dstFileId: number | null
  dstSymbolId: number | null
  dstName: string
  kind: EdgeKind
  confidence: Confidence
  line: number
}

export interface ImportInput {
  fileId: number
  rawSpecifier: string
  resolvedFileId: number | null
  kind: string
  confidence: Confidence
  line: number
}

const EDGE_SELECT =
  'SELECT src_file_id, src_symbol_id, dst_file_id, dst_symbol_id, dst_name, kind, confidence, line FROM edges'

export interface EdgeRow {
  srcFileId: number
  srcSymbolId: number | null
  dstFileId: number | null
  dstSymbolId: number | null
  dstName: string
  kind: EdgeKind
  confidence: Confidence
  line: number
}

export interface EdgeDetail {
  srcPath: string
  srcSymbolName: string | null
  dstPath: string | null
  dstSymbolName: string | null
  dstName: string
  kind: EdgeKind
  confidence: Confidence
  line: number
}

export interface SymbolHit {
  id: number
  fileId: number
  path: string
  name: string
  kind: string
  startLine: number
  endLine: number
  exported: boolean
  signature: string | null
  parentName: string | null
}

export interface FindSymbolsOptions {
  name?: string
  contains?: string
  kind?: string
  exported?: boolean
  pathPrefix?: string
  limit: number
}

const SYMBOL_SELECT = `
  SELECT s.id, s.file_id, f.path, s.name, s.kind, s.start_line, s.end_line,
         s.exported, s.signature, s.parent_name
  FROM symbols s JOIN files f ON f.id = s.file_id`

function toSymbolHit(r: Record<string, unknown>): SymbolHit {
  return {
    id: r.id as number,
    fileId: r.file_id as number,
    path: r.path as string,
    name: r.name as string,
    kind: r.kind as string,
    startLine: r.start_line as number,
    endLine: r.end_line as number,
    exported: Boolean(r.exported),
    signature: (r.signature as string | null) ?? null,
    parentName: (r.parent_name as string | null) ?? null,
  }
}

/** The only module in the project that touches SQLite. */
export class GraphStore {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath: string): GraphStore {
    const db = new Database(dbPath)
    db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))

    const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string } | undefined
    if (existing && Number(existing.value) !== SCHEMA_VERSION) {
      db.close()
      throw new Error(
        `Index schema version ${existing.value} does not match ${SCHEMA_VERSION}. Run "arch index --force" to rebuild.`,
      )
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION))

    return new GraphStore(db)
  }

  insertParsedFiles(files: ParsedFile[]): void {
    const deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?')
    const insertFile = this.db.prepare(`
      INSERT INTO files (path, lang, content_hash, loc, error_count, indexed_at)
      VALUES (@path, @lang, @contentHash, @loc, @errorCount, @indexedAt)
    `)
    const insertSymbol = this.db.prepare(`
      INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported, signature, parent_name)
      VALUES (@fileId, @name, @kind, @startLine, @endLine, @exported, @signature, @parentName)
    `)

    const run = this.db.transaction((batch: ParsedFile[]) => {
      const now = Date.now()
      for (const file of batch) {
        deleteFile.run(file.path)
        const { lastInsertRowid } = insertFile.run({
          path: file.path,
          lang: file.lang,
          contentHash: file.contentHash,
          loc: 0,
          errorCount: file.errors.length,
          indexedAt: now,
        })
        const fileId = Number(lastInsertRowid)
        for (const symbol of file.symbols) {
          insertSymbol.run({
            fileId,
            name: symbol.name,
            kind: symbol.kind,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            exported: symbol.exported ? 1 : 0,
            signature: symbol.signature,
            parentName: symbol.parentName,
          })
        }
      }
    })
    run(files)
  }

  insertImports(imports: ImportInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO imports (file_id, raw_specifier, resolved_file_id, kind, confidence, line)
      VALUES (@fileId, @rawSpecifier, @resolvedFileId, @kind, @confidence, @line)
    `)
    this.db.transaction((rows: ImportInput[]) => { for (const r of rows) stmt.run(r) })(imports)
  }

  insertEdges(edges: EdgeInput[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO edges (src_file_id, src_symbol_id, dst_file_id, dst_symbol_id, dst_name, kind, confidence, line)
      VALUES (@srcFileId, @srcSymbolId, @dstFileId, @dstSymbolId, @dstName, @kind, @confidence, @line)
    `)
    this.db.transaction((rows: EdgeInput[]) => { for (const r of rows) stmt.run(r) })(edges)
  }

  fileIdByPath(path: string): number | undefined {
    const row = this.db.prepare('SELECT id FROM files WHERE path = ?').get(path) as { id: number } | undefined
    return row?.id
  }

  fileRow(path: string): FileRow | undefined {
    const row = this.db.prepare(
      'SELECT id, path, lang, content_hash, loc, error_count FROM files WHERE path = ?',
    ).get(path) as Record<string, unknown> | undefined
    return row ? toFileRow(row) : undefined
  }

  allFilePaths(): string[] {
    return (this.db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[])
      .map(r => r.path)
  }

  symbolsByName(): Map<string, SymbolRow[]> {
    const grouped = new Map<string, SymbolRow[]>()
    for (const row of this.allSymbolRows()) {
      const bucket = grouped.get(row.name)
      if (bucket) bucket.push(row)
      else grouped.set(row.name, [row])
    }
    return grouped
  }

  exportedSymbolsByFile(): Map<number, SymbolRow[]> {
    const grouped = new Map<number, SymbolRow[]>()
    for (const row of this.allSymbolRows()) {
      if (!row.exported) continue
      const bucket = grouped.get(row.fileId)
      if (bucket) bucket.push(row)
      else grouped.set(row.fileId, [row])
    }
    return grouped
  }

  symbolsByFile(): Map<number, SymbolRow[]> {
    const grouped = new Map<number, SymbolRow[]>()
    for (const row of this.allSymbolRows()) {
      const bucket = grouped.get(row.fileId)
      if (bucket) bucket.push(row)
      else grouped.set(row.fileId, [row])
    }
    return grouped
  }

  edgeCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string } | undefined
    return row?.value
  }

  analyze(): void {
    this.db.exec('ANALYZE')
  }

  close(): void {
    this.db.close()
  }

  importsForFile(fileId: number): Array<{ rawSpecifier: string; resolvedFileId: number | null; confidence: string }> {
    const rows = this.db.prepare(
      'SELECT raw_specifier, resolved_file_id, confidence FROM imports WHERE file_id = ?',
    ).all(fileId) as Record<string, unknown>[]
    return rows.map(r => ({
      rawSpecifier: r.raw_specifier as string,
      resolvedFileId: (r.resolved_file_id as number | null) ?? null,
      confidence: r.confidence as string,
    }))
  }

  edgesInto(fileId: number): EdgeRow[] {
    return this.toEdgeRows(this.db.prepare(EDGE_SELECT + ' WHERE dst_file_id = ?').all(fileId))
  }

  allEdges(): EdgeRow[] {
    return this.toEdgeRows(this.db.prepare(EDGE_SELECT).all())
  }

  contentHashByPath(): Map<string, string> {
    const rows = this.db.prepare('SELECT path, content_hash FROM files').all() as
      Array<{ path: string; content_hash: string }>
    return new Map(rows.map(r => [r.path, r.content_hash]))
  }

  fileIdsByPath(): Map<string, number> {
    const rows = this.db.prepare('SELECT id, path FROM files').all() as
      Array<{ id: number; path: string }>
    return new Map(rows.map(r => [r.path, r.id]))
  }

  pathsById(): Map<number, string> {
    const rows = this.db.prepare('SELECT id, path FROM files').all() as
      Array<{ id: number; path: string }>
    return new Map(rows.map(r => [r.id, r.path]))
  }

  /** Files whose RESOLVED imports point at this file. Unresolved imports never widen it. */
  filesImporting(fileId: number): number[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT file_id FROM imports WHERE resolved_file_id = ? ORDER BY file_id',
    ).all(fileId) as Array<{ file_id: number }>
    return rows.map(r => r.file_id)
  }

  /**
   * Removes files by path. `symbols`, `imports` and outgoing `edges` cascade
   * away; edges pointing AT the removed file survive with null dst columns
   * (ON DELETE SET NULL), which is what keeps a reference visible after its
   * target disappears rather than silently dropping it.
   */
  deleteFilesByPath(paths: string[]): void {
    const stmt = this.db.prepare('DELETE FROM files WHERE path = ?')
    this.db.transaction((batch: string[]) => { for (const p of batch) stmt.run(p) })(paths)
  }

  /** Removes a file's import rows without touching the file or its symbols. */
  deleteImportsForFile(fileId: number): void {
    this.db.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId)
  }

  /**
   * Removes edges ORIGINATING in a file, leaving edges that point at it alone.
   * Used when a file's outgoing edges must be recomputed but its nodes are
   * unchanged — re-inserting the nodes instead would null out every inbound
   * edge from elsewhere via ON DELETE SET NULL.
   */
  deleteEdgesFromFile(fileId: number): void {
    this.db.prepare('DELETE FROM edges WHERE src_file_id = ?').run(fileId)
  }

  allEdgeDetails(): EdgeDetail[] {
    const rows = this.db.prepare(`
      SELECT sf.path AS src_path, ss.name AS src_symbol_name,
             df.path AS dst_path, ds.name AS dst_symbol_name,
             e.dst_name, e.kind, e.confidence, e.line
      FROM edges e
      JOIN files sf ON sf.id = e.src_file_id
      LEFT JOIN symbols ss ON ss.id = e.src_symbol_id
      LEFT JOIN files df ON df.id = e.dst_file_id
      LEFT JOIN symbols ds ON ds.id = e.dst_symbol_id
    `).all() as Record<string, unknown>[]
    return rows.map(r => ({
      srcPath: r.src_path as string,
      srcSymbolName: (r.src_symbol_name as string | null) ?? null,
      dstPath: (r.dst_path as string | null) ?? null,
      dstSymbolName: (r.dst_symbol_name as string | null) ?? null,
      dstName: r.dst_name as string,
      kind: r.kind as EdgeKind,
      confidence: r.confidence as Confidence,
      line: r.line as number,
    }))
  }

  clear(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;')
  }

  confidenceBreakdown(): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT confidence, COUNT(*) AS n FROM edges GROUP BY confidence',
    ).all() as Array<{ confidence: string; n: number }>
    // Seed every tier so a zero is reported as 0 rather than going missing.
    const out: Record<string, number> = {
      exact: 0, resolved: 0, heuristic: 0, unresolved: 0, ambiguous: 0,
    }
    for (const r of rows) out[r.confidence] = r.n
    return out
  }

  languageBreakdown(): Array<{ lang: string | null; files: number; symbols: number }> {
    const rows = this.db.prepare(`
      SELECT f.lang AS lang, COUNT(DISTINCT f.id) AS files, COUNT(s.id) AS symbols
      FROM files f LEFT JOIN symbols s ON s.file_id = f.id
      GROUP BY f.lang ORDER BY files DESC
    `).all() as Array<{ lang: string | null; files: number; symbols: number }>
    return rows.map(r => ({ lang: r.lang ?? null, files: r.files, symbols: r.symbols }))
  }

  totals(): { files: number; symbols: number; edges: number; imports: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n
    return {
      files: one('SELECT COUNT(*) AS n FROM files'),
      symbols: one('SELECT COUNT(*) AS n FROM symbols'),
      edges: one('SELECT COUNT(*) AS n FROM edges'),
      imports: one('SELECT COUNT(*) AS n FROM imports'),
    }
  }

  symbolById(id: number): SymbolHit | undefined {
    const row = this.db.prepare(`${SYMBOL_SELECT} WHERE s.id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? toSymbolHit(row) : undefined
  }

  findSymbols(options: FindSymbolsOptions): SymbolHit[] {
    const where: string[] = []
    const params: unknown[] = []
    if (options.name !== undefined) { where.push('s.name = ?'); params.push(options.name) }
    if (options.contains !== undefined) { where.push('s.name LIKE ?'); params.push(`%${options.contains}%`) }
    if (options.kind !== undefined) { where.push('s.kind = ?'); params.push(options.kind) }
    if (options.exported !== undefined) { where.push('s.exported = ?'); params.push(options.exported ? 1 : 0) }
    if (options.pathPrefix !== undefined) { where.push('f.path LIKE ?'); params.push(`${options.pathPrefix}%`) }

    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    const rows = this.db.prepare(
      `${SYMBOL_SELECT}${clause} ORDER BY LENGTH(s.name), s.name, f.path LIMIT ?`,
    ).all(...params, options.limit) as Record<string, unknown>[]
    return rows.map(toSymbolHit)
  }

  edgesToSymbol(symbolId: number): EdgeRow[] {
    return this.toEdgeRows(this.db.prepare(EDGE_SELECT + ' WHERE dst_symbol_id = ?').all(symbolId))
  }

  private toEdgeRows(rows: unknown[]): EdgeRow[] {
    return (rows as Record<string, unknown>[]).map(r => ({
      srcFileId: r.src_file_id as number,
      srcSymbolId: (r.src_symbol_id as number | null) ?? null,
      dstFileId: (r.dst_file_id as number | null) ?? null,
      dstSymbolId: (r.dst_symbol_id as number | null) ?? null,
      dstName: r.dst_name as string,
      kind: r.kind as EdgeKind,
      confidence: r.confidence as Confidence,
      line: r.line as number,
    }))
  }

  private allSymbolRows(): SymbolRow[] {
    const rows = this.db.prepare(
      'SELECT id, file_id, name, kind, start_line, end_line, exported FROM symbols',
    ).all() as Record<string, unknown>[]
    return rows.map(r => ({
      id: r.id as number,
      fileId: r.file_id as number,
      name: r.name as string,
      kind: r.kind as string,
      startLine: r.start_line as number,
      endLine: r.end_line as number,
      exported: Boolean(r.exported),
    }))
  }
}

function toFileRow(r: Record<string, unknown>): FileRow {
  return {
    id: r.id as number,
    path: r.path as string,
    lang: (r.lang as string | null) ?? null,
    contentHash: r.content_hash as string,
    loc: r.loc as number,
    errorCount: r.error_count as number,
  }
}
