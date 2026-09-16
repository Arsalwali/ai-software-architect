import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runColdIndex } from '../src/indexer/pipeline.js'
import { GraphStore } from '../src/store/graph-store.js'
import { findHotspots } from '../src/tools/hotspots.js'
import { buildFixture } from './fixture-builder.js'

function write(root: string, path: string, content: string): void {
  const abs = join(root, path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function gitRepoWithChurn(): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-hot-'))
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  run(['init', '-q'])
  run(['config', 'user.email', 'a@example.com'])
  run(['config', 'user.name', 'A'])

  // `churny.ts` is big AND changes constantly. `calm.ts` is big and stable.
  const big = (n: number) => Array.from({ length: 40 }, (_, i) => `export function f${n}_${i}(): number { return ${i}; }`).join('\n') + '\n'
  write(root, 'src/calm.ts', big(0))
  write(root, 'src/churny.ts', big(1))
  run(['add', '-A']); run(['commit', '-q', '-m', 'feat: initial'])

  for (let i = 0; i < 6; i++) {
    write(root, 'src/churny.ts', big(1) + `// revision ${i}\n`)
    run(['add', '-A'])
    run(['commit', '-q', '-m', i % 2 === 0 ? `fix: correct thing ${i}` : `feat: change ${i}`])
  }
  return root
}

async function indexed(root: string): Promise<GraphStore> {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'arch-hot-db-')), 'index.db')
  await runColdIndex({ repoRoot: root, dbPath })
  return GraphStore.open(dbPath)
}

