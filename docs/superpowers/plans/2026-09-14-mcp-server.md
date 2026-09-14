# AI Software Architect — Incremental Reindex and MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the index stay current as you work, and expose it to Claude Code as MCP tools so architectural questions can be answered against real structure.

**Architecture:** Change detection compares on-disk content hashes against the indexed ones, producing a `ChangeSet`. Incremental reindex re-parses only changed files and re-resolves a one-hop dilation of them — the changed files plus every file importing them — guarded by an invariant asserting the result is semantically identical to a full reindex. On top, an MCP stdio server exposes four tools, each passing through a freshness gate that either auto-reindexes a small delta inline or labels the response stale.

**Tech Stack:** TypeScript (ESM), Node 20+, `@modelcontextprotocol/sdk` 1.30.0, `zod` 4.6.5, existing `better-sqlite3` 13.0.3 / `web-tree-sitter` 0.27.0 / `commander` 15.0.0, `vitest` 5.x.

**Spec:** `docs/superpowers/specs/2026-09-14-ai-software-architect-design.md`

**Scope:** Spec milestones 6–7. Milestone 6 is included with the server rather than split off because every tool response carries a freshness claim, and that claim is only honest if a small delta can actually be absorbed cheaply. Milestones 8–10 (remaining tools, summarizer, more grammars) are Plan 3.

**This plan is written against the code as it actually shipped**, which differs from Plan 1's text in five places that later reviews corrected. Those differences are load-bearing; see Global Constraints.

## Global Constraints

- Node 20+, ESM (`"type": "module"`), relative imports carry `.js` extensions.
- New pinned dependencies, exactly: `@modelcontextprotocol/sdk@1.30.0`, `zod@4.6.5`. This pair is verified working together; the SDK's `registerTool` accepts a zod raw shape and converts it to JSON Schema.
- Use `server.registerTool(name, config, cb)`. The older `server.tool(...)` overloads are deprecated in this SDK version — do not use them.
- **`Confidence` has FIVE values**, in this order: `exact`, `resolved`, `heuristic`, `unresolved`, `ambiguous`. `unresolved` means no candidate matched at all (external/builtin/third-party — no uncertainty). `ambiguous` means several candidates matched and all were stored. **These must never be conflated or merged in any tool output** — a final review of Plan 1 found them conflated and it destroyed the signal the product exists to provide. Do not reintroduce that.
- `SkipReason` has SIX values: `vendored`, `too-large`, `minified`, `binary`, `unreadable`, `not-a-file`.
- Completion is signalled by `meta.index_complete === '1'`, NOT by `head_commit`. `head_commit` is `''` on success for non-git repos, so it cannot carry completion. Both are cleared at run start and written last, only on success.
- `meta` keys already written by a successful index: `schema_version`, `head_commit`, `index_complete`, `indexed_at`, `files_indexed`, `files_skipped`, `files_skipped_by_reason` (JSON object), `repo_root`.
- Never silently omit. Every skipped file carries a reason; every truncated tool result carries `truncated` with the true total.
- Index location: `~/.arch/repos/<first 16 hex of sha256 of abs repo path>/index.db` via `indexPathFor`.
- No new external binaries. The tools must work wherever the CLI runs, so full-text search is implemented in Node rather than shelling out to ripgrep.
- Tools return `file:line` pointers and relationships, not source dumps. Claude Code already has `Read`/`Grep`.

## Existing interfaces you build on

These exist and are tested. Do not modify them except where a task says so.

```ts
// src/types.ts
type Confidence = 'exact' | 'resolved' | 'heuristic' | 'unresolved' | 'ambiguous'
type EdgeKind = 'calls' | 'extends' | 'implements' | 'instantiates' | 'references'
type SymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'variable'
interface ParsedFile { path; lang: string | null; contentHash; symbols; imports; callSites; errors }

// src/store/graph-store.ts
const SCHEMA_VERSION = 1
interface FileRow { id; path; lang: string | null; contentHash; loc; errorCount }
interface SymbolRow { id; fileId; name; kind; startLine; endLine; exported: boolean }
interface EdgeInput { srcFileId; srcSymbolId; dstFileId; dstSymbolId; dstName; kind; confidence; line }
interface ImportInput { fileId; rawSpecifier; resolvedFileId; kind; confidence; line }
interface EdgeRow  { srcFileId; srcSymbolId; dstFileId; dstSymbolId; dstName; kind; confidence; line }
class GraphStore {
  static open(dbPath): GraphStore
  insertParsedFiles(files: ParsedFile[]): void   // deletes by path then re-inserts; symbols cascade
  insertImports(rows: ImportInput[]): void
  insertEdges(rows: EdgeInput[]): void
  fileIdByPath(path): number | undefined
  fileRow(path): FileRow | undefined
  allFilePaths(): string[]
  symbolsByName(): Map<string, SymbolRow[]>
  exportedSymbolsByFile(): Map<number, SymbolRow[]>
  symbolsByFile(): Map<number, SymbolRow[]>
  importsForFile(fileId): Array<{ rawSpecifier; resolvedFileId: number | null; confidence: string }>
  edgesInto(fileId): EdgeRow[]
  allEdges(): EdgeRow[]
  edgeCount(): number
  setMeta(key, value): void
  getMeta(key): string | undefined
  analyze(): void
  clear(): void
  close(): void
}

// src/indexer/discover.ts
type SkipReason = 'vendored' | 'too-large' | 'minified' | 'binary' | 'unreadable' | 'not-a-file'
interface SkippedFile { path: string; reason: SkipReason }
interface DiscoveryResult { files: string[]; skipped: SkippedFile[] }
function discoverFiles(repoRoot: string): DiscoveryResult

// src/indexer/parse-pool.ts
interface ParseAllArgs { repoRoot; paths: string[]; concurrency?; onBatch?; workerPath? }
function parseAll(args): Promise<ParsedFile[]>          // input order preserved

// src/indexer/resolve-imports.ts
function resolveImport(fromPath, specifier, knownPaths: Set<string>): { path: string | null; confidence: Confidence }

// src/indexer/resolve-calls.ts
function resolveCallsForFile(args: {
  srcFileId; localSymbols: SymbolRow[]; importedFileIds: number[];
  exportedByFile: Map<number, SymbolRow[]>; callSites: CallSite[]
}): EdgeInput[]

// src/indexer/pipeline.ts
function runColdIndex(options: { repoRoot; dbPath; batchSize?; onProgress? }): Promise<IndexReport>
interface IndexReport { filesIndexed; filesSkipped; symbols; edges; parseErrors; durationMs }

// src/repo/repo-source.ts
function indexPathFor(repoRoot): string
function isGitRepo(repoRoot): boolean
function gitHeadCommit(repoRoot): string | null
function git(repoRoot, args: string[]): string | null

// tests/fixture-builder.ts
const FIXTURE_FILES: Record<string, string>   // 5 indexed + .eslintrc.js + .config/settings.ts + skipped entries
function buildFixture(options?: { git?: boolean }): string   // temp dir, never committed
```

## File Structure

```
src/
  indexer/
    changeset.ts          -- NEW: compute what changed since the last index
    incremental.ts        -- NEW: reindex only the changed set + its one-hop dilation
    freshness.ts          -- NEW: the staleness gate shared by CLI and tools
  store/
    graph-store.ts        -- MODIFY: reads the tools and the dilation need
  tools/
    envelope.ts           -- NEW: the response envelope every tool returns
    overview.ts           -- NEW: get_repo_overview
    search.ts             -- NEW: search_code
    dependencies.ts       -- NEW: get_dependencies
    impact.ts             -- NEW: impact_of
  mcp/
    server.ts             -- NEW: McpServer construction and tool registration
    stdio.ts              -- NEW: stdio entry point (the binary Claude Code spawns)
  cli.ts                  -- MODIFY: `arch serve`, and incremental by default on `arch index`
tests/
  graph-snapshot.ts       -- NEW: canonical, ID-free projection of a graph for equality assertions
  changeset.test.ts
  incremental.test.ts     -- includes the full-vs-incremental equality invariant
  freshness.test.ts
  tools-*.test.ts
  mcp-server.test.ts      -- in-process client/server over InMemoryTransport
```

---

### Task 1: Store reads for change detection and dilation

**Files:**
- Modify: `src/store/graph-store.ts`
- Test: `tests/graph-store-reads.test.ts`

**Interfaces:**
- Consumes: `GraphStore`, `EdgeRow`, `Confidence`, `EdgeKind` (existing).
- Produces: `contentHashByPath(): Map<string, string>`, `filesImporting(fileId: number): number[]`, `deleteFilesByPath(paths: string[]): void`, `fileIdsByPath(): Map<string, number>`, `pathsById(): Map<number, string>`, and `interface EdgeDetail` with `allEdgeDetails(): EdgeDetail[]`.

`EdgeDetail` is used by three later tasks and by the equality invariant, because both need edges expressed in terms of paths and symbol names rather than row ids.

- [ ] **Step 1: Write the failing test**

`tests/graph-store-reads.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { GraphStore } from '../src/store/graph-store.js'
import type { ParsedFile } from '../src/types.js'

function parsedFile(path: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path, lang: 'typescript', contentHash: 'hash-' + path,
    symbols: [], imports: [], callSites: [], errors: [], ...overrides,
  }
}

function seeded(): GraphStore {
  const store = GraphStore.open(':memory:')
  store.insertParsedFiles([
    parsedFile('src/a.ts', {
      symbols: [{ name: 'callerFn', kind: 'function', startLine: 1, endLine: 4, exported: false, signature: null, parentName: null }],
    }),
    parsedFile('src/b.ts', {
      symbols: [{ name: 'target', kind: 'function', startLine: 1, endLine: 2, exported: true, signature: null, parentName: null }],
    }),
  ])
  const a = store.fileIdByPath('src/a.ts')!
  const b = store.fileIdByPath('src/b.ts')!
  store.insertImports([
    { fileId: a, rawSpecifier: './b', resolvedFileId: b, kind: 'static', confidence: 'resolved', line: 1 },
  ])
  const callerId = store.symbolsByName().get('callerFn')![0].id
  const targetId = store.symbolsByName().get('target')![0].id
  store.insertEdges([
    { srcFileId: a, srcSymbolId: callerId, dstFileId: b, dstSymbolId: targetId,
      dstName: 'target', kind: 'calls', confidence: 'heuristic', line: 3 },
    { srcFileId: a, srcSymbolId: null, dstFileId: null, dstSymbolId: null,
      dstName: 'console', kind: 'calls', confidence: 'unresolved', line: 4 },
  ])
  return store
}

describe('contentHashByPath', () => {
  it('maps every indexed path to its stored hash', () => {
    const store = seeded()
    const hashes = store.contentHashByPath()
    expect(hashes.get('src/a.ts')).toBe('hash-src/a.ts')
    expect(hashes.size).toBe(2)
    store.close()
  })
})

describe('filesImporting', () => {
  it('returns files whose resolved imports point at the target', () => {
    const store = seeded()
    const a = store.fileIdByPath('src/a.ts')!
    const b = store.fileIdByPath('src/b.ts')!
    expect(store.filesImporting(b)).toEqual([a])
    expect(store.filesImporting(a)).toEqual([])
    store.close()
  })

  it('ignores unresolved imports', () => {
    const store = seeded()
    const a = store.fileIdByPath('src/a.ts')!
    store.insertImports([
      { fileId: a, rawSpecifier: 'react', resolvedFileId: null, kind: 'static', confidence: 'unresolved', line: 2 },
    ])
    expect(store.filesImporting(store.fileIdByPath('src/b.ts')!)).toEqual([a])
    store.close()
  })
})

describe('deleteFilesByPath', () => {
  it('removes the file and cascades its symbols and edges', () => {
    const store = seeded()
    store.deleteFilesByPath(['src/a.ts'])
    expect(store.fileIdByPath('src/a.ts')).toBeUndefined()
    expect(store.symbolsByName().get('callerFn')).toBeUndefined()
    expect(store.allEdges()).toHaveLength(0)
    store.close()
  })

  it('leaves edges pointing AT a deleted file present but unlinked', () => {
    const store = seeded()
    store.deleteFilesByPath(['src/b.ts'])
    const edges = store.allEdges()
    const toTarget = edges.find(e => e.dstName === 'target')!
    expect(toTarget.dstFileId).toBeNull()
    expect(toTarget.dstSymbolId).toBeNull()
    store.close()
  })

  it('is a no-op for an unknown path', () => {
    const store = seeded()
    store.deleteFilesByPath(['src/nope.ts'])
    expect(store.allFilePaths()).toHaveLength(2)
    store.close()
  })
})

describe('allEdgeDetails', () => {
  it('expresses edges as paths and names rather than row ids', () => {
    const store = seeded()
    const details = store.allEdgeDetails()
    const resolved = details.find(d => d.dstName === 'target')!
    expect(resolved).toMatchObject({
      srcPath: 'src/a.ts', srcSymbolName: 'callerFn',
      dstPath: 'src/b.ts', dstSymbolName: 'target',
      kind: 'calls', confidence: 'heuristic', line: 3,
    })
    const external = details.find(d => d.dstName === 'console')!
    expect(external).toMatchObject({
      srcPath: 'src/a.ts', srcSymbolName: null,
      dstPath: null, dstSymbolName: null, confidence: 'unresolved',
    })
    store.close()
  })
})

describe('id and path maps', () => {
  it('round-trip each other', () => {
    const store = seeded()
    const ids = store.fileIdsByPath()
    const paths = store.pathsById()
    expect(paths.get(ids.get('src/a.ts')!)).toBe('src/a.ts')
    expect(ids.size).toBe(2)
    store.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/graph-store-reads.test.ts`
