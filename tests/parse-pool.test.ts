import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parseAll } from '../src/indexer/parse-pool.js'
import { RepoParser } from '../src/parser/parser.js'
import { buildFixture } from './fixture-builder.js'

const FIXTURE = buildFixture()
const PATHS = ['src/helper.ts', 'src/index.ts', 'src/services/notify.ts', 'src/services/order.ts']
const BROKEN_WORKER = fileURLToPath(new URL('./fixtures/broken-parse-worker.mjs', import.meta.url))

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

  describe('worker-level failure (genuine crash, not a per-file error)', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('rejects and terminates every sibling worker when one chunk crashes', async () => {
      const terminateSpy = vi.spyOn(Worker.prototype, 'terminate')

      await expect(
        parseAll({
          repoRoot: FIXTURE,
          paths: ['CRASH', 'ok-a', 'ok-b'],
          concurrency: 3,
          workerPath: BROKEN_WORKER,
        }),
      ).rejects.toThrow('simulated worker crash for testing')

      // All three workers -- the one that crashed and its two siblings --
      // must be terminated. Left uncollected, the siblings would keep the
      // process alive and burn CPU well after parseAll has already rejected.
      expect(terminateSpy).toHaveBeenCalledTimes(3)
    })

    it('rejects when a worker exits without ever reporting a result', async () => {
      const terminateSpy = vi.spyOn(Worker.prototype, 'terminate')

      await expect(
        parseAll({
          repoRoot: FIXTURE,
          paths: ['EXIT-SILENT', 'ok-a'],
          concurrency: 2,
          workerPath: BROKEN_WORKER,
        }),
      ).rejects.toThrow(/exited with code 3/)

      expect(terminateSpy).toHaveBeenCalledTimes(2)
    })
  })
})
