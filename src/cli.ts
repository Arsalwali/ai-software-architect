#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { runColdIndex } from './indexer/pipeline.js'
import { indexPathFor, gitHeadCommit } from './repo/repo-source.js'
import { GraphStore } from './store/graph-store.js'

const program = new Command()

program
  .name('arch')
  .description('Index a repository into a queryable architecture graph')
  .version('0.1.0')

program
  .command('index')
  .argument('[repo]', 'path to the repository', '.')
  .option('-q, --quiet', 'suppress progress output')
  .option('-f, --force', 'delete an existing index (e.g. after a schema-version mismatch) and rebuild')
  .description('Build the index for a repository')
  .action(async (repo: string, options: { quiet?: boolean; force?: boolean }) => {
    const repoRoot = resolve(repo)
    const dbPath = indexPathFor(repoRoot)

    if (options.force && existsSync(dbPath)) unlinkSync(dbPath)

    const report = await runColdIndex({
      repoRoot,
      dbPath,
      onProgress: options.quiet ? undefined : message => process.stderr.write(`  ${message}\n`),
    })

    console.log(
      `Indexed ${report.filesIndexed} files ` +
      `(${report.symbols} symbols, ${report.edges} edges) ` +
      `in ${(report.durationMs / 1000).toFixed(1)}s`,
    )
    if (report.filesSkipped > 0) console.log(`Skipped ${report.filesSkipped} files`)
    if (report.parseErrors > 0) console.log(`${report.parseErrors} parse errors (partial results kept)`)
    console.log(`Index: ${dbPath}`)
  })

program
  .command('status')
  .argument('[repo]', 'path to the repository', '.')
  .description('Report index freshness for a repository')
  .action((repo: string) => {
    const repoRoot = resolve(repo)
    const dbPath = indexPathFor(repoRoot)

    if (!existsSync(dbPath)) {
      console.log(`No index for ${repoRoot}. Run "arch index ${repo}" first.`)
      return
    }

    const store = GraphStore.open(dbPath)
    try {
      const indexedHead = store.getMeta('head_commit') ?? ''
      const currentHead = gitHeadCommit(repoRoot) ?? ''
      const indexedAt = store.getMeta('indexed_at')
      const isComplete = store.getMeta('index_complete') === '1'

      console.log(`Repo:    ${repoRoot}`)
      console.log(`Index:   ${dbPath}`)
      console.log(`Files:   ${store.getMeta('files_indexed') ?? '0'}`)
      console.log(`Skipped: ${store.getMeta('files_skipped') ?? '0'}`)
      printSkipBreakdown(store.getMeta('files_skipped_by_reason'))
      console.log(`Edges:   ${store.edgeCount()}`)
      console.log(`Built:   ${indexedAt ? new Date(Number(indexedAt)).toISOString() : 'unknown'}`)

      if (!isComplete) {
        console.log('State:   INCOMPLETE — a previous index did not finish. Re-run "arch index".')
      } else if (indexedHead !== '' && currentHead !== '' && currentHead !== indexedHead) {
        console.log(`State:   STALE — indexed at ${indexedHead.slice(0, 8)}, HEAD is ${currentHead.slice(0, 8)}.`)
      } else {
        console.log('State:   current')
        if (currentHead === '') {
          console.log('Note:    not a git repository — staleness cannot be detected.')
        }
      }
    } finally {
      store.close()
    }
  })

/**
 * Prints a few lines of "skipped 12 as vendored, 3 as binary" so a user can
 * ask why a file is missing from the graph, not just that some files were
 * skipped. Kept to the meta blob written by the pipeline; a dedicated
 * `skipped` table with per-path detail belongs to a later plan.
 */
function printSkipBreakdown(raw: string | undefined): void {
  if (!raw) return
  let counts: Record<string, number>
  try {
    counts = JSON.parse(raw) as Record<string, number>
  } catch {
    return
  }
  const entries = Object.entries(counts).filter(([, count]) => count > 0)
  if (entries.length === 0) return
  entries.sort(([, a], [, b]) => b - a)
  const summary = entries.map(([reason, count]) => `${count} ${reason}`).join(', ')
  console.log(`         (${summary})`)
}

try {
  await program.parseAsync(process.argv)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Error: ${message}\n`)
  if (process.env.ARCH_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`)
  }
  process.exitCode = 1
}
