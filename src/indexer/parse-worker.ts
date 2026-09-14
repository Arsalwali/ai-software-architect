import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoParser } from '../parser/parser.js'
import type { ParsedFile } from '../types.js'

interface WorkerData {
  repoRoot: string
  paths: string[]
}

const { repoRoot, paths } = workerData as WorkerData

const results: ParsedFile[] = []
const parser = await RepoParser.create()

for (const path of paths) {
  results.push(parseOne(parser, repoRoot, path))
}

parentPort!.postMessage(results)

function parseOne(parser: RepoParser, repoRoot: string, path: string): ParsedFile {
  try {
    return parser.parse(path, readFileSync(join(repoRoot, path), 'utf8'))
  } catch (error) {
    return {
      path,
      lang: null,
      contentHash: '',
      symbols: [],
      imports: [],
      callSites: [],
      errors: [{ line: 1, message: `unreadable: ${(error as Error).message}` }],
    }
  }
}
