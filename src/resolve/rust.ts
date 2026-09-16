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

function parentDirOf(dir: string): string {
  const cut = dir.lastIndexOf('/')
  return cut === -1 ? '' : dir.slice(0, cut)
}

/**
 * The crate root directory: the directory containing an indexed `main.rs`
 * or `lib.rs`, derived from the indexed paths rather than assumed to be
 * `src` — a workspace member or an unusual layout still resolves this way.
 * Falls back to `src` when neither is indexed (e.g. a crate root file was
 * excluded from the index, or a fixture that never wrote one).
 */
function crateRootDir(knownPaths: Set<string>): string {
  for (const path of knownPaths) {
    const cut = path.lastIndexOf('/')
    const base = cut === -1 ? path : path.slice(cut + 1)
    if (base === 'main.rs' || base === 'lib.rs') return cut === -1 ? '' : path.slice(0, cut)
  }
  return 'src'
}

/**
 * Tries a module directory's two possible on-disk forms — `<dir>.rs` and
 * `<dir>/mod.rs` — as well as `<dir>` itself joined onto a segment list is
 * not something this function does; it purely renders one already-joined
 * module path into its two candidate files.
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
 * dropped.
 *
 * `crate::` starts at the crate root (derived from indexed `main.rs`/
 * `lib.rs`, see `crateRootDir`). `self::` is the importing file's own
 * module directory; `super::` is one level above it — both via
 * `moduleDirOf`, which is NOT simply "the file's containing directory" (see
 * its own doc comment). A leading segment that is none of `crate`, `self`
 * or `super` names an external crate (std or third-party) and is
 * `unresolved` immediately — there is nothing in this repository it could
 * ever resolve to.
 *
 * A trailing `::*` (a glob `use`) is stripped explicitly before the rest of
 * the path is resolved as an ordinary module path — this grammar's
 * `use_wildcard` capture carries the literal `*` in its text (unlike Java,
 * whose grammar drops it before capture), so it must be handled on purpose
 * rather than accidentally falling out of the "drop the last segment"
 * item-vs-module logic.
 */
export const rustResolver: ImportResolver = {
  id: 'rust',

  resolve(fromPath: string, specifier: string, knownPaths: Set<string>, _repoRoot: string): ResolvedImport {
    const stripped = specifier.endsWith('::*') ? specifier.slice(0, -3) : specifier
    const segments = stripped.split('::').filter(s => s.length > 0)
    if (segments.length === 0) return UNRESOLVED

    const [head, ...rest] = segments
    let baseDir: string
    if (head === 'crate') {
      baseDir = crateRootDir(knownPaths)
    } else if (head === 'self') {
      baseDir = moduleDirOf(fromPath)
    } else if (head === 'super') {
      baseDir = parentDirOf(moduleDirOf(fromPath))
    } else {
      // An external crate: nothing indexed could ever be its target.
      return UNRESOLVED
    }

    // Try the full remaining path as a module first (longer form), then
    // with its last segment dropped (the item-vs-module ambiguity).
    const attempts = rest.length > 0 ? [rest, rest.slice(0, -1)] : [rest]
    for (const attempt of attempts) {
      const modulePath = [baseDir, ...attempt].filter(s => s.length > 0).join('/')
      if (modulePath.length === 0) continue
      for (const candidate of candidatesFor(modulePath)) {
        if (knownPaths.has(candidate)) return { path: candidate, confidence: 'resolved' }
      }
    }
    return UNRESOLVED
  },
}
