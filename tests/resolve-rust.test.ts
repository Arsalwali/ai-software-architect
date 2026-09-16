import { describe, it, expect } from 'vitest'
import { rustResolver } from '../src/resolve/rust.js'

// `src/deep/helper.rs` is present (unlike the brief's original known set)
// specifically so the `super::` test below can distinguish "parent MODULE"
// from "one directory up from the file" — see task-5-rulings.md Ruling 6.
const known = new Set([
  'src/main.rs', 'src/helper.rs', 'src/service.rs',
  'src/deep/mod.rs', 'src/deep/inner.rs', 'src/deep/helper.rs',
])
const r = (from: string, spec: string) => rustResolver.resolve(from, spec, known, '/repo')

describe('rustResolver', () => {
  it('resolves a crate path naming an item, dropping the item segment', () => {
    expect(r('src/service.rs', 'crate::helper::help'))
      .toEqual({ path: 'src/helper.rs', confidence: 'resolved' })
  })

  it('resolves a crate path naming a module directly', () => {
    expect(r('src/main.rs', 'crate::helper').path).toBe('src/helper.rs')
    expect(r('src/main.rs', 'crate::helper').confidence).toBe('resolved')
  })

  it('resolves a module directory to its mod.rs', () => {
    expect(r('src/main.rs', 'crate::deep').path).toBe('src/deep/mod.rs')
  })

  it('resolves a self path against the current module', () => {
    expect(r('src/deep/mod.rs', 'self::inner').path).toBe('src/deep/inner.rs')
    expect(r('src/deep/mod.rs', 'self::inner').confidence).toBe('resolved')
  })

  // Ruling 6: the brief's version of this test asserted `toBeTruthy()` on the
  // returned OBJECT, which is truthy regardless of what it contains and so
  // passes even against a stubbed-out resolver. It was also semantically
  // wrong: `src/deep/inner.rs` is module `crate::deep::inner`, so `super`
  // is `crate::deep`, and `super::helper` names `crate::deep::helper` ->
  // `src/deep/helper.rs` — NOT `src/helper.rs` (a different module,
  // `crate::helper`). The second assertion below is the one with teeth: a
  // resolver that treats `super::` as "one directory up from the FILE"
  // instead of "the parent MODULE" would wrongly land on `src/helper.rs`.
  it('resolves a super path against the parent module, not merely the parent directory', () => {
    expect(r('src/deep/inner.rs', 'super::helper').path).toBe('src/deep/helper.rs')
    expect(r('src/deep/inner.rs', 'super::helper').path).not.toBe('src/helper.rs')
    expect(r('src/deep/inner.rs', 'super::helper').confidence).toBe('resolved')
  })

  // Ruling 7's mod.rs-vs-plain-file distinction: `src/service.rs`'s module
  // directory is `src/service` (a plain file, not mod.rs/lib.rs/main.rs), so
  // its parent module directory is `src`, landing on `src/helper.rs`. A
  // `mod.rs` file's OWN directory already IS its module directory, so
  // `src/deep/mod.rs`'s super lands on the very same `src/helper.rs` by a
  // different route. Both must agree, or the mod.rs branch is fake.
  it('resolves super consistently whether the importing file is mod.rs or a plain module file', () => {
    expect(r('src/service.rs', 'super::helper').path).toBe('src/helper.rs')
    expect(r('src/deep/mod.rs', 'super::helper').path).toBe('src/helper.rs')
  })

  // Fix round 1, item 2: Ruling 5's "strip ::* then fall through to the
  // ordinary item-drop logic" was wrong — the strip and the item-drop
  // fallback are the SAME operation, so a glob would silently drop TWO
  // segments. The old single-case test (`crate::deep::*` -> `src/deep/mod.rs`)
  // could not catch this: with the bug present, the fallback drops `deep`
  // right back to the same answer by accident. This pair differs only by
  // `::*` and only passes when the glob is handled as "resolve the
  // remainder as a module path ONCE, no item-drop" — verified by reverting
  // the glob special-case locally and confirming the second assertion goes
  // red (both then resolve to `src/deep/mod.rs`).
  it('resolves an item name under a module but reports its glob-import sibling as unresolved', () => {
    // `missing` is treated as an ITEM inside module `deep` (no
    // `src/deep/missing.rs` exists, so the item-drop fallback lands on
    // `deep` itself) — correct, ordinary `use` semantics.
    expect(r('src/main.rs', 'crate::deep::missing').path).toBe('src/deep/mod.rs')
    expect(r('src/main.rs', 'crate::deep::missing').confidence).toBe('resolved')

    // The identical path with a glob suffix names the MODULE
    // `deep::missing` directly, definitively — no item-drop applies, and
    // that module does not exist, so this must be unresolved rather than
    // silently landing on `deep`'s own mod.rs.
    expect(r('src/main.rs', 'crate::deep::missing::*').path).toBeNull()
    expect(r('src/main.rs', 'crate::deep::missing::*').confidence).toBe('unresolved')
  })

  it('resolves a glob import of an existing module (Ruling 5)', () => {
    expect(r('src/main.rs', 'crate::deep::*').path).toBe('src/deep/mod.rs')
    expect(r('src/main.rs', 'crate::deep::*').confidence).toBe('resolved')
  })

  it('reports an external crate as unresolved', () => {
    expect(r('src/main.rs', 'std::collections::HashMap'))
      .toEqual({ path: null, confidence: 'unresolved' })
    expect(r('src/main.rs', 'serde::Serialize').path).toBeNull()
    expect(r('src/main.rs', 'serde::Serialize').confidence).toBe('unresolved')
  })
})

