(import_statement source: (string (string_fragment) @specifier)) @import.static
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @specifier))) @import.dynamic
(call_expression
  function: (identifier) @_fn
  arguments: (arguments (string (string_fragment) @specifier))
  (#eq? @_fn "require")) @import.require
