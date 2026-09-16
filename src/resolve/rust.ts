import type { ImportResolver, ResolvedImport } from './index.js'

const UNRESOLVED: ResolvedImport = { path: null, confidence: 'unresolved' }

/**
 * Names that terminate a file's own module directory: a file with one of
 * these basenames is the "root" of the directory it sits in, so its module
 * directory is that same directory rather than a subdirectory named after
 * the file (see `moduleDirOf` below — Task 5 ruling 7).
 */
const MODULE_ROOT_BASENAMES = new Set(['mod.rs', 'lib.rs', 'main.rs'])

/**
 * The module DIRECTORY a file belongs to — not simply its containing
 * directory. A `mod.rs`/`lib.rs`/`main.rs` file's own directory already IS
 * its module's directory (`src/deep/mod.rs` is module `crate::deep`, whose
 * directory is `src/deep`). Any other file, e.g. `src/deep/inner.rs`
 * (module `crate::deep::inner`), has its OWN synthetic subdirectory named
 * after the file (`src/deep/inner`) — that is where a child module of
 * `inner` would live (`src/deep/inner/foo.rs` for `mod foo;` inside
 * `inner.rs`), and it is what `self::` and `super::` must resolve against.
 *
 * This distinction is the crux of ruling 7: treating `super::` as "one
 * directory up from the FILE" instead of "the parent of the file's MODULE
 * directory" gives the same answer for a `mod.rs` file (its module
 * directory already is its file directory) but a WRONG answer for every
 * other file, where the file directory and the module directory differ by
 * one segment.
 */
function moduleDirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  const dir = cut === -1 ? '' : path.slice(0, cut)
  const base = cut === -1 ? path : path.slice(cut + 1)
  if (MODULE_ROOT_BASENAMES.has(base)) return dir
  const stem = base.replace(/\.rs$/, '')
  return dir.length > 0 ? `${dir}/${stem}` : stem
}

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

function parentDirOf(dir: string): string {
  const cut = dir.lastIndexOf('/')
  return cut === -1 ? '' : dir.slice(0, cut)
}

/**
 * Every directory, across the whole indexed path set, that directly
 * contains a `main.rs` or `lib.rs` — i.e. every crate root a workspace (or
 * an ordinary Cargo layout with a `src/bin/<name>/main.rs` binary target)
 * can contain. Computed once per `knownPaths` identity and cached, since a
 * fresh scan of every indexed path on every `resolve()` call would be
 * O(files x imports) on a large repo — the same reasoning as `go.ts`'s
 * `go.mod`-prefix cache, just keyed by the path-set object instead of a
 * repo root string (there is no single file to read here; the "root" is
 * discovered by scanning the index itself).
 */
const crateRootDirsCache = new WeakMap<Set<string>, Set<string>>()

function crateRootDirsFrom(knownPaths: Set<string>): Set<string> {
  let cached = crateRootDirsCache.get(knownPaths)
  if (cached) return cached

  cached = new Set<string>()
  for (const path of knownPaths) {
    const cut = path.lastIndexOf('/')
    const base = cut === -1 ? path : path.slice(cut + 1)
    if (base === 'main.rs' || base === 'lib.rs') cached.add(cut === -1 ? '' : path.slice(0, cut))
  }
  crateRootDirsCache.set(knownPaths, cached)
  return cached
}

/**
 * The crate root for `crate::` paths, resolved PER IMPORTING FILE rather
 * than once globally.
 *
 * The naive "first `main.rs`/`lib.rs` found while scanning the whole index"
 * is wrong two ways at once: in a Cargo workspace it can resolve a
 * `crate::` path from one member crate into a completely different
 * sibling crate (a confident wrong answer across a crate boundary), and
 * because `Set` iteration order follows insertion order, which crate wins
 * is non-deterministic across cold vs. incremental indexing runs that
 * build the path set differently.
 *
 * The correct rule: walk upward from the importing file's own directory
 * and take the NEAREST ancestor directory that is a crate root. This
 * naturally scopes `crate::` to the importing file's own crate (a
 * workspace member's own `src/lib.rs`, or a `src/bin/<name>/main.rs`
 * binary target, which is correctly its own crate root under real Cargo
 * semantics) without needing to know the workspace layout in advance.
 * Falls back to `src` only when the walk finds no crate root at all.
 */
