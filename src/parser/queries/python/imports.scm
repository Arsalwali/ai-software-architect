(import_statement name: (dotted_name) @specifier) @import.static

; `from <module> import <name>` names the MODULE `<module>.<name>` whenever
; a submodule by that name exists -- the dominant form in real Python, and
; the one that previously resolved to `<module>/__init__.py` because only
; the `module_name:` field was captured. The imported name is captured as
; @member and joined onto the specifier by extractImports (see
; src/parser/parser.ts), producing an item-shaped specifier exactly like
; Java's `com.example.Helper` or Rust's `crate::helper::help`; the resolver
; drops the trailing item when the full path names no module.
;
; One match is produced per imported name, so `from pkg import a, b` yields
; two specifiers. An aliased import (`from pkg import service as svc`)
; captures the PRE-alias name -- the alias is a local binding and names no
; file. A wildcard import (`from pkg import *`) has no `name:` field at all
; and is matched by the `!name` negated-field pattern below, which is also
; what keeps the named forms from ALSO emitting a bare-module specifier.
; Every node name, field name and the `!name` predicate here was verified
; against tree-sitter-python.wasm by probe.
(import_from_statement module_name: (_) @specifier !name) @import.static
(import_from_statement module_name: (_) @specifier name: (dotted_name) @member) @import.static
(import_from_statement module_name: (_) @specifier
  name: (aliased_import name: (dotted_name) @member)) @import.static
