import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoParser } from '../parser/parser.js'
import { languageForPath } from '../parser/languages.js'
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
      // A read failure tells us nothing about the file's actual language, so
      // don't stamp it null -- null is the spec's dedicated "unknown
      // language" signal (e.g. README.md), and conflating the two makes an
      // unreadable src/foo.ts indistinguishable from a genuinely
      // language-less file. Derive it from the extension instead; still null
      // for genuinely unknown extensions, which is correct there.
      lang: languageForPath(path)?.id ?? null,
      // contentHash stays '' here: hashing requires the content we just
      // failed to read, and '' is already a safe "no content" sentinel
      // elsewhere in this record (empty symbols/imports/callSites). Deriving
      // a hash from just the path would be misleading, implying content that
      // was never actually read.
      contentHash: '',
      loc: 0,
      symbols: [],
      imports: [],
      callSites: [],
      errors: [{ line: 1, message: `unreadable: ${(error as Error).message}` }],
    }
  }
}
