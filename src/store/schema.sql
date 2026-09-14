PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  lang          TEXT,
  content_hash  TEXT NOT NULL,
  loc           INTEGER NOT NULL DEFAULT 0,
  last_commit   TEXT,
  error_count   INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  exported    INTEGER NOT NULL DEFAULT 0,
  signature   TEXT,
  parent_name TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw_specifier    TEXT NOT NULL,
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL,
  confidence       TEXT NOT NULL,
  line             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id            INTEGER PRIMARY KEY,
  src_file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  src_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  dst_file_id   INTEGER REFERENCES files(id) ON DELETE SET NULL,
  dst_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  dst_name      TEXT NOT NULL,
  kind          TEXT NOT NULL,
  confidence    TEXT NOT NULL,
  line          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  module_path TEXT NOT NULL,
  tree_hash   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (module_path, tree_hash)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_name     ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file     ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_edges_src_symbol ON edges(src_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst_symbol ON edges(dst_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_src_file   ON edges(src_file_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst_file   ON edges(dst_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON imports(resolved_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_file     ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_files_path       ON files(path);