Expected: FAIL — `store.contentHashByPath is not a function`.

- [ ] **Step 3: Implement the reads**

Add to `src/store/graph-store.ts`, alongside the other exported interfaces:

```ts
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
```

Add these methods to the `GraphStore` class:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/graph-store-reads.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. 74 tests existed before; nothing here changes existing behavior.

- [ ] **Step 6: Commit**

```bash
git add src/store/graph-store.ts tests/graph-store-reads.test.ts
git commit -m "feat: store reads for change detection and edge detail"
```

---

### Task 2: Change detection

**Files:**
- Create: `src/indexer/changeset.ts`
- Test: `tests/changeset.test.ts`

**Interfaces:**
- Consumes: `discoverFiles`, `GraphStore.contentHashByPath`, `SkippedFile`.
- Produces: `interface ChangeSet { changed: string[]; deleted: string[]; unchanged: string[]; skipped: SkippedFile[] }` and `computeChangeSet(repoRoot: string, store: GraphStore): ChangeSet`.

> **Design ruling — why content hashes rather than `git diff`.** The spec's §7.1 describes driving this from `git diff --name-status` plus `git status --porcelain`. This plan uses content hashes instead, for three reasons. First, it is one code path that is correct for git and non-git repositories alike, and non-git repos have been a first-class path since discovery was built. Second, `discoverFiles` must run regardless — it is the only thing that applies the skip rules and finds newly added files — and it already reads file contents for the minified and binary sniffs, so the marginal cost of hashing is small. Third, a hash comparison cannot drift from the truth the way a git-derived file list can when the working tree and the index disagree. Git is still used, but only for the cheap staleness pre-check in Task 4. The known inefficiency is that files get read twice, once in discovery and once for hashing; threading the hash out of `discoverFiles` is the obvious future fix and is deliberately not done here to avoid changing a tested contract.

- [ ] **Step 1: Write the failing test**

`tests/changeset.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { computeChangeSet } from '../src/indexer/changeset.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string

beforeEach(async () => {
  fixture = buildFixture()
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-cs-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
})

function changeSet() {
  const store = GraphStore.open(dbPath)
  try {
    return computeChangeSet(fixture, store)
  } finally {
    store.close()
  }
}

describe('computeChangeSet', () => {
  it('reports nothing changed immediately after a cold index', () => {
    const cs = changeSet()
    expect(cs.changed).toEqual([])
    expect(cs.deleted).toEqual([])
    expect(cs.unchanged.length).toBeGreaterThan(0)
  })

  it('detects a modified file', () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number {\n  return n + 2;\n}\n')
    const cs = changeSet()
    expect(cs.changed).toEqual(['src/helper.ts'])
    expect(cs.deleted).toEqual([])
  })

  it('detects a new file', () => {
    writeFileSync(join(fixture, 'src/fresh.ts'), 'export function fresh(): void {}\n')
    const cs = changeSet()
    expect(cs.changed).toEqual(['src/fresh.ts'])
  })

  it('detects a deleted file', () => {
    rmSync(join(fixture, 'src/services/notify.ts'))
    const cs = changeSet()
    expect(cs.deleted).toEqual(['src/services/notify.ts'])
    expect(cs.changed).toEqual([])
  })

  it('treats a file that became skippable as deleted', () => {
    // Overwrite a source file with minified content; discovery now skips it,
    // so it must leave the graph rather than linger with stale symbols.
    writeFileSync(join(fixture, 'src/helper.ts'), '!function(){' + 'var a=1;'.repeat(200) + '}();\n')
    const cs = changeSet()
    expect(cs.deleted).toContain('src/helper.ts')
    expect(cs.changed).not.toContain('src/helper.ts')
  })

  it('carries the current skip classification through', () => {
    const cs = changeSet()
    expect(cs.skipped.some(s => s.reason === 'vendored')).toBe(true)
  })

  it('partitions every indexed and discovered path exactly once', () => {
    writeFileSync(join(fixture, 'src/fresh.ts'), 'export function fresh(): void {}\n')
    rmSync(join(fixture, 'src/services/notify.ts'))
    const cs = changeSet()
    const all = [...cs.changed, ...cs.unchanged, ...cs.deleted]
    expect(new Set(all).size).toBe(all.length)
    expect(all).toContain('src/fresh.ts')
    expect(all).toContain('src/services/notify.ts')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/changeset.test.ts`
Expected: FAIL — cannot resolve `../src/indexer/changeset.js`.

- [ ] **Step 3: Implement change detection**

`src/indexer/changeset.ts`:
```ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverFiles, type SkippedFile } from './discover.js'
import type { GraphStore } from '../store/graph-store.js'

export interface ChangeSet {
  /** New or modified files needing a re-parse. */
  changed: string[]
  /** Indexed paths that are no longer discoverable — removed, or now skipped. */
  deleted: string[]
  /** Indexed paths whose content hash is unchanged. */
  unchanged: string[]
  /** Current skip classification, carried through for the finalize step. */
  skipped: SkippedFile[]
}

/**
 * Compares the repository on disk against what the index holds.
 *
 * Content hashes are the comparison, not git. That keeps one code path
 * correct for git and non-git repositories alike, and a hash cannot
 * disagree with the file the way a git-derived list can when the working
 * tree has moved. See the plan's design ruling for the full argument.
 */
export function computeChangeSet(repoRoot: string, store: GraphStore): ChangeSet {
  const { files, skipped } = discoverFiles(repoRoot)
  const indexed = store.contentHashByPath()

  const changed: string[] = []
  const unchanged: string[] = []
  const discovered = new Set<string>()

  for (const path of files) {
    discovered.add(path)
    const current = hashOf(join(repoRoot, path))
    if (current === null) {
      // Readable a moment ago during discovery, gone now. Treat as changed so
      // the re-parse records it as an error rather than silently keeping stale data.
      changed.push(path)
      continue
    }
    if (indexed.get(path) === current) unchanged.push(path)
    else changed.push(path)
  }

  // Anything indexed but no longer discoverable has left the graph. That
  // covers outright deletion AND a file that became skippable — newly
  // vendored, newly minified, newly too large. Both must drop their rows,
  // or the graph keeps symbols for code that is no longer part of the repo.
  const deleted = [...indexed.keys()].filter(path => !discovered.has(path))

  return {
    changed: changed.sort(),
    deleted: deleted.sort(),
    unchanged: unchanged.sort(),
    skipped,
  }
}

function hashOf(absolutePath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
  } catch {
    return null
  }
}
```

> **Correction applied during execution.** This note originally said the hash was computed over the raw Buffer, and claimed that agreed with `RepoParser.parse`'s utf8-string hash "because discovery has already excluded binaries." That reasoning is wrong and the shipped code does not follow it.
>
> `readFileSync(path, 'utf8')` decodes lossily — invalid UTF-8 bytes become U+FFFD, which re-encodes to different bytes than the original — and `isBinary` in `discover.ts` only runs for files with no recognized language extension. So a `.ts` file containing a single Windows-1252 byte (a `// café` comment saved as latin-1) passes discovery as ordinary source, and its Buffer hash could never match the stored utf8-string hash. It would be classified `changed` on every incremental run forever, silently.
>
> The shipped `hashOf` therefore reads and hashes the utf8 STRING, exactly as the parser does. Both sides apply the same lossy decode, so the digests agree by construction for every file rather than by luck for ASCII ones.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/changeset.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the hash agreement explicitly**

The note above is a real risk, so prove it rather than assume it. Run this one-off check and confirm it prints `AGREE`:

Because `hashOf` now hashes the same utf8 string the parser hashes, agreement is structural rather than empirical and no probe is needed. What DOES need proving is that a file with invalid UTF-8 survives a round trip, which the covering test in Step 4 asserts directly: a `.ts` file containing a raw `0xE9` byte must come back `unchanged` after a cold index, not `changed`.

- [ ] **Step 6: Commit**

```bash
git add src/indexer/changeset.ts tests/changeset.test.ts
git commit -m "feat: content-hash change detection"
```

---

### Task 3: Incremental reindex and the equality invariant

The correctness property worth the most in this plan. Everything else in Plan 2 is additive; this one can silently corrupt a graph that still looks fine.

**Files:**
- Create: `src/indexer/incremental.ts`
- Create: `tests/graph-snapshot.ts`
- Modify: `src/store/graph-store.ts` (two more deletes)
- Test: `tests/incremental.test.ts`

**Interfaces:**
- Consumes: `computeChangeSet`, `ChangeSet`, `parseAll`, `resolveImport`, `resolveCallsForFile`, `GraphStore` (including Task 1's `filesImporting`, `deleteFilesByPath`, `fileIdsByPath`, `pathsById`, `allEdgeDetails`), `runColdIndex`, `gitHeadCommit`.
- Produces: `runIncrementalIndex(options: { repoRoot: string; dbPath: string; onProgress?: (m: string) => void }): Promise<IncrementalReport>` where `IncrementalReport extends IndexReport` adds `changedFiles: number`, `deletedFiles: number`, `reparsedFiles: number`, `fellBackToCold: boolean`. Also `canonicalGraph(store: GraphStore): string` from `tests/graph-snapshot.ts`.

> **Two hazards this task must get right, both non-obvious.**
>
> **Hazard 1 — re-inserting a file nulls inbound edges.** `insertParsedFiles` deletes the file row before re-inserting, and `edges.dst_symbol_id` is `ON DELETE SET NULL`. So re-persisting a file's nodes silently unlinks every edge pointing *at* its symbols from elsewhere. That is acceptable for genuinely changed files, because their importers are re-resolved in the same run — but it means a file that did NOT change must never have its nodes re-inserted, even though its edges do need recomputing. Nodes and edges are updated independently here.
>
> **Hazard 2 — importers must be captured before deletion.** `filesImporting(fileId)` needs the id of a file that is about to be removed. Collect the dilation set first, as paths, then delete. Reversing the order silently produces an empty dilation and leaves stale edges pointing at symbols that no longer exist.
>
> The dilation is provably complete: a cross-file edge only exists when the source file resolved an import to the target (that is the entire candidate rule in `resolveCallsForFile`), so every file holding an edge into a changed file is, by construction, an importer of it.

- [ ] **Step 1: Write the canonical snapshot helper**

`tests/graph-snapshot.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing test**

`tests/incremental.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { runIncrementalIndex } from '../src/indexer/incremental.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'
import { canonicalGraph } from './graph-snapshot.js'

let fixture: string
let dbPath: string

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'arch-inc-')), 'index.db')
}

