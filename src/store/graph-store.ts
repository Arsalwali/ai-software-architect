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

  clear(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM imports; DELETE FROM symbols; DELETE FROM files;')
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
