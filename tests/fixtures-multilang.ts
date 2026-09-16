import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function build(prefix: string, files: Record<string, string>, git: boolean): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  if (git) {
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    run(['init', '-q'])
    run(['config', 'user.email', 'a@example.com'])
    run(['config', 'user.name', 'A'])
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'fixture'])
  }
  return root
}

/** helper.py is imported BOTH absolutely and relatively, so both paths are exercised. */
export const PYTHON_FILES: Record<string, string> = {
  'pkg/__init__.py': '',
  'pkg/helper.py': 'def helper(n):\n    return n + 1\n\n\ndef unused():\n    pass\n',
  'pkg/service.py':
    'from .helper import helper\n\n\nclass Service:\n    def place(self, n):\n        return helper(n)\n',
  'main.py': 'from pkg.service import Service\n\n\ndef run():\n    return Service().place(2)\n',
}

export function buildPythonFixture(options: { git?: boolean } = {}): string {
  return build('arch-py-', PYTHON_FILES, options.git ?? false)
}
