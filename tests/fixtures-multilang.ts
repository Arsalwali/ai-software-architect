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

/**
 * `helper.Help` is capitalised deliberately, not incidentally: Go exports by
 * capitalisation alone, so a lowercase `help` would never enter
 * `exportedSymbolsByFile` and the cross-file call edge below could never
 * resolve, regardless of whether the import itself resolves.
 */
export const GO_FILES: Record<string, string> = {
  'go.mod': 'module example.com/m\n\ngo 1.22\n',
  'helper/helper.go': 'package helper\n\nfunc Help(n int) int {\n\treturn n + 1\n}\n',
  'service/service.go':
    'package service\n\nimport "example.com/m/helper"\n\n' +
    'type Service struct{ N int }\n\n' +
    'func (s *Service) Place() int {\n\treturn helper.Help(s.N)\n}\n',
  'main.go':
    'package main\n\nimport (\n\t"fmt"\n\t"example.com/m/service"\n)\n\n' +
    'func main() {\n\ts := service.Service{N: 2}\n\tfmt.Println(s.Place())\n}\n',
}

export function buildGoFixture(options: { git?: boolean } = {}): string {
  return build('arch-go-', GO_FILES, options.git ?? false)
}
