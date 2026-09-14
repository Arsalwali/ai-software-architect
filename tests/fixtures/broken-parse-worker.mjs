// Test-only stand-in for dist/indexer/parse-worker.js. Used exclusively by
// tests/parse-pool.test.ts to exercise runChunk's two reject branches with a
// genuine worker-thread failure -- something the real worker can't produce
// through a source file, since every per-file failure there is caught and
// returned as an error record rather than thrown.
import { parentPort, workerData } from 'node:worker_threads'

const { paths } = workerData

// Simulates an uncaught exception in the worker thread (e.g. a bug in the
// parser setup code that runs outside parse-worker's per-file try/catch).
// Node reports this as an 'error' event on the parent-side Worker object.
if (paths.includes('CRASH')) {
  throw new Error('simulated worker crash for testing')
}

// Simulates a worker that exits without ever posting a result and without
// raising an 'error' -- the other reject branch in runChunk.
if (paths.includes('EXIT-SILENT')) {
  process.exit(3)
}

parentPort.postMessage(paths.map(path => ({
  path,
  lang: null,
  contentHash: '',
  symbols: [],
  imports: [],
  callSites: [],
  errors: [],
})))
