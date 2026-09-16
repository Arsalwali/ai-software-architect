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

  // Ruling 5: `use_wildcard` carries the literal `::*` suffix in this
  // grammar (the opposite of Java, whose grammar drops it before capture).
  // Handling it deliberately — not by accident via "drop the last
  // segment" — means a wildcard resolves exactly like the module path it
  // wildcards from.
  it('resolves a wildcard import by stripping the trailing ::* and resolving the module path', () => {
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
