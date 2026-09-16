import { describe, it, expect } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { runIncrementalIndex } from '../src/indexer/incremental.js'
import { GraphStore } from '../src/store/graph-store.js'
import { canonicalGraph } from './graph-snapshot.js'

/**
 * task-6-fixes.md's same-directory candidate mechanism (src/indexer/
 * same-package.ts) is exercised end-to-end by parser-go.test.ts and
 * parser-java.test.ts's fixtures, but neither proves the INCREMENTAL path
 * stays correct -- and it is genuinely at risk here specifically: a call
 * between two same-package sibling files carries no import edge for
 * `filesImporting`'s existing dilation walk to ever discover. Without the
 * matching widening added to incremental.ts, adding a new sibling file that
 * defines a name an EXISTING, UNCHANGED file already calls would correctly
 * resolve on a full cold index but silently stay `unresolved` after an
 * incremental one, until the next full rebuild -- a real, silent
 * incremental/full divergence, not a cosmetic one.
 */
function writeFixture(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
}

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'arch-samepkg-inc-')), 'index.db')
}

describe('same-package resolution stays correct under incremental indexing', () => {
  it('go: an EXISTING, unchanged caller resolves once a new sibling file defines the callee', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-samepkg-go-'))
    writeFixture(root, {
      'go.mod': 'module example.com/single\n\ngo 1.22\n',
      // `two.go` calls `help`, which does not exist yet -- an unresolved
      // edge at first, on purpose, and left UNTOUCHED for the rest of this
      // test: it is `one.go` that gets added, never `two.go` itself.
      'single/two.go': 'package single\n\nfunc Combine(n int) int {\n\treturn help(n)\n}\n',
    })
    const dbPath = freshDb()
    await runColdIndex({ repoRoot: root, dbPath })

    const before = GraphStore.open(dbPath)
    const beforeEdge = before.allEdgeDetails().find(e => e.dstName === 'help')!
    before.close()
    expect(beforeEdge.confidence).toBe('unresolved')

    // `two.go` is NOT rewritten -- only a new sibling file is added, in the
    // same directory, same package, no import. This is the exact case the
    // incremental dilation widening exists for: `two.go` did not change, so
    // nothing about it looks dirty to the ordinary changed-file walk.
    writeFixture(root, {
      'single/one.go': 'package single\n\nfunc help(n int) int {\n\treturn n + 1\n}\n',
    })
    await runIncrementalIndex({ repoRoot: root, dbPath })

    const after = GraphStore.open(dbPath)
    try {
      const afterEdge = after.allEdgeDetails().find(e => e.dstName === 'help')!
      expect(afterEdge.confidence).toBe('heuristic')
      expect(afterEdge.dstPath).toBe('single/one.go')

      const incrementalSnapshot = canonicalGraph(after)
      const coldDb = freshDb()
      await runColdIndex({ repoRoot: root, dbPath: coldDb })
      const cold = GraphStore.open(coldDb)
      try {
        expect(incrementalSnapshot).toBe(canonicalGraph(cold))
      } finally {
        cold.close()
      }
    } finally {
      after.close()
    }
  })

  it('java: an EXISTING, unchanged caller resolves once a new sibling class defines the callee', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-samepkg-java-'))
    writeFixture(root, {
      // `Worker` calls `Helper.internal`, which does not exist yet -- no
      // import either way, since same-package Java needs none. `Worker` is
      // left UNTOUCHED for the rest of the test.
      'src/main/java/com/example/Worker.java':
        'package com.example;\n\npublic class Worker {\n' +
        '  public int run(int n) { return Helper.internal(n); }\n}\n',
    })
    const dbPath = freshDb()
    await runColdIndex({ repoRoot: root, dbPath })

    const before = GraphStore.open(dbPath)
    const beforeEdge = before.allEdgeDetails().find(e => e.dstName === 'internal')!
    before.close()
    expect(beforeEdge.confidence).toBe('unresolved')

    writeFixture(root, {
      'src/main/java/com/example/Helper.java':
        'package com.example;\n\npublic class Helper {\n' +
        '  static int internal(int n) { return n - 1; }\n}\n',
    })
    await runIncrementalIndex({ repoRoot: root, dbPath })

    const after = GraphStore.open(dbPath)
    try {
      const afterEdge = after.allEdgeDetails().find(e => e.dstName === 'internal')!
      expect(afterEdge.confidence).toBe('heuristic')
      expect(afterEdge.dstPath).toBe('src/main/java/com/example/Helper.java')

      const incrementalSnapshot = canonicalGraph(after)
      const coldDb = freshDb()
      await runColdIndex({ repoRoot: root, dbPath: coldDb })
      const cold = GraphStore.open(coldDb)
      try {
        expect(incrementalSnapshot).toBe(canonicalGraph(cold))
      } finally {
        cold.close()
      }
    } finally {
      after.close()
    }
  })
})