// Fix round 1, item 1: `crate::` must resolve against the importing file's
// OWN crate root — the nearest ancestor directory containing an indexed
// `main.rs`/`lib.rs` — not the first one found anywhere in the index. Using
// a separate `known` set per test here (rather than the shared one above)
// keeps each workspace/bin-target layout unambiguous.
describe('rustResolver — crate root is scoped per importing file (fix round 1, item 1)', () => {
  const workspace = new Set([
    'crates/alpha/src/main.rs', 'crates/alpha/src/bar.rs',
    'crates/beta/src/lib.rs', 'crates/beta/src/foo.rs',
  ])

  it('does not resolve crate:: across a workspace member boundary', () => {
    // Updated for fix round 2: `bar` doesn't exist as a module inside
    // beta, so (per round 2's crate-root-item fallback) it is now treated
    // as an item defined directly in BETA's OWN crate root — beta's
    // `lib.rs`, never alpha's `bar.rs`. The isolation property this test
    // exists for (never resolving into the WRONG crate) still holds; only
    // the specific outcome changed from "unresolved" to "resolved, to
    // beta's own root" now that that fallback exists. The assertion with
    // teeth is the `.not.toBe` line: the pre-round-2 bug this test was
    // originally written for would have returned alpha's `bar.rs`.
    const result = rustResolver.resolve('crates/beta/src/foo.rs', 'crate::bar', workspace, '/repo')
    expect(result.path).not.toBe('crates/alpha/src/bar.rs')
    expect(result.path).toBe('crates/beta/src/lib.rs')
    expect(result.confidence).toBe('resolved')
  })

  it('resolves crate:: within the importing file\'s own workspace member', () => {
    const result = rustResolver.resolve('crates/alpha/src/bar.rs', 'crate::bar', workspace, '/repo')
    // `crate::bar` from inside `bar.rs` itself names its own module file —
    // degenerate, but it proves alpha's root (not beta's) is what was used:
    // reaching this candidate at all requires baseDir === 'crates/alpha/src'.
    expect(result.path).toBe('crates/alpha/src/bar.rs')
    expect(result.confidence).toBe('resolved')
  })

  it('resolves crate:: from a Cargo bin target without being shadowed by the crate\'s own lib.rs (fix round 1, item 1)', () => {
    // Stock Cargo layout: `src/lib.rs` (the library crate root) plus a
    // `src/bin/mytool/main.rs` binary target (its OWN, separate crate
    // root). `crate::helper` from the BIN target must resolve against
    // `src/bin/mytool` first — there is no `helper.rs` there. Updated for
    // fix round 2: since `src/bin/mytool` IS itself a crate root (it
    // contains `main.rs`), `helper` now falls to that root's OWN file
    // (`src/bin/mytool/main.rs`) rather than staying unresolved — but the
    // assertion with teeth is unchanged and still the point of this test:
    // the old global-first-match bug resolved into `src/helper.rs`
    // (the library's, a DIFFERENT crate), which this must never do.
    const known = new Set(['src/lib.rs', 'src/helper.rs', 'src/bin/mytool/main.rs'])
    const result = rustResolver.resolve('src/bin/mytool/main.rs', 'crate::helper', known, '/repo')
    expect(result.path).not.toBe('src/helper.rs')
    expect(result.path).toBe('src/bin/mytool/main.rs')
    expect(result.confidence).toBe('resolved')
  })

  it('resolves crate:: from the library crate root itself, unaffected by a sibling bin target', () => {
    const known = new Set(['src/lib.rs', 'src/helper.rs', 'src/bin/mytool/main.rs'])
    const result = rustResolver.resolve('src/lib.rs', 'crate::helper', known, '/repo')
    expect(result.path).toBe('src/helper.rs')
    expect(result.confidence).toBe('resolved')
  })

  it('gives an identical result regardless of the Set\'s insertion order (determinism)', () => {
    const forward = new Set([...workspace])
    const backward = new Set([...workspace].reverse())
    const forwardResult = rustResolver.resolve('crates/beta/src/foo.rs', 'crate::bar', forward, '/repo')
    const backwardResult = rustResolver.resolve('crates/beta/src/foo.rs', 'crate::bar', backward, '/repo')
    expect(backwardResult).toEqual(forwardResult)
    // Updated for fix round 2 (see the first test in this block for why
    // the value itself changed from `unresolved`).
    expect(backwardResult).toEqual({ path: 'crates/beta/src/lib.rs', confidence: 'resolved' })
  })
})