describe('findHotspots with git available', () => {
  it('ranks the churning file above the stable one of the same size', async () => {
    const root = gitRepoWithChurn()
    const store = await indexed(root)
    const r = findHotspots(store, root, { limit: 10 })
    expect(r.gitAvailable).toBe(true)
    const paths = r.hotspots.map(h => h.path)
    expect(paths.indexOf('src/churny.ts')).toBeLessThan(paths.indexOf('src/calm.ts'))
    store.close()
  })

  it('reports the raw signals alongside the score', async () => {
    const root = gitRepoWithChurn()
    const store = await indexed(root)
    const top = findHotspots(store, root, { limit: 10 }).hotspots.find(h => h.path === 'src/churny.ts')!
    expect(top.loc).toBeGreaterThan(0)
    expect(top.symbols).toBeGreaterThan(0)
    expect(top.commits).toBeGreaterThan(1)
    expect(top.bugFixCommits).toBeGreaterThan(0)
    // The churn fixture has no import cycle, so this is knowably false --
    // asserting the bare type would pass even if the field were always true.
    expect(top.inCycle).toBe(false)
    expect(top.score).toBeGreaterThan(0)
    store.close()
  })

  it('surfaces co-change pairs that have no import edge between them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-cochange-'))
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'a@example.com'])
    run(['config', 'user.name', 'A'])
    write(root, 'src/alpha.ts', 'export function alpha(): number { return 1; }\n')
    write(root, 'src/beta.ts', 'export function beta(): number { return 2; }\n')
    run(['add', '-A']); run(['commit', '-q', '-m', 'feat: one'])
    for (let i = 0; i < 3; i++) {
      write(root, 'src/alpha.ts', `export function alpha(): number { return ${i}; }\n`)
      write(root, 'src/beta.ts', `export function beta(): number { return ${i}; }\n`)
      run(['add', '-A']); run(['commit', '-q', '-m', `feat: change ${i}`])
    }
    const store = await indexed(root)
    const r = findHotspots(store, root, { limit: 10 })
    const hidden = r.hiddenCoupling.find(p => p.a === 'src/alpha.ts' && p.b === 'src/beta.ts')
    expect(hidden).toBeDefined()
    expect(hidden!.commits).toBeGreaterThanOrEqual(3)
    store.close()
  })

  it('truncates loudly with the true total', async () => {
    const root = gitRepoWithChurn()
    const store = await indexed(root)
    const r = findHotspots(store, root, { limit: 1 })
    expect(r.hotspots).toHaveLength(1)
    expect(r.truncated!.total).toBeGreaterThan(1)
    store.close()
  })

  it('caps hiddenCoupling loudly with the true total, not silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-hidden-cap-'))
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'a@example.com'])
    run(['config', 'user.name', 'A'])

    // Three disjoint, unimported pairs that each co-change enough to qualify
    // as hidden coupling -- more pairs than the limit below allows through.
    const pairs = [['p1a', 'p1b'], ['p2a', 'p2b'], ['p3a', 'p3b']]
    for (const [x, y] of pairs) {
      write(root, `src/${x}.ts`, `export function ${x}(): number { return 0; }\n`)
      write(root, `src/${y}.ts`, `export function ${y}(): number { return 0; }\n`)
    }
    run(['add', '-A']); run(['commit', '-q', '-m', 'feat: initial'])
    for (let i = 0; i < 3; i++) {
      for (const [x, y] of pairs) {
        write(root, `src/${x}.ts`, `export function ${x}(): number { return 0; } // rev ${i}\n`)
        write(root, `src/${y}.ts`, `export function ${y}(): number { return 0; } // rev ${i}\n`)
      }
      run(['add', '-A']); run(['commit', '-q', '-m', `feat: change ${i}`])
    }

    const store = await indexed(root)
    const r = findHotspots(store, root, { limit: 1 })
    expect(r.totalHiddenCoupling).toBeGreaterThan(1)
    expect(r.hiddenCoupling.length).toBeLessThan(r.totalHiddenCoupling)
    expect(r.truncatedHiddenCoupling).toBeDefined()
    expect(r.truncatedHiddenCoupling!.total).toBe(r.totalHiddenCoupling)
    store.close()
  })

  it('does not flag a pair reachable in two hops as hidden coupling, but still flags a genuinely disconnected pair', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-twohop-'))
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'a@example.com'])
    run(['config', 'user.name', 'A'])

    // a -> b -> c: a and c have a two-hop import path, so co-changing
    // together is not "hidden" -- it's explained by the shared chain.
    write(root, 'src/a.ts', 'import { b } from "./b.js";\nexport function a(): number { return b(); }\n')
    write(root, 'src/b.ts', 'import { c } from "./c.js";\nexport function b(): number { return c(); }\n')
    write(root, 'src/c.ts', 'export function c(): number { return 1; }\n')
    // d and e import nothing and are not imported -- genuinely disconnected.
    write(root, 'src/d.ts', 'export function d(): number { return 1; }\n')
    write(root, 'src/e.ts', 'export function e(): number { return 2; }\n')
    run(['add', '-A']); run(['commit', '-q', '-m', 'feat: initial'])

    for (let i = 0; i < 3; i++) {
      write(root, 'src/a.ts', `import { b } from "./b.js";\nexport function a(): number { return b() + ${i}; }\n`)
      write(root, 'src/c.ts', `export function c(): number { return ${i}; }\n`)
      write(root, 'src/d.ts', `export function d(): number { return ${i}; }\n`)
      write(root, 'src/e.ts', `export function e(): number { return ${i}; }\n`)
      run(['add', '-A']); run(['commit', '-q', '-m', `feat: change ${i}`])
    }

    const store = await indexed(root)
    const r = findHotspots(store, root, { limit: 10 })
    const aToC = r.hiddenCoupling.find(p => p.a === 'src/a.ts' && p.b === 'src/c.ts')
    const dToE = r.hiddenCoupling.find(p => p.a === 'src/d.ts' && p.b === 'src/e.ts')
    expect(aToC).toBeUndefined()
    expect(dToE).toBeDefined()
    expect(dToE!.noNearbyImportPath).toBe(true)
    store.close()
  })
})

describe('findHotspots without git', () => {
  it('degrades to structural scoring and says so rather than pretending', async () => {
    const fixture = buildFixture()
    const store = await indexed(fixture)
    const r = findHotspots(store, fixture, { limit: 10 })
    expect(r.gitAvailable).toBe(false)
    expect(r.note).toMatch(/structural/i)
    expect(r.hotspots.length).toBeGreaterThan(0)
    for (const h of r.hotspots) expect(h.commits).toBe(0)
    store.close()
  })
})
