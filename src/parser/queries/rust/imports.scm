; Verified against the real grammar: `use crate::helper::help;` captures the
; specifier as the full scoped_identifier text `crate::helper::help`, and
; `use crate::deep::*;` captures a use_wildcard whose text INCLUDES the
; trailing `::*` (unlike Java, whose grammar drops the `*` before the
; capture ever sees it — see src/resolve/rust.ts for how the resolver
; strips it deliberately).
(use_declaration argument: (scoped_identifier) @specifier) @import.static
(use_declaration argument: (use_wildcard) @specifier) @import.static
