// Copies non-TypeScript runtime assets into dist/ after tsc compiles.
// tsc does not copy .sql or .scm files, but later tasks read them at runtime
// via paths relative to the compiled module (which lives under dist/). This
// script must tolerate sources that do not exist yet (a no-op) rather than
// erroring, since earlier tasks run before those files are created.
import { existsSync, mkdirSync, cpSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function copyIfExists(src, dest) {
  if (!existsSync(src)) return
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
}

copyIfExists(
  join(projectRoot, 'src/store/schema.sql'),
  join(projectRoot, 'dist/store/schema.sql'),
)

copyIfExists(
  join(projectRoot, 'src/parser/queries'),
  join(projectRoot, 'dist/parser/queries'),
)