function crateRootDirFor(fromPath: string, knownPaths: Set<string>): string {
  const roots = crateRootDirsFrom(knownPaths)
  let dir = dirnameOf(fromPath)
  for (;;) {
    if (roots.has(dir)) return dir
    if (dir === '') return 'src'
    dir = parentDirOf(dir)
  }
}

/**
 * NAMED ASSUMPTION (fix round 2, documented rather than fixed — both are
 * real, both are rare, and fixing either properly means reading Cargo.toml
 * target declarations rather than inferring from `main.rs`/`lib.rs`
 * filenames alone):
 *
 * 1. This treats ANY directory containing an indexed `main.rs`/`lib.rs` as
 *    a crate root, with no way to tell a genuine Cargo target root (`src/`,
 *    `src/bin/<name>/`, `examples/<name>/`, `tests/<name>/`) from a
 *    same-named file that merely happens to sit somewhere else — e.g.
 *    `mod main;` inside `src/foo/` makes `src/foo` look like a target root,
 *    so `src/foo/bar.rs`'s `crate::helper` would resolve to
 *    `src/foo/helper.rs` instead of the real crate root's `src/helper.rs`.
 *    The real fix is reading Cargo.toml's declared `[[bin]]`/`[lib]` paths.
 * 2. A single-file bin target (`src/bin/other.rs`, no subdirectory) is
 *    walked past on the way up to `src/lib.rs`, so it is wrongly treated as
 *    part of the library crate rather than its own crate — its `crate::`
 *    should refer to itself. Rare in practice (a single-file bin normally
 *    reaches the library via its crate name, e.g. `mycrate::`, not
 *    `crate::`), and the real fix again requires reading Cargo.toml to know
 *    `src/bin/*.rs` files are each their own crate root regardless of
 *    whether they contain a `main.rs`-shaped file at all.
 *
 * Both are wrong `resolved` answers rather than missing edges, which err on
 * the more damaging side per-occurrence — but neither has been observed to
 * matter for the missing-edge problem this resolver otherwise exists to
 * fix, so they are recorded here rather than attempted.
 */

/**
 * The crate root FILE for a directory already known to be a crate root
 * (`crateRootDirsFrom` membership) — `lib.rs` preferred over `main.rs`.
 *
 * This is not run through the `matches.length > 1` ambiguity check `resolve`
 * uses for the `<path>.rs`-vs-`<path>/mod.rs` collision: unlike that case,
 * `lib.rs` and `main.rs` coexisting in the same directory is ordinary,
 * *valid* Cargo (a package with both a library and its default binary
 * target sharing `src/`) rather than a compile error, and preferring the
 * library target is a deliberate, simple default rather than a coin flip
 * between two equally-valid answers.
 */
function crateRootFileCandidates(dir: string): string[] {
  const prefix = dir.length > 0 ? `${dir}/` : ''
  return [`${prefix}lib.rs`, `${prefix}main.rs`]
}

/**
 * The two on-disk forms one module path can take: `<path>.rs` (a plain
 * module file) or `<path>/mod.rs` (a module with its own submodules). Both
 * are legal for the same module path — `mod foo;` can be satisfied by
 * either — so both are checked; `resolve` below decides what to do when
 * BOTH happen to be indexed at once (see the `ambiguous` handling there).
 */
function candidatesFor(modulePath: string): string[] {
  return [`${modulePath}.rs`, `${modulePath}/mod.rs`]
}

