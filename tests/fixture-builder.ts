import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A small repository whose expected graph is hand-verified. */
export const FIXTURE_FILES: Record<string, string> = {
  'src/helper.ts': `export function helper(n: number): number {
  return n + 1;
}
export function unused(): void {}
`,
  'src/services/order.ts': `import { helper } from "../helper";
import { notify } from "./notify";

export class OrderService {
  place(quantity: number): number {
    notify("placed");
    return helper(quantity);
  }
}
`,
  'src/services/notify.ts': `export function notify(message: string): void {
  console.log(message);
}
`,
  'src/index.ts': `import { OrderService } from "./services/order";
import external from "node:fs";

const service = new OrderService();
service.place(2);
`,
  'README.md': '# fixture\n',
  // Dotfiles and dot-directories are real source, not noise -- regression
  // fixtures for the walkCandidates bug that used to drop every entry
  // starting with '.' before it could become a files/skipped candidate.
  '.eslintrc.js': 'module.exports = {\n  root: true,\n};\n',
  '.config/settings.ts': 'export const settings = {\n  debug: false,\n};\n',
  'node_modules/pkg/index.js': 'module.exports = {};\n',
  'bundle.min.js': '!function(){var a=1;}();\n',
  // Unknown extension + a NUL byte: exercises the binary sniff. Must stay
  // skipped (reason 'binary'), never indexed — EXPECTED_FILES in
  // discover.test.ts does not include it.
  'assets/logo.png': '\x89PNG\r\n\x1a\n\u0000\u0000\u0000\rIHDR\u0000\u0000\u0000\u0000',
}

/**
 * Writes the fixture to a fresh temp directory and returns its path.
 * Pass `{ git: true }` to initialize a repository and commit, which routes
 * discovery through the `git ls-files` branch instead of the filesystem walk.
 */
export function buildFixture(options: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-fixture-'))

  for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }

  if (options.git) {
    const run = (args: string[]) =>
      execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'fixture@example.com'])
    run(['config', 'user.name', 'Fixture'])
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'fixture'])
  }

  return root
}
