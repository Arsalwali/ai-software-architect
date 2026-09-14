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
}

/**
 * Parses every path across a worker pool and returns records in input order.
 * ASTs never cross the thread boundary and are never retained — only the
 * normalized ParsedFile records are, which is what bounds memory.
 */
export async function parseAll(args: ParseAllArgs): Promise<ParsedFile[]> {
  const { repoRoot, paths, onBatch } = args
  if (paths.length === 0) return []

  const workers = Math.max(1, Math.min(args.concurrency ?? availableParallelism() - 1, paths.length))
  const chunks = chunkInto(paths, workers)

  let done = 0
  const settled = await Promise.all(
    chunks.map(chunk =>
      runChunk(repoRoot, chunk).then(result => {
        done += chunk.length
        onBatch?.(done, paths.length)
        return result
      }),
    ),
  )

  return settled.flat()
}

function runChunk(repoRoot: string, paths: string[]): Promise<ParsedFile[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { repoRoot, paths } })
    let received: ParsedFile[] | null = null

    worker.on('message', (message: ParsedFile[]) => { received = message })
    worker.on('error', reject)
    worker.on('exit', code => {
      if (received) resolve(received)
      else reject(new Error(`parse worker exited with code ${code} before reporting`))
    })
  })
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
