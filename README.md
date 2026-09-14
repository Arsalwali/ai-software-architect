# ai-software-architect

Indexes a repository into a queryable architecture graph — files, symbols,
imports, and call/extends/implements/instantiates edges with an honest
confidence tier on each one — and exposes it to Claude Code (or any MCP
client) as a set of tools for answering "how does this codebase work"
questions.

## CLI

```bash
arch index [repo]    # build or incrementally update the index (default: .)
arch status [repo]   # report index freshness: current, stale, incomplete, or missing
arch serve            # run the MCP server on stdio
```

`arch index` is incremental by default — pass `-F`/`--full` to force a cold
rebuild, or `-f`/`--force` to delete a broken index (e.g. after a schema
version mismatch) before rebuilding. `-q`/`--quiet` suppresses progress
output.

## Using it from Claude Code

Index a repository once, then register the server:

```bash
arch index /path/to/repo
claude mcp add architect -- node /absolute/path/to/dist/cli.js serve
```

Or add it to `.mcp.json` in a project:

```json
{
  "mcpServers": {
    "architect": {
      "command": "node",
      "args": ["/absolute/path/to/dist/cli.js", "serve"]
    }
  }
}
```

Every tool takes an optional `repo` argument and defaults to the working
directory. The index refreshes itself: a small change is absorbed on the next
tool call, and a large one comes back labelled `stale` with a count rather than
blocking the call.

**A caveat about that default matters for how you register the server.**
`repo` defaults to `process.cwd()`, and for a spawned MCP server that
directory is frozen at spawn time — whatever the client's working directory
happened to be when it launched the process. Project-scoped registration
(the `.mcp.json` form above, or `claude mcp add` run from inside the project)
is fine, because the client spawns the server with the project root as its
cwd. It is silently wrong for a **user-level or global** registration: the
server will index whatever directory it happens to be spawned from — not
necessarily the repository you're asking about — and return a confident,
wrong-repo answer with no error to signal the mismatch. If you register
`architect` globally for use across multiple repositories, pass `repo`
explicitly on every call (or have the client do so) rather than relying on
the default.

### What the confidence tiers mean

Results carry the evidence behind them, and the distinction matters:

- **verified** — a type resolver confirmed the binding. Nothing emits this yet.
- **likely** — the name matched exactly one candidate reachable from the file's imports.
- **ambiguous** — the name matched several candidates. All are reported, because
  under-reporting what might break is worse than over-reporting it.
- **unresolved** — no candidate in this repository. External, builtin, or
  third-party. Not uncertainty, just an absent target.

`unresolved` and `ambiguous` are never conflated: an absent target and a
genuinely uncertain one are different findings, and merging them would hide
which case you're in.

`impact_of` additionally reports whether a matched symbol is exported from a
file it recognises as a package entry point, as `exportedFromEntryPoint`.
`false` means only "not detected as an entry point by this check" — it is
not a safety verdict, and it is not a claim that changing the symbol is safe.
An unconventionally named entry file, or one with no matching `package.json`
declaration, will also read `false`.
