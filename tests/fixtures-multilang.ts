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
 *
 * `single/one.go` and `single/two.go` are a SEPARATE, additive pair: one
 * Go package split across two files in one directory, calling each other
 * with NO import statement at all -- the ordinary Go idiom that
 * `helper`/`service`/`main` above, being three separate packages, never
 * exercises. `two.go`'s `Combine` calls `one.go`'s `help`, deliberately
 * lowercase/unexported (and deliberately NOT named `Place`, to avoid
 * colliding with `service.go`'s `Place` method in symbol-name lookups
 * elsewhere in this suite): Go's same-package access needs no `import` AND
 * no export, and a resolver that filtered same-directory candidates by
 * exported-ness would leave this specific call unresolved. See
 * task-6-fixes.md and `src/indexer/same-package.ts`.
 *
 * `multi/aaa.go` and `multi/zzz.go` are a THIRD additive pair, for a
 * different gap (task-6-fixes-round2.md, Fix 3): `multi` is a Go package
 * split across two files where the CALLED symbol (`MultiFn`, in `zzz.go`)
 * does not live in the file that sorts first (`aaa.go`). `goResolver`
 * (src/resolve/go.ts) resolves an `import "example.com/m/multi"` to only
 * the first file in the directory by sorted path for the `imports` table's
 * single `resolvedFileId` -- deliberately unchanged by this fix, since the
 * import row can only ever record one file. Without a second, later-sorting
 * file holding the actually-called symbol, a resolver that (bug or fix)
 * only ever looked at the "resolved" file could never be told apart from
 * one that correctly considers the whole package directory: `main.go`
 * calling `multi.MultiFn` is the assertion with teeth for that distinction.
 */
export const GO_FILES: Record<string, string> = {
  'go.mod': 'module example.com/m\n\ngo 1.22\n',
  'helper/helper.go': 'package helper\n\nfunc Help(n int) int {\n\treturn n + 1\n}\n',
  'service/service.go':
    'package service\n\nimport "example.com/m/helper"\n\n' +
    'type Service struct{ N int }\n\n' +
    'func (s *Service) Place() int {\n\treturn helper.Help(s.N)\n}\n',
  'main.go':
    'package main\n\nimport (\n\t"fmt"\n\t"example.com/m/service"\n\t"example.com/m/multi"\n)\n\n' +
    'func main() {\n\ts := service.Service{N: 2}\n\tfmt.Println(s.Place())\n\t' +
    'fmt.Println(multi.MultiFn(1))\n}\n',
  'single/one.go': 'package single\n\nfunc help(n int) int {\n\treturn n + 1\n}\n',
  'single/two.go': 'package single\n\nfunc Combine(n int) int {\n\treturn help(n)\n}\n',
  'multi/aaa.go': 'package multi\n\nfunc Unrelated() int {\n\treturn 0\n}\n',
  'multi/zzz.go': 'package multi\n\nfunc MultiFn(n int) int {\n\treturn n + 1\n}\n',
}

export function buildGoFixture(options: { git?: boolean } = {}): string {
  return build('arch-go-', GO_FILES, options.git ?? false)
}

/**
 * Nested under a Maven-style `src/main/java` root so `sourceRootsFrom`
 * (src/resolve/java.ts) is genuinely exercised rather than assumed: the
 * resolver has to derive that prefix from the indexed paths, not from a
 * hardcoded convention.
 *
 * `Helper` deliberately carries BOTH a public and a package-private method
 * (`internal`), and `Runner` is an interface whose member has no modifier at
 * all — together these exercise Java's "public OR interface member" export
 * rule from both sides (see the ruling on `isExported` in
 * src/parser/parser.ts). `Service` imports `Helper` by name AND imports
 * `com.example.*` by wildcard; the wildcard import captures as the bare
 * package name `com.example` (this grammar has no `.*`-suffixed specifier —
 * see src/resolve/java.ts) and must resolve to `unresolved` end-to-end,
 * since `com/example` names a directory, not a file.
 *
 * `Service` also imports `com.example.util.StringUtil`, from a genuinely
 * separate subpackage directory. `Helper`/`Service`/`Runner` all sit in the
 * SAME directory (`com/example`), which is deliberate for the FQN-resolution
 * cases above but means a fixture built from those three files alone can
 * never produce a directory-level (module) edge: `buildModuleGraph`
 * (src/graph/module-graph.ts) treats "module" as "directory containing the
 * file" and drops same-directory pairs. `StringUtil` gives `get_coupling`/
 * `find_cycles`, which operate at that granularity, a real cross-directory
 * edge to see.
 *
 * `Worker` is a SEPARATE, additive class exercising the case
 * `Service`/`Helper` do NOT: real same-package Java omits the import
 * entirely (unlike `Service`'s `import com.example.Helper;` above, which is
 * legal but unnecessary and, left as the only same-package call site here,
 * would hide that this resolver even needs a same-directory fallback).
 * `Worker` calls `Helper.internal`, the PACKAGE-PRIVATE method, with no
 * import of `Helper` at all -- same package, same directory, no import
 * needed for either the class name or a package-private member. A resolver
 * that filtered same-directory candidates by exported-ness would leave this
 * unresolved, since `internal` is exactly the member that filter would
 * drop. See task-6-fixes.md and `src/indexer/same-package.ts`.
 */
