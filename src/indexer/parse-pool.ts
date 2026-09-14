import { Worker } from 'node:worker_threads'
import { availableParallelism } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ParsedFile } from '../types.js'

const here = dirname(fileURLToPath(import.meta.url))
// Workers execute compiled JavaScript. Under vitest this module runs from
// src/, so redirect to the built worker in dist/.
const WORKER_PATH = here.includes(`${sep}dist${sep}`)
  ? join(here, 'parse-worker.js')
  : join(here, '..', '..', 'dist', 'indexer', 'parse-worker.js')

export interface ParseAllArgs {
  repoRoot: string
  paths: string[]
  concurrency?: number
  onBatch?: (done: number, total: number) => void
  /**
   * Overrides the compiled worker script. Only meant for tests: a genuine
   * worker-thread crash can't be induced through a normal source file (every
   * per-file failure is caught inside parse-worker.ts and returned as an
   * error record, never thrown), so tests point this at a small script that
   * crashes on purpose to exercise runChunk's reject paths.
   */
  workerPath?: string
}

/**
 * Parses every path across a worker pool and returns records in input order.
 * ASTs never cross the thread boundary and are never retained — only the
 * normalized ParsedFile records are, which is what bounds memory.
 */
export async function parseAll(args: ParseAllArgs): Promise<ParsedFile[]> {
  const { repoRoot, paths, onBatch, workerPath = WORKER_PATH } = args
  if (paths.length === 0) return []

  const workerCount = Math.max(1, Math.min(args.concurrency ?? availableParallelism() - 1, paths.length))
  const chunks = chunkInto(paths, workerCount)

  // Every spawned Worker handle is retained so that, if any chunk rejects,
  // its still-running siblings can be terminated rather than left orphaned.
  // Without this, a caught rejection in a long-lived caller (e.g. a future
  // MCP server) leaves worker threads burning CPU indefinitely across retries.
  const workers: Worker[] = []
  let done = 0

  const runs = chunks.map(chunk => {
    const { worker, result } = runChunk(repoRoot, chunk, workerPath)
    workers.push(worker)
    return result.then(parsed => {
      done += chunk.length
      onBatch?.(done, paths.length)
      return parsed
    })
  })

  try {
    const settled = await Promise.all(runs)
    return settled.flat()
  } catch (error) {
    for (const worker of workers) void worker.terminate()
    throw error
  }
}

function runChunk(
  repoRoot: string,
  paths: string[],
  workerPath: string,
): { worker: Worker; result: Promise<ParsedFile[]> } {
  const worker = new Worker(workerPath, { workerData: { repoRoot, paths } })
  const result = new Promise<ParsedFile[]>((resolve, reject) => {
    let received: ParsedFile[] | null = null

    worker.on('message', (message: ParsedFile[]) => { received = message })
    worker.on('error', reject)
    worker.on('exit', code => {
      if (received) resolve(received)
      else reject(new Error(`parse worker exited with code ${code} before reporting`))
    })
  })
  return { worker, result }
}

/** Contiguous chunks, so results concatenate back into input order. */
function chunkInto<T>(items: T[], count: number): T[][] {
  const size = Math.ceil(items.length / count)
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size))
  }
  return chunks
}