// Fix round 1, item 3: two indexed files can share one module path
// (`<path>.rs` and `<path>/mod.rs` both satisfying `mod dup;`) — a Rust
// compile error, but this index reflects what's on disk mid-refactor, not
// what compiles. Several candidates matched is genuine ambiguity, not a
// single resolved answer.
describe('rustResolver — ambiguous module-path collisions (fix round 1, item 3)', () => {
  it('reports ambiguous, with the sorted-first path, when both file forms of a module are indexed', () => {
    const known = new Set(['src/main.rs', 'src/dup.rs', 'src/dup/mod.rs'])
    const result = rustResolver.resolve('src/main.rs', 'crate::dup', known, '/repo')
    expect(result.confidence).toBe('ambiguous')
    expect(result.path).toBe('src/dup.rs')
  })

  it('does not report ambiguous merely because full-path and item-drop attempts differ', () => {
    // `src/helper.rs` and `src/helper/help.rs` are two DIFFERENT modules,
    // not two forms of the same one — `crate::helper::help` genuinely means
    // the `help` submodule, and longer-first is correct, not a coin flip.
    const known = new Set(['src/main.rs', 'src/helper.rs', 'src/helper/help.rs'])
    const result = rustResolver.resolve('src/main.rs', 'crate::helper::help', known, '/repo')
    expect(result.confidence).toBe('resolved')
    expect(result.path).toBe('src/helper/help.rs')
  })
})

// Fix round 2: `crate::Item` and `crate::*` never reached `lib.rs`/`main.rs`
// — one of the most common `use` forms in real Rust produced no edge at
// all, since the only candidates ever tried were `<segments>.rs` and
// `<segments>/mod.rs`, and an item defined directly at the crate root
// leaves the module portion empty once dropped, matching neither.
describe('rustResolver — crate::Item and crate::* reach the crate root file (fix round 2)', () => {
  it('resolves an item defined directly at the crate root to lib.rs', () => {
    const known = new Set(['src/lib.rs', 'src/helper.rs', 'src/service.rs'])
    const result = rustResolver.resolve('src/helper.rs', 'crate::Thing', known, '/repo')
    expect(result.path).toBe('src/lib.rs')
    expect(result.confidence).toBe('resolved')
  })

  it('resolves an item defined directly at the crate root to main.rs for a bin crate', () => {
    const known = new Set(['src/main.rs', 'src/helper.rs', 'src/service.rs'])
    const result = rustResolver.resolve('src/helper.rs', 'crate::Thing', known, '/repo')
    expect(result.path).toBe('src/main.rs')
    expect(result.confidence).toBe('resolved')
  })

  it('resolves a crate::* glob to the crate root file', () => {
    const known = new Set(['src/lib.rs', 'src/helper.rs'])
    const result = rustResolver.resolve('src/helper.rs', 'crate::*', known, '/repo')
    expect(result.path).toBe('src/lib.rs')
    expect(result.confidence).toBe('resolved')
  })

  // Regression guard, named explicitly by the controller: the new
  // empty-module branch must not swallow an ORDINARY multi-segment path.
  // This specifier never reaches that branch: its first attempt
  // (`helper/help`) misses, and its second (`helper`) is non-empty, so the
  // empty-module case is never entered. The test proves that remains true
  // after round 2's change.
  it('still resolves an ordinary multi-segment path normally (regression guard)', () => {
    const known = new Set(['src/lib.rs', 'src/helper.rs', 'src/service.rs'])
    const result = rustResolver.resolve('src/service.rs', 'crate::helper::help', known, '/repo')
    expect(result.path).toBe('src/helper.rs')
    expect(result.confidence).toBe('resolved')
  })
})