export const JAVA_FILES: Record<string, string> = {
  'src/main/java/com/example/Helper.java':
    'package com.example;\n\n' +
    'public class Helper {\n' +
    '  public static int help(int n) { return n + 1; }\n' +
    '  static int internal(int n) { return n - 1; }\n' +
    '}\n',
  'src/main/java/com/example/Service.java':
    'package com.example;\n\n' +
    'import com.example.Helper;\n' +
    'import com.example.*;\n' +
    'import com.example.util.StringUtil;\n\n' +
    'public class Service {\n' +
    '  public int place(int n) { return Helper.help(n); }\n' +
    '  public String label() { return StringUtil.greet(); }\n' +
    '}\n',
  'src/main/java/com/example/Runner.java':
    'package com.example;\n\npublic interface Runner {\n  void go();\n}\n',
  'src/main/java/com/example/util/StringUtil.java':
    'package com.example.util;\n\n' +
    'public class StringUtil {\n' +
    '  public static String greet() { return "hi"; }\n' +
    '}\n',
  'src/main/java/com/example/Worker.java':
    'package com.example;\n\n' +
    'public class Worker {\n' +
    '  public int run(int n) { return Helper.internal(n); }\n' +
    '}\n',
}

export function buildJavaFixture(options: { git?: boolean } = {}): string {
  return build('arch-java-', JAVA_FILES, options.git ?? false)
}

/**
 * `main.rs`'s `fn main()` is deliberately NOT `pub` — Rust's export rule is
 * "has a visibility_modifier child" (see the ruling on `isExported` in
 * src/parser/parser.ts), and a fixture where everything is `pub` cannot
 * distinguish that rule from `return true`. `main` is the non-pub function
 * this fixture exercises for that.
 */
export const RUST_FILES: Record<string, string> = {
  'src/helper.rs': 'pub fn help(n: i32) -> i32 {\n    n + 1\n}\n',
  'src/service.rs':
    'use crate::helper::help;\n\npub struct Service {\n    pub n: i32,\n}\n\n' +
    'impl Service {\n    pub fn place(&self) -> i32 {\n        help(self.n)\n    }\n}\n',
  // `src/util/mod.rs` sits in a genuinely separate directory from
  // helper.rs/service.rs/main.rs (all directly under `src/`). Those three
  // alone can never produce a directory-level (module) edge: `moduleOf`
  // (src/graph/module-graph.ts) is "directory containing the file", and
  // helper/service/main all share the SAME directory (`src`), so their
  // mutual imports collapse to a same-module pair the module graph drops.
  // `util` gives `get_coupling`/`find_cycles`, which operate at that
  // granularity, a real cross-directory edge (`src` -> `src/util`) to see.
  'src/util/mod.rs': 'pub fn shout(s: &str) -> String {\n    format!("{}!", s)\n}\n',
  'src/main.rs':
    'mod helper;\nmod service;\nmod util;\n\n' +
    'use crate::service::Service;\nuse crate::util::shout;\n\n' +
    'fn main() {\n    let s = Service { n: 2 };\n    println!("{}", s.place());\n    ' +
    'println!("{}", shout("hi"));\n}\n',
}

export function buildRustFixture(options: { git?: boolean } = {}): string {
  return build('arch-rs-', RUST_FILES, options.git ?? false)
}
