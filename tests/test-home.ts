import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A throwaway HOME for subprocess CLI tests.
 *
 * `indexPathFor` resolves through `os.homedir()`, which reads $HOME on POSIX,
 * so overriding it redirects every index the child process writes into a temp
 * directory instead of the developer's real ~/.arch. Without this, running the
 * suite leaves real index directories behind — including ones deliberately
 * poisoned with a bad schema_version — which then break unrelated later runs.
 */
export function withTestHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'arch-home-'))
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home } }
}
