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

  it('go: an EXISTING, unchanged caller resolves once a LATER-sorting sibling defines the callee (task-6-fixes-round2.md, Fix 3)', async () => {
    // A Go import row can only ever record ONE file (the first by sorted
    // path), but call resolution considers every file sharing that
    // directory. Adding a file that sorts AFTER the existing first file
    // never changes which file the import itself resolves to, so this
    // exercises a dilation path the plain resolved-import-recompute
    // widening cannot: `main.go`'s import of `multi` stays resolved to
    // `aaa.go` throughout, yet its CALL to `multi.MultiFn` must still pick
    // up `zzz.go` once that file appears.
    const root = mkdtempSync(join(tmpdir(), 'arch-samepkg-go-multi-'))
    // Module named "example.com/app", deliberately DIFFERENT from the
    // "multi" package directory name: naming them the same (an earlier
    // draft of this test did) makes the import specifier equal the module
    // prefix itself, which goResolver resolves to the ROOT directory, not
    // `multi/` -- a self-inflicted collision, not the case under test.
    writeFixture(root, {
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      'multi/aaa.go': 'package multi\n\nfunc Unrelated() int {\n\treturn 0\n}\n',
      // `main.go` is NOT rewritten for the rest of this test -- only a new
      // sibling file is added, later in sort order, in the SAME package.
      'main.go':
        'package main\n\nimport "example.com/app/multi"\n\n' +
        'func main() {\n\tmulti.MultiFn(1)\n}\n',
    })
    const dbPath = freshDb()
    await runColdIndex({ repoRoot: root, dbPath })

    const before = GraphStore.open(dbPath)
    const beforeEdge = before.allEdgeDetails().find(e => e.dstName === 'MultiFn')!
    before.close()
    expect(beforeEdge.confidence).toBe('unresolved')

    writeFixture(root, {
      'multi/zzz.go': 'package multi\n\nfunc MultiFn(n int) int {\n\treturn n + 1\n}\n',
    })
    await runIncrementalIndex({ repoRoot: root, dbPath })

    const after = GraphStore.open(dbPath)
    try {
      // The import row itself stays pointed at aaa.go -- unaffected, and
      // deliberately asserted so a regression that changed goResolver's
      // own "first file" choice would be caught here too, distinctly from
      // the call-resolution assertion below.
      const mainId = after.fileIdByPath('main.go')!
      const aaaId = after.fileIdByPath('multi/aaa.go')!
      const resolvedImport = after.importsForFile(mainId).find(i => i.rawSpecifier === 'example.com/app/multi')!
      expect(resolvedImport.resolvedFileId).toBe(aaaId)

      const afterEdge = after.allEdgeDetails().find(e => e.dstName === 'MultiFn')!
      expect(afterEdge.confidence).toBe('heuristic')
      expect(afterEdge.dstPath).toBe('multi/zzz.go')
      expect(afterEdge.srcPath).toBe('main.go')

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

/**
 * final-fixes.md item 1. The two describes above cover Go and Java, the only
 * two SAME_PACKAGE_LANGS -- but the incremental-vs-full equality invariant is
 * not a same-package property, and Python and Rust had NO incremental
 * coverage at all. These two tests add it, and the Rust one is deliberately
 * the confidence-drift scenario: it is red before incremental.ts compares
 * `(path, confidence)` rather than the resolved path alone.
 */
describe('incremental indexing matches a full index for Python and Rust', () => {
  it('rust: an added file that makes an UNCHANGED importer AMBIGUOUS dilates that importer', async () => {
    // `src/helper.rs` and `src/helper/mod.rs` both satisfy the module path
    // `crate::helper`, which rustResolver reports as `ambiguous` (see
    // src/resolve/rust.ts) with the lexicographically-first path. And
    // 'src/helper.rs' < 'src/helper/mod.rs' ('.' 46 < '/' 47), so the
    // WINNING PATH IS UNCHANGED by the addition -- only the confidence
    // moves, from `resolved` to `ambiguous`. An incremental dilation check
    // that compares the recomputed path alone therefore sees no change and
    // never re-resolves `service.rs`, leaving the index claiming `resolved`
    // where a full build says `ambiguous`: a confident wrong answer that
    // only a full rebuild corrects.
    const root = mkdtempSync(join(tmpdir(), 'arch-rs-inc-'))
    writeFixture(root, {
      'src/lib.rs': 'pub mod helper;\npub mod service;\n',
      'src/helper.rs': 'pub fn help(n: i32) -> i32 {\n    n + 1\n}\n',
      // `service.rs` is NOT rewritten anywhere below -- it is the unchanged
      // importer whose recorded confidence must still be corrected.
      'src/service.rs':
        'use crate::helper::help;\n\npub fn place(n: i32) -> i32 {\n    help(n)\n}\n',
    })
    const dbPath = freshDb()
    await runColdIndex({ repoRoot: root, dbPath })

    const before = GraphStore.open(dbPath)
    const beforeImport = before.importsForFile(before.fileIdByPath('src/service.rs')!)
      .find(i => i.rawSpecifier === 'crate::helper::help')!
    before.close()
    expect(beforeImport.confidence).toBe('resolved')

    writeFixture(root, { 'src/helper/mod.rs': 'pub fn help(n: i32) -> i32 {\n    n + 2\n}\n' })
    await runIncrementalIndex({ repoRoot: root, dbPath })

    const after = GraphStore.open(dbPath)
    try {
      const serviceId = after.fileIdByPath('src/service.rs')!
      const afterImport = after.importsForFile(serviceId).find(i => i.rawSpecifier === 'crate::helper::help')!
      // The PATH is deliberately asserted to be unchanged alongside the
      // confidence: it is precisely because the path does not move that a
      // path-only comparison misses this.
      expect(after.pathsById().get(afterImport.resolvedFileId!)).toBe('src/helper.rs')
      expect(afterImport.confidence).toBe('ambiguous')

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

  it('python: an added module file that SHADOWS a package directory re-points an unchanged importer', async () => {
    // pythonResolver tries `<dotted>.py` before `<dotted>/__init__.py`, so
    // adding `pkg.py` next to an existing `pkg/` package moves `import pkg`
    // off `pkg/__init__.py` and onto `pkg.py` -- for an importer that did
    // not itself change.
    const root = mkdtempSync(join(tmpdir(), 'arch-py-inc-'))
    writeFixture(root, {
      'pkg/__init__.py': 'def helper(n):\n    return n + 1\n',
      // `main.py` is NOT rewritten below.
      'main.py': 'import pkg\n\n\ndef run():\n    return pkg.helper(2)\n',
    })
    const dbPath = freshDb()
    await runColdIndex({ repoRoot: root, dbPath })

    const before = GraphStore.open(dbPath)
    const beforeEdge = before.allEdgeDetails().find(e => e.dstName === 'helper')!
    before.close()
    expect(beforeEdge.dstPath).toBe('pkg/__init__.py')

    writeFixture(root, { 'pkg.py': 'def helper(n):\n    return n + 5\n' })
    await runIncrementalIndex({ repoRoot: root, dbPath })

    const after = GraphStore.open(dbPath)
    try {
      const mainId = after.fileIdByPath('main.py')!
      const afterImport = after.importsForFile(mainId).find(i => i.rawSpecifier === 'pkg')!
      expect(after.pathsById().get(afterImport.resolvedFileId!)).toBe('pkg.py')
      expect(afterImport.confidence).toBe('resolved')

      const afterEdge = after.allEdgeDetails().find(e => e.dstName === 'helper')!
      expect(afterEdge.dstPath).toBe('pkg.py')

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
