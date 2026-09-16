; Rust has no `struct` or `trait` in SymbolKind. A struct is the closest
; thing to a class and a trait to an interface; the mapping is recorded
; here so a reader is not surprised by the kind that comes back.
;
; `enum_item` and `type_item` were verified against the real grammar
; (tree-sitter-rust.wasm) with a throwaway probe script before relying on
; them here, per the task rulings — both node names and both queries below
; compiled and matched as written.
(function_item name: (identifier) @name) @def.function
(struct_item name: (type_identifier) @name) @def.class
(enum_item name: (type_identifier) @name) @def.enum
(trait_item name: (type_identifier) @name) @def.interface
(type_item name: (type_identifier) @name) @def.type