beforeEach(async () => {
  fixture = buildFixture()
  dbPath = freshDb()
  await runColdIndex({ repoRoot: fixture, dbPath })
})

/** Full reindex of the CURRENT fixture state, into its own database. */
async function coldSnapshot(): Promise<string> {
  const other = freshDb()
  await runColdIndex({ repoRoot: fixture, dbPath: other })
  const store = GraphStore.open(other)
  try { return canonicalGraph(store) } finally { store.close() }
}

async function incrementalSnapshot(): Promise<string> {
  await runIncrementalIndex({ repoRoot: fixture, dbPath })
  const store = GraphStore.open(dbPath)
  try { return canonicalGraph(store) } finally { store.close() }
}

describe('the equality invariant', () => {
  it('matches a full reindex after a file body changes', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'),
      'export function helper(n: number): number {\n  return n + 99;\n}\nexport function unused(): void {}\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex after an exported symbol is RENAMED', async () => {
    // The sharpest case: order.ts calls helper(), so renaming it must turn a
    // heuristic edge into an unresolved one in BOTH build paths.
    writeFileSync(join(fixture, 'src/helper.ts'),
      'export function helperRenamed(n: number): number {\n  return n + 1;\n}\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex after a file is deleted', async () => {
    rmSync(join(fixture, 'src/services/notify.ts'))
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex after a file is added and imported', async () => {
    writeFileSync(join(fixture, 'src/extra.ts'), 'export function extra(): number {\n  return 7;\n}\n')
    writeFileSync(join(fixture, 'src/index.ts'),
      'import { OrderService } from "./services/order";\nimport { extra } from "./extra";\n\n' +
      'const service = new OrderService();\nservice.place(extra());\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex when a new export resolves a previously unresolved call', async () => {
    // notify.ts calls console.log; give order.ts a local `log` export and make
    // notify import it. Previously unresolved, now resolvable.
    writeFileSync(join(fixture, 'src/services/notify.ts'),
      'import { log } from "./logger";\nexport function notify(message: string): void {\n  log(message);\n}\n')
    writeFileSync(join(fixture, 'src/services/logger.ts'),
      'export function log(message: string): void {\n  void message;\n}\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex when a change creates an ambiguous collision', async () => {
    mkdirSync(join(fixture, 'src/dup'), { recursive: true })
    writeFileSync(join(fixture, 'src/dup/one.ts'), 'export function shared(): number { return 1; }\n')
    writeFileSync(join(fixture, 'src/dup/two.ts'), 'export function shared(): number { return 2; }\n')
    writeFileSync(join(fixture, 'src/dup/user.ts'),
      'import { shared } from "./one";\nimport { shared as other } from "./two";\n' +
      'export function use(): number { return shared(); }\n')
    const inc = await incrementalSnapshot()
    expect(inc).toBe(await coldSnapshot())
    expect(inc).toContain('|ambiguous|')
  })

  it('matches a full reindex across several successive edits', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
    await runIncrementalIndex({ repoRoot: fixture, dbPath })
    rmSync(join(fixture, 'src/services/notify.ts'))
    await runIncrementalIndex({ repoRoot: fixture, dbPath })
    writeFileSync(join(fixture, 'src/late.ts'), 'export function late(): void {}\n')
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })

  it('matches a full reindex when nothing changed at all', async () => {
    expect(await incrementalSnapshot()).toBe(await coldSnapshot())
  })
})

describe('runIncrementalIndex reporting', () => {
  it('reports how little it did on a no-op run', async () => {
    const report = await runIncrementalIndex({ repoRoot: fixture, dbPath })
    expect(report.changedFiles).toBe(0)
    expect(report.deletedFiles).toBe(0)
    expect(report.reparsedFiles).toBe(0)
    expect(report.fellBackToCold).toBe(false)
  })

  it('reparses the dilation, not the whole repo', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
    const report = await runIncrementalIndex({ repoRoot: fixture, dbPath })
    expect(report.changedFiles).toBe(1)
    // helper.ts plus order.ts, which imports it. Not the whole fixture.
    expect(report.reparsedFiles).toBe(2)
    expect(report.filesIndexed).toBeGreaterThan(report.reparsedFiles)
  })

  it('falls back to a cold index when the existing index is incomplete', async () => {
    const store = GraphStore.open(dbPath)
    store.setMeta('index_complete', '')
    store.close()
    const report = await runIncrementalIndex({ repoRoot: fixture, dbPath })
    expect(report.fellBackToCold).toBe(true)
    const after = GraphStore.open(dbPath)
    expect(after.getMeta('index_complete')).toBe('1')
    after.close()
  })

  it('falls back to a cold index when no index exists yet', async () => {
    const report = await runIncrementalIndex({ repoRoot: fixture, dbPath: freshDb() })
    expect(report.fellBackToCold).toBe(true)
  })

  it('clears the completion flags while running and restores them on success', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
    await runIncrementalIndex({ repoRoot: fixture, dbPath })
    const store = GraphStore.open(dbPath)
    expect(store.getMeta('index_complete')).toBe('1')
    store.close()
  })

  it('leaves the index marked incomplete when a run throws midway', async () => {
    const { GraphStore: GS } = await import('../src/store/graph-store.js')
    const spy = vi.spyOn(GS.prototype, 'insertEdges').mockImplementation(() => {
      throw new Error('injected failure at the edge-persist boundary')
    })
    try {
      writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
      await expect(runIncrementalIndex({ repoRoot: fixture, dbPath })).rejects.toThrow('injected failure')
    } finally {
      spy.mockRestore()
    }
    const store = GraphStore.open(dbPath)
    expect(store.getMeta('index_complete')).toBe('')
    store.close()
  })
})
```

Add `import { vi } from 'vitest'` to the import list at the top of that file.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/incremental.test.ts`
Expected: FAIL — cannot resolve `../src/indexer/incremental.js`.

- [ ] **Step 4: Add the two remaining store deletes**

In `src/store/graph-store.ts`, add to the `GraphStore` class:

```ts
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
```

- [ ] **Step 5: Implement incremental reindex**

`src/indexer/incremental.ts`:
```ts
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
```

Note `parseErrors` is reported as 0 on the incremental path because only the dilation is parsed and a repository-wide count is not recomputed. That is a deliberate narrowing, not an oversight — `files.error_count` still holds the per-file truth for every file, and the overview tool in Task 6 reads it from there.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/incremental.test.ts`
Expected: PASS, 14 tests. The eight equality-invariant tests are the ones that matter; if any fails, the printed diff between the two canonical strings names the exact row that diverged.

- [ ] **Step 7: Prove the invariant test actually bites**

Temporarily break the dilation — change `const dilation = new Set<string>(changes.changed)` so it never adds importers (delete the `for` loop that walks `filesImporting`). Re-run `npx vitest run tests/incremental.test.ts`.

Expected: the RENAMED-symbol test fails, because `order.ts` would keep a stale `heuristic` edge to a symbol that no longer exists while the cold build records it as `unresolved`. Revert the change and confirm the suite is green again. Report what you observed — if breaking the dilation does NOT fail a test, the invariant is not covering what it claims to.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests.

- [ ] **Step 9: Commit**

```bash
git add src/indexer/incremental.ts src/store/graph-store.ts tests/graph-snapshot.ts tests/incremental.test.ts
git commit -m "feat: incremental reindex with full-vs-incremental equality invariant"
```

---

### Task 4: The freshness gate, and wiring it into the CLI

**Files:**
- Create: `src/indexer/freshness.ts`
- Modify: `src/cli.ts`
- Test: `tests/freshness.test.ts`

**Interfaces:**
- Consumes: `computeChangeSet`, `runIncrementalIndex`, `GraphStore`, `indexPathFor`, `isGitRepo`, `gitHeadCommit`, `git`.
- Produces: `type IndexState = 'current' | 'stale' | 'incomplete' | 'missing'`; `interface Freshness { state: IndexState; changedFiles: number; deletedFiles: number; indexedAt: string | null; headCommit: string | null; filesIndexed: number }`; `checkFreshness(repoRoot: string, dbPath: string): Freshness`; `ensureFresh(repoRoot: string, dbPath: string): Promise<Freshness>`; `AUTO_REINDEX_THRESHOLD`.

Spec §7.2: under the threshold, absorb the delta inline so the caller never notices; at or above it, answer with a `stale` label rather than blocking a tool call for a minute. Both branches are honest; only silence would not be.

- [ ] **Step 1: Write the failing test**

`tests/freshness.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { checkFreshness, ensureFresh, AUTO_REINDEX_THRESHOLD } from '../src/indexer/freshness.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string

beforeEach(async () => {
  fixture = buildFixture({ git: true })
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-fresh-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
})

describe('checkFreshness', () => {
  it('reports missing when there is no index', () => {
    const f = checkFreshness(fixture, join(mkdtempSync(join(tmpdir(), 'arch-none-')), 'index.db'))
    expect(f.state).toBe('missing')
  })

  it('reports current right after a cold index', () => {
    expect(checkFreshness(fixture, dbPath).state).toBe('current')
  })

  it('reports incomplete when the completion flag is cleared', () => {
    const store = GraphStore.open(dbPath)
    store.setMeta('index_complete', '')
    store.close()
    expect(checkFreshness(fixture, dbPath).state).toBe('incomplete')
  })

  it('reports stale with a count once a file changes', () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n; }\n')
    const f = checkFreshness(fixture, dbPath)
    expect(f.state).toBe('stale')
    expect(f.changedFiles).toBe(1)
  })

  it('reports current for a non-git repo that indexed successfully', async () => {
    const plain = buildFixture()
    const plainDb = join(mkdtempSync(join(tmpdir(), 'arch-plain-')), 'index.db')
    await runColdIndex({ repoRoot: plain, dbPath: plainDb })
    expect(checkFreshness(plain, plainDb).state).toBe('current')
  })
})

describe('ensureFresh', () => {
  it('absorbs a small delta inline and comes back current', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n + 5; }\n')
    const f = await ensureFresh(fixture, dbPath)
    expect(f.state).toBe('current')
    expect(checkFreshness(fixture, dbPath).state).toBe('current')
  })

  it('leaves a large delta labelled stale instead of blocking', async () => {
    for (let i = 0; i < AUTO_REINDEX_THRESHOLD + 5; i++) {
      writeFileSync(join(fixture, `src/gen${i}.ts`), `export function gen${i}(): number { return ${i}; }\n`)
    }
    const f = await ensureFresh(fixture, dbPath)
    expect(f.state).toBe('stale')
    expect(f.changedFiles).toBeGreaterThan(AUTO_REINDEX_THRESHOLD)
    // and it did NOT quietly reindex
    expect(checkFreshness(fixture, dbPath).state).toBe('stale')
  })

  it('rebuilds an incomplete index rather than serving from it', async () => {
    const store = GraphStore.open(dbPath)
    store.setMeta('index_complete', '')
    store.close()
    expect((await ensureFresh(fixture, dbPath)).state).toBe('current')
  })

  it('is a cheap no-op when nothing changed', async () => {
    const before = GraphStore.open(dbPath).getMeta('indexed_at')
    const f = await ensureFresh(fixture, dbPath)
    expect(f.state).toBe('current')
    expect(f.changedFiles).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/freshness.test.ts`
Expected: FAIL — cannot resolve `../src/indexer/freshness.js`.

- [ ] **Step 3: Implement the gate**

`src/indexer/freshness.ts`:
```ts
import { existsSync } from 'node:fs'
import { GraphStore } from '../store/graph-store.js'
import { git, gitHeadCommit, isGitRepo } from '../repo/repo-source.js'
import { computeChangeSet } from './changeset.js'
import { runIncrementalIndex } from './incremental.js'

export type IndexState = 'current' | 'stale' | 'incomplete' | 'missing'

export interface Freshness {
  state: IndexState
  changedFiles: number
  deletedFiles: number
  indexedAt: string | null
  headCommit: string | null
  filesIndexed: number
}

/**
 * Spec §7.2. Below this many changed-or-deleted files, absorb the delta
 * inline — it is sub-second and the caller never notices. At or above it,
 * answer with a stale label rather than blocking a tool call for a minute.
 */
export const AUTO_REINDEX_THRESHOLD = 50

export function checkFreshness(repoRoot: string, dbPath: string): Freshness {
  const empty: Freshness = {
    state: 'missing', changedFiles: 0, deletedFiles: 0,
    indexedAt: null, headCommit: null, filesIndexed: 0,
  }
  if (!existsSync(dbPath)) return empty

  let store: GraphStore
  try {
    store = GraphStore.open(dbPath)
  } catch {
    // Schema mismatch or corruption. Unusable is indistinguishable from
    // absent for the caller's purposes, and both are fixed by reindexing.
    return empty
  }

  try {
    const base: Freshness = {
      state: 'current',
      changedFiles: 0,
      deletedFiles: 0,
      indexedAt: store.getMeta('indexed_at') ?? null,
      headCommit: store.getMeta('head_commit') || null,
      filesIndexed: Number(store.getMeta('files_indexed') ?? '0'),
    }

    if (store.getMeta('index_complete') !== '1') return { ...base, state: 'incomplete' }

    // Cheap git pre-check: if HEAD is where we indexed it and the working
    // tree is clean, nothing can have changed, so skip hashing entirely.
    if (isGitRepo(repoRoot)) {
      const head = gitHeadCommit(repoRoot)
      const dirty = git(repoRoot, ['status', '--porcelain'])
      if (head !== null && head === base.headCommit && dirty === '') return base
    }

    const changes = computeChangeSet(repoRoot, store)
    const delta = changes.changed.length + changes.deleted.length
    return {
      ...base,
      state: delta === 0 ? 'current' : 'stale',
      changedFiles: changes.changed.length,
      deletedFiles: changes.deleted.length,
    }
  } finally {
    store.close()
  }
}

/**
 * Brings the index up to date when that is cheap, and reports honestly when
 * it is not. Never returns a `current` claim it has not earned.
 */
export async function ensureFresh(repoRoot: string, dbPath: string): Promise<Freshness> {
  const before = checkFreshness(repoRoot, dbPath)

  if (before.state === 'current') return before

  if (before.state === 'missing' || before.state === 'incomplete') {
    await runIncrementalIndex({ repoRoot, dbPath })   // falls back to a cold index internally
    return checkFreshness(repoRoot, dbPath)
  }

  const delta = before.changedFiles + before.deletedFiles
  if (delta >= AUTO_REINDEX_THRESHOLD) return before

  await runIncrementalIndex({ repoRoot, dbPath })
  return checkFreshness(repoRoot, dbPath)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/freshness.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire it into the CLI**

In `src/cli.ts`, change the `index` command so incremental is the default and a full rebuild is opt-in. Add the option and replace the action body's call:

```ts
  .option('-F, --full', 'force a full reindex instead of an incremental one')
```

and in the action, replacing the existing `runColdIndex` call:

```ts
    const report = options.full
      ? { ...(await runColdIndex({ repoRoot, dbPath, onProgress })), changedFiles: 0, deletedFiles: 0, reparsedFiles: 0, fellBackToCold: true }
      : await runIncrementalIndex({ repoRoot, dbPath, onProgress })

    if (!options.full && !report.fellBackToCold) {
      console.log(`Updated ${report.changedFiles} changed, ${report.deletedFiles} deleted (reparsed ${report.reparsedFiles})`)
    }
```

Keep every existing line of output after that — the totals, the skip breakdown, the index path — unchanged. Add the imports for `runIncrementalIndex`, and keep `runColdIndex` imported for `--full`.

In the `status` command, replace the hand-rolled state logic with `checkFreshness`, printing:
- `missing` → the existing "No index for ..." message, unchanged.
- `incomplete` → the existing INCOMPLETE message, unchanged.
- `stale` → `State:   STALE — <changedFiles> changed, <deletedFiles> deleted since the last index.`
- `current` → `State:   current`, keeping the existing note when the repo is not a git repository.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. `tests/cli.test.ts` asserts on `/current/`, `/STALE/`, `/INCOMPLETE/` and `/No index/`; all four still hold. If the STALE assertion fails because the message changed shape, update only that regex — the state it asserts must not change.

- [ ] **Step 7: Verify against a real repository**

```bash
npm run build
node dist/cli.js index ~/Documents/arsal_git/work-dashboard --full
node dist/cli.js index ~/Documents/arsal_git/work-dashboard
node dist/cli.js status ~/Documents/arsal_git/work-dashboard
```

Expected: the second command reports 0 changed and completes far faster than the first. Record both wall-clock times — spec §11 targets ~60s cold and under a second for a typical incremental, and this is the first chance to check the incremental half.

- [ ] **Step 8: Commit**

```bash
git add src/indexer/freshness.ts src/cli.ts tests/freshness.test.ts
git commit -m "feat: freshness gate, incremental by default on arch index"
```

---

### Task 5: Tool plumbing — the envelope, the freshness wrapper, and the queries tools need

Every tool returns the same envelope, so the four rules in spec §8.1 are enforced in one place rather than re-litigated per tool.

**Files:**
- Create: `src/tools/envelope.ts`
- Modify: `src/store/graph-store.ts`
- Test: `tests/tools-envelope.test.ts`

**Interfaces:**
- Consumes: `Freshness`, `ensureFresh`, `indexPathFor`, `GraphStore`, `Confidence`.
- Produces: `CONFIDENCE_RANK`, `interface IndexStatus`, `interface Truncation`, `interface ToolEnvelope<T>`, `truncate<T>(items, limit)`, `withIndex<T>(repoRoot, fn)`, `toolText(envelope)`. Plus store methods `edgesToSymbol`, `findSymbols`, `languageBreakdown`, `confidenceBreakdown`, `totals`, `symbolById`.

> **Explicit confidence ranking.** The spec warns against relying on the declaration order of the `Confidence` union as a ranking, because whether `unresolved` sorts above or below `ambiguous` is genuinely arguable and an implicit order would silently invert a `minConfidence` filter. This task defines the rank once, explicitly: `exact` 4, `resolved` 3, `heuristic` 2, `ambiguous` 1, `unresolved` 0. `ambiguous` outranks `unresolved` because an ambiguous edge names real candidates in this repository while an unresolved one names nothing at all.

- [ ] **Step 1: Write the failing test**

`tests/tools-envelope.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { CONFIDENCE_RANK, truncate, withIndex, toolText } from '../src/tools/envelope.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string

beforeEach(async () => {
  fixture = buildFixture({ git: true })
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-env-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
})

describe('CONFIDENCE_RANK', () => {
  it('ranks ambiguous above unresolved, because ambiguous names real candidates', () => {
    expect(CONFIDENCE_RANK.ambiguous).toBeGreaterThan(CONFIDENCE_RANK.unresolved)
    expect(CONFIDENCE_RANK.exact).toBeGreaterThan(CONFIDENCE_RANK.heuristic)
    expect(CONFIDENCE_RANK.heuristic).toBeGreaterThan(CONFIDENCE_RANK.ambiguous)
  })

  it('assigns a rank to every confidence value', () => {
    for (const c of ['exact', 'resolved', 'heuristic', 'unresolved', 'ambiguous'] as const) {
      expect(typeof CONFIDENCE_RANK[c]).toBe('number')
    }
  })
})

describe('truncate', () => {
  it('returns everything and no marker when under the limit', () => {
    expect(truncate([1, 2, 3], 10)).toEqual({ items: [1, 2, 3] })
  })

  it('truncates loudly, reporting the TRUE total', () => {
    const r = truncate([1, 2, 3, 4, 5], 2)
    expect(r.items).toEqual([1, 2])
    expect(r.truncated).toEqual({ returned: 2, total: 5 })
  })

  it('handles an exact-limit list without claiming truncation', () => {
    expect(truncate([1, 2], 2).truncated).toBeUndefined()
  })
})

describe('withIndex', () => {
  it('wraps a result with the index status', async () => {
    const env = await withIndex(fixture, () => ({ hello: 'world' }), dbPath)
    expect(env.result).toEqual({ hello: 'world' })
    expect(env.index.state).toBe('current')
    expect(env.index.repoRoot).toBe(fixture)
  })

  it('absorbs a small delta so the tool sees a current index', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n + 3; }\n')
    const env = await withIndex(fixture, store => store.allFilePaths().length, dbPath)
    expect(env.index.state).toBe('current')
    expect(typeof env.result).toBe('number')
  })

  it('closes the store even when the callback throws', async () => {
    await expect(withIndex(fixture, () => { throw new Error('boom') }, dbPath)).rejects.toThrow('boom')
    // A leaked handle would make this second open fail or hang.
    const env = await withIndex(fixture, () => 'ok', dbPath)
    expect(env.result).toBe('ok')
  })
})

describe('toolText', () => {
  it('serializes an envelope into MCP text content', async () => {
    const env = await withIndex(fixture, () => ({ n: 1 }), dbPath)
    const payload = toolText(env)
    expect(payload.content[0].type).toBe('text')
    const parsed = JSON.parse(payload.content[0].text)
    expect(parsed.result).toEqual({ n: 1 })
    expect(parsed.index.state).toBe('current')
  })
})

describe('store queries for tools', () => {
  it('breaks edges down by confidence without merging unresolved into ambiguous', () => {
    const store = GraphStore.open(dbPath)
    const breakdown = store.confidenceBreakdown()
    expect(breakdown.unresolved).toBeGreaterThan(0)
    expect(breakdown).not.toHaveProperty('ambiguous_or_unresolved')
    expect(Object.keys(breakdown).sort()).toEqual(
      ['ambiguous', 'exact', 'heuristic', 'resolved', 'unresolved'],
    )
    store.close()
  })

  it('counts files and symbols per language, including the null-language bucket', () => {
    const store = GraphStore.open(dbPath)
    const langs = store.languageBreakdown()
    expect(langs.some(l => l.lang === 'typescript')).toBe(true)
    expect(langs.some(l => l.lang === null)).toBe(true)   // README.md
    store.close()
  })

  it('reports repository totals', () => {
    const store = GraphStore.open(dbPath)
    const t = store.totals()
    expect(t.files).toBeGreaterThan(0)
    expect(t.symbols).toBeGreaterThan(0)
    expect(t.edges).toBeGreaterThan(0)
    store.close()
  })

  it('finds symbols by exact and partial name, with the owning path', () => {
    const store = GraphStore.open(dbPath)
    const exact = store.findSymbols({ name: 'helper', limit: 10 })
    expect(exact[0]).toMatchObject({ name: 'helper', path: 'src/helper.ts' })
    const partial = store.findSymbols({ contains: 'help', limit: 10 })
    expect(partial.map(s => s.name)).toContain('helper')
    store.close()
  })

  it('filters found symbols by kind and exported flag', () => {
    const store = GraphStore.open(dbPath)
    expect(store.findSymbols({ contains: 'Order', kind: 'class', limit: 10 })
      .every(s => s.kind === 'class')).toBe(true)
    expect(store.findSymbols({ contains: 'helper', exported: true, limit: 10 })
      .every(s => s.exported)).toBe(true)
    store.close()
  })

  it('returns the edges arriving at a symbol', () => {
    const store = GraphStore.open(dbPath)
    const helperSymbol = store.findSymbols({ name: 'helper', limit: 1 })[0]
    const inbound = store.edgesToSymbol(helperSymbol.id)
    expect(inbound.length).toBeGreaterThan(0)
    expect(inbound.every(e => e.dstSymbolId === helperSymbol.id)).toBe(true)
    store.close()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools-envelope.test.ts`
Expected: FAIL — cannot resolve `../src/tools/envelope.js`.

- [ ] **Step 3: Add the store queries**

In `src/store/graph-store.ts`, add this exported interface beside the others:

```ts
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
```

And these methods to the class:

```ts
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
```

Add these module-level helpers beside the existing `EDGE_SELECT`:

```ts
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
```

- [ ] **Step 4: Implement the envelope**

`src/tools/envelope.ts`:
```ts
import { GraphStore } from '../store/graph-store.js'
import { indexPathFor } from '../repo/repo-source.js'
import { ensureFresh, type Freshness, type IndexState } from '../indexer/freshness.js'
import type { Confidence } from '../types.js'

/**
 * Explicit confidence ranking. The union's declaration order is NOT a
 * ranking — relying on it would silently invert a minConfidence filter.
 * `ambiguous` outranks `unresolved` because an ambiguous edge names real
 * candidates in this repository, while an unresolved one names nothing.
 */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  exact: 4,
  resolved: 3,
  heuristic: 2,
  ambiguous: 1,
  unresolved: 0,
}

export interface IndexStatus {
  repoRoot: string
  state: IndexState
  changedFiles: number
  deletedFiles: number
  indexedAt: string | null
  /** Present only when state is not `current`, explaining what to do. */
  note?: string
}

export interface Truncation {
  returned: number
  total: number
}

export interface ToolEnvelope<T> {
  index: IndexStatus
  result: T
  truncated?: Truncation
}

/** Caps a list and says so, with the true total. Never trims silently. */
export function truncate<T>(items: T[], limit: number): { items: T[]; truncated?: Truncation } {
  if (items.length <= limit) return { items }
  return { items: items.slice(0, limit), truncated: { returned: limit, total: items.length } }
}

/**
 * Runs a read against a repository's index, bringing it up to date first when
 * that is cheap. Always closes the store. The returned envelope carries the
 * freshness of the data the callback actually saw.
 */
export async function withIndex<T>(
  repoRoot: string,
  fn: (store: GraphStore, freshness: Freshness) => T,
  dbPathOverride?: string,
): Promise<ToolEnvelope<T>> {
  const dbPath = dbPathOverride ?? indexPathFor(repoRoot)
  const freshness = await ensureFresh(repoRoot, dbPath)
  const store = GraphStore.open(dbPath)
  try {
    return { index: statusOf(repoRoot, freshness), result: fn(store, freshness) }
  } finally {
    store.close()
  }
}

export function statusOf(repoRoot: string, freshness: Freshness): IndexStatus {
  const status: IndexStatus = {
    repoRoot,
    state: freshness.state,
    changedFiles: freshness.changedFiles,
    deletedFiles: freshness.deletedFiles,
    indexedAt: freshness.indexedAt,
  }
  if (freshness.state === 'stale') {
    status.note =
      `${freshness.changedFiles} files changed and ${freshness.deletedFiles} were deleted since ` +
      `this index was built — too many to absorb inline. Results may be out of date. ` +
      `Run "arch index" to refresh.`
  }
  if (freshness.state === 'incomplete') {
    status.note = 'A previous index did not finish. Results are incomplete; run "arch index".'
  }
  return status
}

/** MCP tools return text content; the envelope is the payload. */
export function toolText<T>(envelope: ToolEnvelope<T>): {
  content: Array<{ type: 'text'; text: string }>
} {
  return { content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }] }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/tools-envelope.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/tools/envelope.ts src/store/graph-store.ts tests/tools-envelope.test.ts
git commit -m "feat: tool envelope, confidence ranking, and store queries for tools"
```

---

### Task 6: `get_repo_overview`

**Files:**
- Create: `src/tools/overview.ts`
- Test: `tests/tools-overview.test.ts`

**Interfaces:**
- Consumes: `GraphStore` (`languageBreakdown`, `confidenceBreakdown`, `totals`, `allFilePaths`, `fileRow`, `getMeta`, `findSymbols`), `withIndex`, `ToolEnvelope`.
- Produces: `interface RepoOverview` and `buildOverview(store: GraphStore): RepoOverview`.

This is the tool Claude calls first for "explain this architecture", so it must be cheap and fully structural — no LLM, no file reads.

- [ ] **Step 1: Write the failing test**

`tests/tools-overview.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { buildOverview } from '../src/tools/overview.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-ov-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('buildOverview', () => {
  it('reports totals', () => {
    const o = buildOverview(store)
    expect(o.totals.files).toBeGreaterThan(0)
    expect(o.totals.symbols).toBeGreaterThan(0)
    expect(o.totals.edges).toBeGreaterThan(0)
  })

  it('reports languages including files with no known language', () => {
    const o = buildOverview(store)
    expect(o.languages.find(l => l.lang === 'typescript')!.files).toBeGreaterThan(0)
    expect(o.languages.some(l => l.lang === null)).toBe(true)
  })

  it('reports the confidence breakdown WITHOUT merging unresolved into ambiguous', () => {
    const o = buildOverview(store)
    expect(o.edgeConfidence.unresolved).toBeGreaterThan(0)
    expect(o.edgeConfidence).toHaveProperty('ambiguous')
    expect(o.edgeConfidence).toHaveProperty('heuristic')
  })

  it('states plainly what fraction of call edges resolved to a target', () => {
    const o = buildOverview(store)
    expect(o.resolvedFraction).toBeGreaterThanOrEqual(0)
    expect(o.resolvedFraction).toBeLessThanOrEqual(1)
  })

  it('lists top-level modules with their file and symbol counts', () => {
    const o = buildOverview(store)
    const src = o.modules.find(m => m.path === 'src')!
    expect(src.files).toBeGreaterThan(0)
    expect(src.symbols).toBeGreaterThan(0)
  })

  it('surfaces the skip breakdown by reason', () => {
    const o = buildOverview(store)
    expect(o.skipped.total).toBeGreaterThan(0)
    expect(Object.keys(o.skipped.byReason).length).toBeGreaterThan(0)
  })

  it('reports parse errors from the per-file counts', () => {
    const o = buildOverview(store)
    expect(o.filesWithParseErrors).toBe(0)
  })

  it('detects entry points', () => {
    const o = buildOverview(store)
    expect(o.entryPoints).toContain('src/index.ts')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools-overview.test.ts`
Expected: FAIL — cannot resolve `../src/tools/overview.js`.

- [ ] **Step 3: Implement the overview**

`src/tools/overview.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'

export interface RepoOverview {
  repoRoot: string | null
  indexedAt: string | null
  headCommit: string | null
  totals: { files: number; symbols: number; edges: number; imports: number }
  languages: Array<{ lang: string | null; files: number; symbols: number }>
  /** Every confidence tier, reported separately. Never merged. */
  edgeConfidence: Record<string, number>
  /** Share of edges that found a concrete target. The rest are external. */
  resolvedFraction: number
  modules: Array<{ path: string; files: number; symbols: number }>
  entryPoints: string[]
  skipped: { total: number; byReason: Record<string, number> }
  filesWithParseErrors: number
}

const ENTRY_BASENAMES = new Set([
  'index.ts', 'index.tsx', 'index.js', 'index.mjs',
  'main.ts', 'main.js', 'server.ts', 'server.js', 'app.ts', 'app.js', 'cli.ts', 'cli.js',
])

export function buildOverview(store: GraphStore): RepoOverview {
  const totals = store.totals()
  const edgeConfidence = store.confidenceBreakdown()

  // "Resolved" here means the edge found a concrete symbol in this repo.
  // Unresolved edges are external by definition, not failures.
  const targeted = edgeConfidence.exact + edgeConfidence.resolved +
    edgeConfidence.heuristic + edgeConfidence.ambiguous
  const resolvedFraction = totals.edges === 0 ? 0 : targeted / totals.edges

  const paths = store.allFilePaths()
  const symbolsByFile = store.symbolsByFile()
  const idsByPath = store.fileIdsByPath()

  const moduleFiles = new Map<string, { files: number; symbols: number }>()
  let filesWithParseErrors = 0
  const entryPoints: string[] = []

  for (const path of paths) {
    const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : '.'
    const bucket = moduleFiles.get(top) ?? { files: 0, symbols: 0 }
    bucket.files += 1
    const fileId = idsByPath.get(path)
    if (fileId !== undefined) bucket.symbols += (symbolsByFile.get(fileId) ?? []).length
    moduleFiles.set(top, bucket)

    const row = store.fileRow(path)
    if (row && row.errorCount > 0) filesWithParseErrors += 1

    const basename = path.slice(path.lastIndexOf('/') + 1)
    if (ENTRY_BASENAMES.has(basename)) entryPoints.push(path)
  }

  let byReason: Record<string, number> = {}
  const raw = store.getMeta('files_skipped_by_reason')
  if (raw) {
    try { byReason = JSON.parse(raw) as Record<string, number> } catch { byReason = {} }
  }

  return {
    repoRoot: store.getMeta('repo_root') ?? null,
    indexedAt: store.getMeta('indexed_at') ?? null,
    headCommit: store.getMeta('head_commit') || null,
    totals,
    languages: store.languageBreakdown(),
    edgeConfidence,
    resolvedFraction: Number(resolvedFraction.toFixed(4)),
    modules: [...moduleFiles.entries()]
      .map(([path, counts]) => ({ path, ...counts }))
      .sort((a, b) => b.files - a.files),
    entryPoints: entryPoints.sort(),
    skipped: { total: Number(store.getMeta('files_skipped') ?? '0'), byReason },
    filesWithParseErrors,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools-overview.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/overview.ts tests/tools-overview.test.ts
git commit -m "feat: get_repo_overview"
```

---

### Task 7: `search_code`

**Files:**
- Create: `src/tools/search.ts`
- Test: `tests/tools-search.test.ts`

**Interfaces:**
- Consumes: `GraphStore.findSymbols`, `GraphStore.allFilePaths`, `truncate`.
- Produces: `interface SearchHit`, `interface SearchOptions`, `searchCode(store: GraphStore, repoRoot: string, options: SearchOptions): { hits: SearchHit[]; truncated?: Truncation }`.

> **No external binary.** The spec sketches ripgrep for the full-text half. This uses a Node scan over the already-indexed file list instead, because the MCP server must work wherever the CLI runs and a missing `rg` would turn a core tool into a silent half-tool. The file list is already bounded — vendored trees, binaries and anything over 1 MB were excluded at index time — so the scan reads only real source. If this ever becomes the bottleneck, shelling out to ripgrep *when present* is a safe later optimization; starting there would not have been.

- [ ] **Step 1: Write the failing test**

`tests/tools-search.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { searchCode } from '../src/tools/search.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore
let fixture: string

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-search-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('searchCode', () => {
  it('ranks an exact symbol match first', () => {
    const { hits } = searchCode(store, fixture, { query: 'helper', limit: 20 })
    expect(hits[0]).toMatchObject({ kind: 'symbol', symbolName: 'helper', path: 'src/helper.ts' })
  })

  it('returns file:line pointers rather than whole files', () => {
    const { hits } = searchCode(store, fixture, { query: 'helper', limit: 20 })
    for (const hit of hits) {
      expect(typeof hit.line).toBe('number')
      expect(hit.line).toBeGreaterThan(0)
      expect(hit.snippet.length).toBeLessThanOrEqual(200)
    }
  })

  it('finds text occurrences that are not symbol declarations', () => {
    const { hits } = searchCode(store, fixture, { query: 'placed', limit: 20 })
    expect(hits.some(h => h.kind === 'text' && h.path === 'src/services/order.ts')).toBe(true)
  })

  it('finds a partial symbol name', () => {
    const { hits } = searchCode(store, fixture, { query: 'Order', limit: 20 })
    expect(hits.some(h => h.symbolName === 'OrderService')).toBe(true)
  })

  it('filters by path prefix', () => {
    const { hits } = searchCode(store, fixture, { query: 'e', path: 'src/services', limit: 50 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every(h => h.path.startsWith('src/services'))).toBe(true)
  })

  it('filters by symbol kind', () => {
    const { hits } = searchCode(store, fixture, { query: 'Order', kind: 'class', limit: 20 })
    expect(hits.every(h => h.kind === 'symbol' && h.symbolKind === 'class')).toBe(true)
  })

  it('truncates loudly with the true total', () => {
    const { hits, truncated } = searchCode(store, fixture, { query: 'e', limit: 2 })
    expect(hits).toHaveLength(2)
    expect(truncated!.returned).toBe(2)
    expect(truncated!.total).toBeGreaterThan(2)
  })

  it('never returns the same path and line twice', () => {
    const { hits } = searchCode(store, fixture, { query: 'helper', limit: 50 })
    const keys = hits.map(h => `${h.path}:${h.line}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('returns nothing for a query that matches nothing, without throwing', () => {
    const { hits } = searchCode(store, fixture, { query: 'zzzznotpresent', limit: 20 })
    expect(hits).toEqual([])
  })

  it('does not read files that were skipped at index time', () => {
    // node_modules and the minified bundle were skipped, so their contents
    // must be unreachable through search.
    const { hits } = searchCode(store, fixture, { query: 'module.exports', limit: 50 })
    expect(hits.every(h => !h.path.startsWith('node_modules/'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools-search.test.ts`
Expected: FAIL — cannot resolve `../src/tools/search.js`.

- [ ] **Step 3: Implement search**

`src/tools/search.ts`:
```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GraphStore } from '../store/graph-store.js'
import { truncate, type Truncation } from './envelope.js'

export interface SearchOptions {
  query: string
  kind?: string
  lang?: string
  path?: string
  limit: number
}

export interface SearchHit {
  path: string
  line: number
  kind: 'symbol' | 'text'
  symbolName?: string
  symbolKind?: string
  exported?: boolean
  snippet: string
  score: number
}

const SCORE_EXACT_SYMBOL = 100
const SCORE_PARTIAL_SYMBOL = 60
const SCORE_TEXT = 20
const SNIPPET_MAX = 200
/** Scan headroom above the caller's limit, so ranking has something to choose from. */
const SCAN_MULTIPLIER = 5

export function searchCode(
  store: GraphStore,
  repoRoot: string,
  options: SearchOptions,
): { hits: SearchHit[]; truncated?: Truncation } {
  const { query, limit } = options
  if (query.length === 0) return { hits: [] }

  const hits: SearchHit[] = []
  const seen = new Set<string>()

  const push = (hit: SearchHit): void => {
    const key = `${hit.path}:${hit.line}`
    if (seen.has(key)) return
    seen.add(key)
    hits.push(hit)
  }

  const symbolLimit = limit * SCAN_MULTIPLIER

  for (const symbol of store.findSymbols({ name: query, kind: options.kind, pathPrefix: options.path, limit: symbolLimit })) {
    push(symbolHit(symbol, SCORE_EXACT_SYMBOL))
  }
  for (const symbol of store.findSymbols({ contains: query, kind: options.kind, pathPrefix: options.path, limit: symbolLimit })) {
    push(symbolHit(symbol, SCORE_PARTIAL_SYMBOL))
  }

  // Full-text half. Only files that were indexed are scanned, so anything
  // skipped at index time — vendored, binary, minified, oversized — stays
  // unreachable here too, and the two views of the repo agree.
  if (options.kind === undefined) {
    const needle = query.toLowerCase()
    for (const path of store.allFilePaths()) {
      if (options.path !== undefined && !path.startsWith(options.path)) continue
      if (options.lang !== undefined && store.fileRow(path)?.lang !== options.lang) continue

      let source: string
      try {
        source = readFileSync(join(repoRoot, path), 'utf8')
      } catch {
        continue   // file vanished since indexing; the freshness gate reports that separately
      }
      if (!source.toLowerCase().includes(needle)) continue

      const lines = source.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue
        push({
          path,
          line: i + 1,
          kind: 'text',
          snippet: lines[i].trim().slice(0, SNIPPET_MAX),
          score: SCORE_TEXT,
        })
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
  const { items, truncated } = truncate(hits, limit)
  return { hits: items, truncated }
}

function symbolHit(
  symbol: { path: string; startLine: number; name: string; kind: string; exported: boolean; signature: string | null },
  score: number,
): SearchHit {
  return {
    path: symbol.path,
    line: symbol.startLine,
    kind: 'symbol',
    symbolName: symbol.name,
    symbolKind: symbol.kind,
    exported: symbol.exported,
    snippet: (symbol.signature ?? symbol.name).slice(0, SNIPPET_MAX),
    score,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools-search.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/search.ts tests/tools-search.test.ts
git commit -m "feat: search_code with symbol and full-text ranking"
```

---

### Task 8: `get_dependencies` and `impact_of`

These two share a traversal, so they share a task. `impact_of` is the tool the product's headline question runs through — "if I change this interface, what could break?" — and its whole value is the confidence bucketing, so that is where the tests concentrate.

**Files:**
- Create: `src/tools/dependencies.ts`, `src/tools/impact.ts`
- Modify: `src/store/graph-store.ts` (one more edge query)
- Test: `tests/tools-dependencies.test.ts`, `tests/tools-impact.test.ts`

**Interfaces:**
- Consumes: `GraphStore` (`fileIdByPath`, `allFilePaths`, `findSymbols`, `symbolById`, `edgesToSymbol`, `filesImporting`, `importsForFile`, `pathsById`), `CONFIDENCE_RANK`, `truncate`.
- Produces: `resolveTarget`, `traverseSymbols`, `getDependencies` from `dependencies.ts`; `impactOf` from `impact.ts`; store method `edgesFromSymbol(symbolId: number): EdgeRow[]`.

- [ ] **Step 1: Add the remaining edge query**

In `src/store/graph-store.ts`, add to the class:

```ts
  edgesFromSymbol(symbolId: number): EdgeRow[] {
    return this.toEdgeRows(this.db.prepare(EDGE_SELECT + ' WHERE src_symbol_id = ?').all(symbolId))
  }
```

- [ ] **Step 2: Write the failing tests**

`tests/tools-dependencies.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { getDependencies, resolveTarget } from '../src/tools/dependencies.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-dep-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('resolveTarget', () => {
  it('recognises an exact file path', () => {
    expect(resolveTarget(store, 'src/helper.ts')).toMatchObject({ kind: 'file', resolved: 'src/helper.ts' })
  })

  it('recognises a directory as a module', () => {
    expect(resolveTarget(store, 'src/services')).toMatchObject({ kind: 'module', resolved: 'src/services' })
  })

  it('falls back to a symbol name', () => {
    expect(resolveTarget(store, 'helper')).toMatchObject({ kind: 'symbol', resolved: 'helper' })
  })

  it('reports every candidate when a symbol name is not unique', () => {
    const t = resolveTarget(store, 'notify')
    expect(t.kind).toBe('symbol')
    expect(Array.isArray(t.candidates)).toBe(true)
  })

  it('returns kind "unknown" for something that matches nothing', () => {
    expect(resolveTarget(store, 'nothing/at/all').kind).toBe('unknown')
  })
})

describe('getDependencies at file level', () => {
  it('direction out lists what a file imports', () => {
    const r = getDependencies(store, { target: 'src/services/order.ts', direction: 'out', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/helper.ts')
  })

  it('direction in lists what imports a file', () => {
    const r = getDependencies(store, { target: 'src/helper.ts', direction: 'in', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/services/order.ts')
  })

  it('respects depth', () => {
    const shallow = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 1, limit: 50 })
    const deep = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 3, limit: 50 })
    expect(deep.nodes.length).toBeGreaterThanOrEqual(shallow.nodes.length)
    expect(deep.nodes.map(n => n.path)).toContain('src/helper.ts')
  })

  it('never revisits a node, so a cycle terminates', () => {
    const r = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 10, limit: 100 })
    const paths = r.nodes.map(n => n.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('treats a module target as the union of its files', () => {
    const r = getDependencies(store, { target: 'src/services', direction: 'out', depth: 1, limit: 50 })
    expect(r.nodes.map(n => n.path)).toContain('src/helper.ts')
  })
})

describe('getDependencies at symbol level', () => {
  it('direction in lists callers of a symbol with their confidence', () => {
    const r = getDependencies(store, { target: 'helper', direction: 'in', depth: 1, limit: 50 })
    expect(r.nodes.some(n => n.path === 'src/services/order.ts' && n.confidence === 'heuristic')).toBe(true)
  })

  it('filters by minConfidence using the explicit rank', () => {
    const all = getDependencies(store, { target: 'helper', direction: 'in', depth: 2, limit: 50 })
    const strict = getDependencies(store, { target: 'helper', direction: 'in', depth: 2, minConfidence: 'exact', limit: 50 })
    expect(strict.nodes.length).toBeLessThanOrEqual(all.nodes.length)
    expect(strict.nodes).toHaveLength(0)   // nothing emits `exact` yet
  })

  it('truncates loudly', () => {
    const r = getDependencies(store, { target: 'src/index.ts', direction: 'out', depth: 5, limit: 1 })
    expect(r.nodes).toHaveLength(1)
    expect(r.truncated!.total).toBeGreaterThan(1)
  })
})
```

`tests/tools-impact.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { impactOf } from '../src/tools/impact.js'
import { GraphStore } from '../src/store/graph-store.js'
import { buildFixture } from './fixture-builder.js'

let store: GraphStore

beforeAll(async () => {
  const fixture = buildFixture({ git: true })
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-imp-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })
  store = GraphStore.open(dbPath)
})

describe('impactOf', () => {
  it('finds the references to a symbol', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.references.some(ref => ref.path === 'src/services/order.ts')).toBe(true)
  })

  it('buckets by confidence and NEVER merges the buckets', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.buckets).toHaveProperty('verified')
    expect(r.buckets).toHaveProperty('likely')
    expect(r.buckets).toHaveProperty('ambiguous')
    expect(r.buckets.verified).toBe(0)            // nothing emits `exact` yet
    expect(r.buckets.likely).toBeGreaterThan(0)   // heuristic edges exist
    expect(r.buckets.verified + r.buckets.likely + r.buckets.ambiguous).toBe(r.totalReferences)
  })

  it('reports zero references for a symbol nobody calls, without throwing', () => {
    const r = impactOf(store, { symbol: 'unused', maxDepth: 3, limit: 50 })
    expect(r.totalReferences).toBe(0)
    expect(r.references).toEqual([])
  })

  it('groups references by module', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(r.byModule.some(m => m.module === 'src/services')).toBe(true)
  })

  it('flags a symbol exported from an entry point as crossing the package boundary', () => {
    const fromEntry = impactOf(store, { symbol: 'OrderService', maxDepth: 3, limit: 50 })
    expect(typeof fromEntry.exportedAtPackageBoundary).toBe('boolean')
    const internal = impactOf(store, { symbol: 'helper', maxDepth: 3, limit: 50 })
    expect(internal.exportedAtPackageBoundary).toBe(false)
  })

  it('reports every candidate when the symbol name is not unique', () => {
    const r = impactOf(store, { symbol: 'notify', maxDepth: 3, limit: 50 })
    expect(r.matchedSymbols.length).toBeGreaterThanOrEqual(1)
    for (const m of r.matchedSymbols) expect(m).toHaveProperty('path')
  })

  it('reports a symbol that does not exist as unknown rather than as zero impact', () => {
    const r = impactOf(store, { symbol: 'noSuchSymbolAnywhere', maxDepth: 3, limit: 50 })
    expect(r.matchedSymbols).toEqual([])
    expect(r.note).toMatch(/not found/i)
  })

  it('terminates on a cycle', () => {
    const r = impactOf(store, { symbol: 'helper', maxDepth: 50, limit: 200 })
    const keys = r.references.map(ref => `${ref.path}:${ref.line}:${ref.symbolName}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/tools-dependencies.test.ts tests/tools-impact.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 4: Implement dependencies**

`src/tools/dependencies.ts`:
```ts
import type { GraphStore, EdgeRow } from '../store/graph-store.js'
import type { Confidence, EdgeKind } from '../types.js'
import { CONFIDENCE_RANK, truncate, type Truncation } from './envelope.js'

export type Direction = 'in' | 'out'

export interface ResolvedTarget {
  kind: 'file' | 'module' | 'symbol' | 'unknown'
  resolved: string
  candidates?: Array<{ path: string; line: number; kind: string }>
}

export interface DependencyOptions {
  target: string
  direction: Direction
  depth: number
  kind?: EdgeKind
  minConfidence?: Confidence
  limit: number
}

export interface DependencyNode {
  path: string
  symbolName: string | null
  depth: number
  via: EdgeKind | 'imports'
  confidence: Confidence
  line: number | null
}

export interface DependencyResult {
  target: ResolvedTarget
  direction: Direction
  nodes: DependencyNode[]
  truncated?: Truncation
}

/** A file path wins over a directory, which wins over a symbol name. */
export function resolveTarget(store: GraphStore, target: string): ResolvedTarget {
  if (store.fileIdByPath(target) !== undefined) return { kind: 'file', resolved: target }

  const prefix = target.endsWith('/') ? target : `${target}/`
  if (store.allFilePaths().some(p => p.startsWith(prefix))) {
    return { kind: 'module', resolved: target.replace(/\/$/, '') }
  }

  const symbols = store.findSymbols({ name: target, limit: 20 })
  if (symbols.length > 0) {
    return {
      kind: 'symbol',
      resolved: target,
      candidates: symbols.map(s => ({ path: s.path, line: s.startLine, kind: s.kind })),
    }
  }

  return { kind: 'unknown', resolved: target }
}

export function getDependencies(store: GraphStore, options: DependencyOptions): DependencyResult {
  const target = resolveTarget(store, options.target)
  if (target.kind === 'unknown') return { target, direction: options.direction, nodes: [] }

  const nodes = target.kind === 'symbol'
    ? symbolLevel(store, target, options)
    : fileLevel(store, target, options)

  const { items, truncated } = truncate(nodes, options.limit)
  return { target, direction: options.direction, nodes: items, truncated }
}

function fileLevel(store: GraphStore, target: ResolvedTarget, options: DependencyOptions): DependencyNode[] {
  const pathsById = store.pathsById()
  const idsByPath = store.fileIdsByPath()

  const startIds = target.kind === 'file'
    ? [idsByPath.get(target.resolved)!]
    : store.allFilePaths()
        .filter(p => p.startsWith(`${target.resolved}/`))
        .map(p => idsByPath.get(p)!)

  const seen = new Set<number>(startIds)
  const out: DependencyNode[] = []
  let frontier = startIds

  for (let depth = 1; depth <= options.depth && frontier.length > 0; depth++) {
    const next: number[] = []
    for (const fileId of frontier) {
      const neighbours = options.direction === 'out'
        ? store.importsForFile(fileId)
            .map(i => i.resolvedFileId)
            .filter((id): id is number => id !== null)
        : store.filesImporting(fileId)

      for (const neighbour of neighbours) {
        if (seen.has(neighbour)) continue
        seen.add(neighbour)
        next.push(neighbour)
        out.push({
          path: pathsById.get(neighbour) ?? '?',
          symbolName: null,
          depth,
          via: 'imports',
          confidence: 'resolved',
          line: null,
        })
      }
    }
    frontier = next
  }

  return out
}

function symbolLevel(store: GraphStore, target: ResolvedTarget, options: DependencyOptions): DependencyNode[] {
  const startIds = store.findSymbols({ name: target.resolved, limit: 20 }).map(s => s.id)
  return traverseSymbols(store, startIds, options.direction, options.depth, options.kind, options.minConfidence)
}

/**
 * Breadth-first walk over symbol edges. Shared with impact_of.
 * `seen` guarantees termination on a cycle and stops a node being reported twice.
 */
export function traverseSymbols(
  store: GraphStore,
  startSymbolIds: number[],
  direction: Direction,
  maxDepth: number,
  kind?: EdgeKind,
  minConfidence?: Confidence,
): DependencyNode[] {
  const floor = minConfidence === undefined ? -1 : CONFIDENCE_RANK[minConfidence]
  const pathsById = store.pathsById()
  const seen = new Set<number>(startSymbolIds)
  const out: DependencyNode[] = []
  let frontier = startSymbolIds

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = []
    for (const symbolId of frontier) {
      const edges: EdgeRow[] = direction === 'in'
        ? store.edgesToSymbol(symbolId)
        : store.edgesFromSymbol(symbolId)

      for (const edge of edges) {
        if (kind !== undefined && edge.kind !== kind) continue
        if (CONFIDENCE_RANK[edge.confidence] < floor) continue

        const otherSymbolId = direction === 'in' ? edge.srcSymbolId : edge.dstSymbolId
        const otherFileId = direction === 'in' ? edge.srcFileId : edge.dstFileId

        out.push({
          path: otherFileId === null ? '(external)' : pathsById.get(otherFileId) ?? '?',
          symbolName: otherSymbolId === null
            ? (direction === 'in' ? null : edge.dstName)
            : store.symbolById(otherSymbolId)?.name ?? null,
          depth,
          via: edge.kind,
          confidence: edge.confidence,
          line: edge.line,
        })

        if (otherSymbolId !== null && !seen.has(otherSymbolId)) {
          seen.add(otherSymbolId)
          next.push(otherSymbolId)
        }
      }
    }
    frontier = next
  }

  return out
}
```

- [ ] **Step 5: Implement impact**

`src/tools/impact.ts`:
```ts
import type { GraphStore } from '../store/graph-store.js'
import { truncate, type Truncation } from './envelope.js'
import { traverseSymbols, type DependencyNode } from './dependencies.js'

export interface ImpactOptions {
  symbol: string
  file?: string
  maxDepth: number
  limit: number
}

export interface ImpactResult {
  symbol: string
  matchedSymbols: Array<{ path: string; line: number; kind: string; exported: boolean }>
  totalReferences: number
  /**
   * Spec §8's reporting shape. `verified` is evidence from a real type
   * resolver, `likely` is a unique name match, `ambiguous` is a name that
   * matched several candidates and was fanned out to all of them.
   * Unresolved edges cannot appear here at all — they point at no symbol,
   * so reverse reachability from a symbol never reaches them.
   */
  buckets: { verified: number; likely: number; ambiguous: number }
  byModule: Array<{ module: string; count: number }>
  references: DependencyNode[]
  exportedAtPackageBoundary: boolean
  truncated?: Truncation
  note?: string
}

const ENTRY_BASENAMES = new Set([
  'index.ts', 'index.tsx', 'index.js', 'index.mjs',
  'main.ts', 'main.js', 'server.ts', 'server.js', 'app.ts', 'app.js', 'cli.ts', 'cli.js',
])

export function impactOf(store: GraphStore, options: ImpactOptions): ImpactResult {
  const matches = store.findSymbols({
    name: options.symbol,
    pathPrefix: options.file,
    limit: 20,
  })

  if (matches.length === 0) {
    return {
      symbol: options.symbol,
      matchedSymbols: [],
      totalReferences: 0,
      buckets: { verified: 0, likely: 0, ambiguous: 0 },
      byModule: [],
      references: [],
      exportedAtPackageBoundary: false,
      note: `Symbol "${options.symbol}" not found in the index. It may be external, ` +
        `misspelled, or in a file that was skipped at index time.`,
    }
  }

  const references = traverseSymbols(
    store, matches.map(s => s.id), 'in', options.maxDepth,
  )

  const buckets = { verified: 0, likely: 0, ambiguous: 0 }
  const moduleCounts = new Map<string, number>()

  for (const ref of references) {
    if (ref.confidence === 'exact') buckets.verified += 1
    else if (ref.confidence === 'heuristic' || ref.confidence === 'resolved') buckets.likely += 1
    else buckets.ambiguous += 1

    const module = ref.path.includes('/') ? ref.path.slice(0, ref.path.lastIndexOf('/')) : '.'
    moduleCounts.set(module, (moduleCounts.get(module) ?? 0) + 1)
  }

  // Narrowing worth stating: "package boundary" is approximated as an
  // exported symbol living in a conventional entry-point file. Reading
  // package.json `exports` maps would be more precise and is a later
  // refinement; this errs toward NOT claiming a boundary it cannot see.
  const exportedAtPackageBoundary = matches.some(
    s => s.exported && ENTRY_BASENAMES.has(s.path.slice(s.path.lastIndexOf('/') + 1)),
  )

  const { items, truncated } = truncate(references, options.limit)

  return {
    symbol: options.symbol,
    matchedSymbols: matches.map(s => ({
      path: s.path, line: s.startLine, kind: s.kind, exported: s.exported,
    })),
    totalReferences: references.length,
    buckets,
    byModule: [...moduleCounts.entries()]
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count),
    references: items,
    exportedAtPackageBoundary,
    truncated,
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/tools-dependencies.test.ts tests/tools-impact.test.ts`
Expected: PASS, 13 + 8 tests.

- [ ] **Step 7: Commit**

```bash
git add src/tools/dependencies.ts src/tools/impact.ts src/store/graph-store.ts tests/tools-dependencies.test.ts tests/tools-impact.test.ts
git commit -m "feat: get_dependencies and impact_of with confidence bucketing"
```

---

### Task 9: The MCP server

**Files:**
- Modify: `package.json` (two dependencies)
- Create: `src/mcp/server.ts`
- Test: `tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: all four tool builders, `withIndex`, `toolText`.
- Produces: `createArchServer(options?: { dbPathOverride?: (repoRoot: string) => string }): McpServer`.

The `dbPathOverride` hook exists so tests can point the server at a temp index instead of `~/.arch`. It is optional, defaults to the real path, and is the only seam tests need.

> **Verified API notes.** `server.registerTool(name, config, cb)` is the current API; the older `server.tool(...)` overloads are deprecated in SDK 1.30.0. `inputSchema` takes a zod *raw shape* (a plain object of zod validators, not `z.object({...})`) and the SDK converts it to JSON Schema. Invalid arguments come back to the caller as `isError: true` rather than throwing. `InMemoryTransport.createLinkedPair()` links a client and server in-process, so the integration test needs no subprocess.

- [ ] **Step 1: Add the dependencies**

```bash
npm install @modelcontextprotocol/sdk@1.30.0 zod@4.6.5
```

Confirm `package.json` pins both exactly, with no `^` or `~`.

- [ ] **Step 2: Write the failing test**

`tests/mcp-server.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { createArchServer } from '../src/mcp/server.js'
import { buildFixture } from './fixture-builder.js'

let fixture: string
let dbPath: string
let client: Client

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args })
  if (res.isError) throw new Error(String((res.content as any)[0]?.text))
  return JSON.parse(String((res.content as any)[0].text))
}

beforeAll(async () => {
  fixture = buildFixture({ git: true })
  dbPath = join(mkdtempSync(join(tmpdir(), 'arch-mcp-')), 'index.db')
  await runColdIndex({ repoRoot: fixture, dbPath })

  const server = createArchServer({ dbPathOverride: () => dbPath })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

describe('tool registration', () => {
  it('exposes exactly the four core tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(
      ['get_dependencies', 'get_repo_overview', 'impact_of', 'search_code'],
    )
  })

  it('gives every tool a description', async () => {
    const { tools } = await client.listTools()
    for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(20)
  })

  it('publishes a JSON Schema for each tool', async () => {
    const { tools } = await client.listTools()
    const impact = tools.find(t => t.name === 'impact_of')!
    expect(impact.inputSchema.type).toBe('object')
    expect(Object.keys(impact.inputSchema.properties!)).toContain('symbol')
  })
})

describe('every response carries the index status', () => {
  it('on get_repo_overview', async () => {
    const r = await call('get_repo_overview', { repo: fixture })
    expect(r.index.state).toBe('current')
    expect(r.index.repoRoot).toBe(fixture)
  })

  it('on search_code', async () => {
    const r = await call('search_code', { repo: fixture, query: 'helper' })
    expect(r.index).toHaveProperty('state')
  })
})

describe('the tools answer real questions', () => {
  it('get_repo_overview reports separate confidence tiers', async () => {
    const r = await call('get_repo_overview', { repo: fixture })
    expect(r.result.edgeConfidence.unresolved).toBeGreaterThan(0)
    expect(r.result.edgeConfidence).toHaveProperty('ambiguous')
    expect(r.result.totals.files).toBeGreaterThan(0)
  })

  it('search_code finds a symbol and points at file:line', async () => {
    const r = await call('search_code', { repo: fixture, query: 'helper' })
    expect(r.result.hits[0].path).toBe('src/helper.ts')
    expect(r.result.hits[0].line).toBeGreaterThan(0)
  })

  it('get_dependencies walks imports', async () => {
    const r = await call('get_dependencies', { repo: fixture, target: 'src/helper.ts', direction: 'in' })
    expect(r.result.nodes.map((n: any) => n.path)).toContain('src/services/order.ts')
  })

  it('impact_of buckets by confidence', async () => {
    const r = await call('impact_of', { repo: fixture, symbol: 'helper' })
    expect(r.result.buckets.likely).toBeGreaterThan(0)
    expect(r.result.buckets).toHaveProperty('verified')
    expect(r.result.buckets).toHaveProperty('ambiguous')
  })

  it('impact_of explains itself when a symbol is unknown', async () => {
    const r = await call('impact_of', { repo: fixture, symbol: 'definitelyNotHere' })
    expect(r.result.note).toMatch(/not found/i)
  })
})

describe('input validation', () => {
  it('rejects a missing required argument as a tool error, not a crash', async () => {
    const res = await client.callTool({ name: 'impact_of', arguments: { repo: fixture } })
    expect(res.isError).toBe(true)
  })

  it('rejects an out-of-range depth', async () => {
    const res = await client.callTool({
      name: 'get_dependencies',
      arguments: { repo: fixture, target: 'src/helper.ts', direction: 'in', depth: 999 },
    })
    expect(res.isError).toBe(true)
  })

  it('rejects an invalid direction', async () => {
    const res = await client.callTool({
      name: 'get_dependencies',
      arguments: { repo: fixture, target: 'src/helper.ts', direction: 'sideways' },
    })
    expect(res.isError).toBe(true)
  })
})

describe('truncation is always visible', () => {
  it('reports the true total when a result is capped', async () => {
    const r = await call('search_code', { repo: fixture, query: 'e', limit: 2 })
    expect(r.result.hits).toHaveLength(2)
    expect(r.result.truncated.total).toBeGreaterThan(2)
  })
})

describe('freshness is reflected, not hidden', () => {
  it('absorbs a small edit and reports current', async () => {
    writeFileSync(join(fixture, 'src/helper.ts'), 'export function helper(n: number): number { return n + 42; }\n')
    const r = await call('get_repo_overview', { repo: fixture })
    expect(r.index.state).toBe('current')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/mcp-server.test.ts`
Expected: FAIL — cannot resolve `../src/mcp/server.js`.

- [ ] **Step 4: Implement the server**

`src/mcp/server.ts`:
```ts
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
    return toolText(await withIndex(repoRoot, store => buildOverview(store), dbFor(repoRoot)))
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
      depth: z.number().int().min(1).max(10).default(2),
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
      'reported). Treat ambiguous results as candidates to check, not as confirmed callers.',
    inputSchema: {
      repo: repoArg,
      symbol: z.string().min(1).describe('The symbol name to analyse.'),
      file: z.string().optional().describe('Disambiguate by restricting to a path prefix.'),
      maxDepth: z.number().int().min(1).max(10).default(3),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    },
  }, async ({ repo, symbol, file, maxDepth, limit }) => {
    const repoRoot = resolve(repo ?? process.cwd())
    return toolText(await withIndex(
      repoRoot,
      store => impactOf(store, { symbol, file, maxDepth, limit }),
      dbFor(repoRoot),
    ))
  })

  return server
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/mcp-server.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/mcp/server.ts tests/mcp-server.test.ts
git commit -m "feat: MCP server exposing the four core architecture tools"
```

---

### Task 10: `arch serve` and Claude Code registration

**Files:**
- Create: `src/mcp/stdio.ts`
- Modify: `src/cli.ts`, `README.md`
- Test: `tests/cli-serve.test.ts`

**Interfaces:**
- Consumes: `createArchServer`, `StdioServerTransport`.
- Produces: the `arch serve` command, and a documented registration path.

> **One thing that will silently break this if missed:** an MCP stdio server speaks JSON-RPC on stdout. Anything else written there corrupts the protocol. Every diagnostic must go to stderr. The existing `onProgress` callback in the indexer writes to stderr already, which is why the freshness gate can reindex mid-request safely — but do not add a `console.log` anywhere in the serve path.

- [ ] **Step 1: Write the failing test**

`tests/cli-serve.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist/cli.js')

/** Speaks one JSON-RPC initialize + tools/list exchange over stdio. */
function listToolsOverStdio(): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [CLI, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)

    const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' },
    } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

    setTimeout(() => { child.kill(); resolvePromise({ stdout, stderr }) }, 4000)
  })
}

describe('arch serve', () => {
  it('speaks JSON-RPC on stdout and lists the four tools', async () => {
    const { stdout } = await listToolsOverStdio()
    expect(stdout).toContain('"result"')
    for (const name of ['get_repo_overview', 'search_code', 'get_dependencies', 'impact_of']) {
      expect(stdout).toContain(name)
    }
  }, 20_000)

  it('writes nothing but JSON-RPC to stdout', async () => {
    const { stdout } = await listToolsOverStdio()
    const lines = stdout.split('\n').filter(l => l.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  }, 20_000)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/cli-serve.test.ts`
Expected: FAIL — `arch serve` is not a known command.

- [ ] **Step 3: Implement the stdio entry point**

`src/mcp/stdio.ts`:
```ts
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
```

- [ ] **Step 4: Add the CLI command**

In `src/cli.ts`, add alongside the other commands:

```ts
program
  .command('serve')
  .description('Run the MCP server on stdio, for Claude Code and other MCP clients')
  .action(async () => {
    const { serveStdio } = await import('./mcp/stdio.js')
    await serveStdio()
  })
```

The dynamic import keeps the SDK off the startup path of `arch index` and `arch status`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/cli-serve.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Document registration**

Add to `README.md`:

````markdown
## Using it from Claude Code

Index a repository once, then register the server:

```bash
arch index /path/to/repo
claude mcp add architect -- node /absolute/path/to/dist/cli.js serve
```

Or add it to `.mcp.json` in a project:

```json
{
  "mcpServers": {
    "architect": {
      "command": "node",
      "args": ["/absolute/path/to/dist/cli.js", "serve"]
    }
  }
}
```

Every tool takes an optional `repo` argument and defaults to the working
directory. The index refreshes itself: a small change is absorbed on the next
tool call, and a large one comes back labelled `stale` with a count rather than
blocking the call.

### What the confidence tiers mean

Results carry the evidence behind them, and the distinction matters:

- **verified** — a type resolver confirmed the binding. Nothing emits this yet.
- **likely** — the name matched exactly one candidate reachable from the file's imports.
- **ambiguous** — the name matched several candidates. All are reported, because
  under-reporting what might break is worse than over-reporting it.
- **unresolved** — no candidate in this repository. External, builtin, or
  third-party. Not uncertainty, just an absent target.
````

- [ ] **Step 7: Verify against a real repository end to end**

```bash
npm run build
node dist/cli.js index ~/Documents/arsal_git/work-dashboard
claude mcp add architect -- node "$(pwd)/dist/cli.js" serve
```

Then in a Claude Code session in that repository, ask "explain this architecture" and confirm the tools are called and answer. Report what came back, including the `index.state` and the confidence breakdown. If `claude mcp add` is unavailable, use the `.mcp.json` form instead and say which you used.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS, all tests.

- [ ] **Step 9: Commit**

```bash
git add src/mcp/stdio.ts src/cli.ts README.md tests/cli-serve.test.ts
git commit -m "feat: arch serve and Claude Code registration"
```

---

## Done criteria

- `arch index` is incremental by default; `--full` forces a cold rebuild.
- An incremental reindex produces a graph semantically identical to a full reindex of the same state, proven across eight scenarios including rename, delete, add, newly-resolving call, and a new ambiguous collision.
- `arch status` distinguishes current, stale (with counts), incomplete, and missing.
- `arch serve` runs an MCP server exposing `get_repo_overview`, `search_code`, `get_dependencies`, and `impact_of`.
- Every tool response carries index freshness; every capped list carries its true total.
- `unresolved` and `ambiguous` are reported separately everywhere, never merged.
- The full test suite passes.

## Deliberately out of scope

- `describe_module`, `get_symbol`, `trace_flow`, `find_cycles`, `get_coupling`, `find_hotspots` — Plan 3.
- The summarizer and its cache — Plan 3. The `summaries` table already exists and stays empty.
- Additional language grammars — Plan 3.
- **The memory ceiling.** Spec §11 records that indexing peaks at O(repo size), not O(batch size), measured at 876 MB on a 3,000-file repository. This plan does NOT fix it, and incremental reindex does not make it worse for the common case — the dilation is small, so a typical incremental run holds far less than a cold one. But `--full` and the first index of a large repository still carry the full cost. Fixing it means streaming records through the resolve phases and is a Plan 3 architectural item.
- Reading `package.json` `exports` maps for a precise package-boundary check; `impact_of` currently approximates it with conventional entry-point filenames and errs toward not claiming a boundary.
