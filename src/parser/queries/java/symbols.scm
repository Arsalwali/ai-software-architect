(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(method_declaration name: (identifier) @name) @def.method
; A record is a class (JLS: "a record class") and an annotation type is an
; interface (JLS 9.6), so both reuse the existing kinds rather than adding
; new ones — the same reading src/parser/parser.ts's Java export rule
; already relies on. Both node names and their `name: (identifier)` fields
; were verified against tree-sitter-java.wasm by probe. Both were already
; listed in ENCLOSING_CLASS_TYPES.java, so a record's methods were being
; given `parentName: "Circle"` while no `Circle` symbol existed at all.
(record_declaration name: (identifier) @name) @def.class
(annotation_type_declaration name: (identifier) @name) @def.interface
