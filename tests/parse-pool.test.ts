import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { parseAll } from '../src/indexer/parse-pool.js'
import { RepoParser } from '../src/parser/parser.js'
import { buildFixture } from './fixture-builder.js'

const FIXTURE = buildFixture()
const PATHS = ['src/helper.ts', 'src/index.ts', 'src/services/notify.ts', 'src/services/order.ts']

describe('parseAll', () => {
  it('returns one record per input path, in input order', async () => {
    const parsed = await parseAll({ repoRoot: FIXTURE, paths: PATHS })
    expect(parsed.map(p => p.path)).toEqual(PATHS)
  })

  it('produces results identical to single-threaded parsing', async () => {
    const pooled = await parseAll({ repoRoot: FIXTURE, paths: PATHS })
    const parser = await RepoParser.create()
    const direct = PATHS.map(p => parser.parse(p, readFileSync(join(FIXTURE, p), 'utf8')))
    expect(pooled).toEqual(direct)
  })

  it('handles an empty input list', async () => {
    expect(await parseAll({ repoRoot: FIXTURE, paths: [] })).toEqual([])
  })

  it('records an unreadable file as an error rather than throwing', async () => {
    const parsed = await parseAll({ repoRoot: FIXTURE, paths: ['src/does-not-exist.ts'] })
    expect(parsed).toHaveLength(1)
    expect(parsed[0].errors.length).toBeGreaterThan(0)
  })
})