/**
 * Rust import resolution against the indexed path set, following the
 * module tree rather than the filesystem directly.
 *
 * A `use` path names an ITEM, not necessarily a module: `use
 * crate::helper::help` names the function `help` inside module `helper`.
 * Since the resolver cannot tell from the path alone whether the last
 * segment is a module or an item, it tries the full path as a module first
 * (longer form, so a real `crate::helper::helper` module is not shadowed by
 * a coincidental shorter match), then the path with its last segment
 * dropped. This item-drop fallback does NOT apply to a `::*` glob import
 * (see below) — a glob names a module, definitively, never an item.
 *
 * `crate::` starts at the importing file's own crate root (see
 * `crateRootDirFor` — resolved per file, not globally, to stay correct in
 * a workspace). `self::` is the importing file's own module directory;
 * `super::` is one level above it — both via `moduleDirOf`, which is NOT
 * simply "the file's containing directory" (see its own doc comment). A
 * leading segment that is none of `crate`, `self` or `super` names an
 * external crate (std or third-party) and is `unresolved` immediately —
 * there is nothing in this repository it could ever resolve to.
 *
 * A trailing `::*` (a glob `use`) is stripped explicitly before the rest of
 * the path is resolved — this grammar's `use_wildcard` capture carries the
 * literal `*` in its text (unlike Java, whose grammar drops it before
 * capture). The strip and the item-drop fallback above are NOT combined:
 * doing both would drop two segments, so `crate::deep::missing::*` would
 * wrongly resolve to the PARENT of a module (`deep`) that itself exists,
 * even though the module the glob actually names (`deep::missing`) does
 * not. A glob's remainder is tried as a module path exactly once.
 *
 * Two indexed files can legitimately share one module path — `<path>.rs`
 * and `<path>/mod.rs` both satisfying the same `mod foo;` is a Rust compile
 * error, but this index reflects what is on disk, not what compiles (a
 * repo mid-refactor can have both). When both are indexed, that is genuine
 * ambiguity — several candidates matched — and is reported as `ambiguous`
 * with the lexicographically first path, for the same determinism reason
 * `crateRootDirFor` cares about ordering. This is distinct from the
 * full-path-vs-item-drop choice above, which is never ambiguous: with both
 * `src/helper.rs` and `src/helper/help.rs` indexed, `crate::helper::help`
 * genuinely means the `help` submodule, and longer-first is simply correct,
 * not merely first-matched.
 *
 * A crate-relative path can also name an item defined directly IN the crate
 * root — `use crate::Thing;` (or a `crate::*` glob) — one of the most common
 * `use` forms in real Rust. Ordinary candidates (`<path>.rs` /
 * `<path>/mod.rs`) never match this: dropping `Thing` as an item leaves an
 * EMPTY module portion, and there is no file named after the crate root
 * DIRECTORY itself (`src.rs` is not a thing). Fix round 2: whenever an
 * attempt's module portion is empty and the resulting directory is a known
 * crate root, the target is that crate's root file (`crateRootFileCandidates`)
 * instead of the ordinary directory-named candidates.
 */
export const rustResolver: ImportResolver = {
  id: 'rust',

  resolve(fromPath: string, specifier: string, knownPaths: Set<string>, _repoRoot: string): ResolvedImport {
    const isGlob = specifier.endsWith('::*')
    const stripped = isGlob ? specifier.slice(0, -3) : specifier
    const segments = stripped.split('::').filter(s => s.length > 0)
    if (segments.length === 0) return UNRESOLVED

    const [head, ...rest] = segments
    let baseDir: string
    if (head === 'crate') {
      baseDir = crateRootDirFor(fromPath, knownPaths)
    } else if (head === 'self') {
      baseDir = moduleDirOf(fromPath)
    } else if (head === 'super') {
      baseDir = parentDirOf(moduleDirOf(fromPath))
    } else {
      // An external crate: nothing indexed could ever be its target.
      return UNRESOLVED
    }

    // A glob names a module, definitively: try the full remaining path
    // exactly once. Otherwise the last segment may be an item, not a
    // module, so try the full path first (longer form), then with its
    // last segment dropped.
    const attempts = isGlob || rest.length === 0 ? [rest] : [rest, rest.slice(0, -1)]
    for (const attempt of attempts) {
      // Fix round 2: an empty module portion means the whole specifier was
      // consumed as an item (or, for a glob, that the path is bare
      // `crate::`/`self::`) — the item is defined directly in `baseDir`'s
      // OWN file. For an ordinary module directory that file is
      // `<dir>.rs`/`<dir>/mod.rs` (handled below, unchanged); for a crate
      // root directory it is `lib.rs`/`main.rs` instead, which is why this
      // is checked before falling through to the generic candidates.
      if (attempt.length === 0 && crateRootDirsFrom(knownPaths).has(baseDir)) {
        for (const candidate of crateRootFileCandidates(baseDir)) {
          if (knownPaths.has(candidate)) return { path: candidate, confidence: 'resolved' }
        }
        continue
      }

      const modulePath = [baseDir, ...attempt].filter(s => s.length > 0).join('/')
      if (modulePath.length === 0) continue

      const matches = candidatesFor(modulePath).filter(candidate => knownPaths.has(candidate))
      if (matches.length === 0) continue
      if (matches.length > 1) return { path: [...matches].sort()[0], confidence: 'ambiguous' }
      return { path: matches[0], confidence: 'resolved' }
    }
    return UNRESOLVED
  },
}
