<!-- orvix:start -->
## Codebase navigation (orvix)

This project is indexed by orvix. Prefer it over `grep` and over reading whole files.

- `orvix map --budget 2000` — the project's symbols, most important first
- `orvix show <id>` — one symbol's exact source. Do not read the whole file.
- `orvix find <name>` — locate a symbol when you don't have its id
- `orvix who-calls <id>` — every caller. Run this before changing a signature.
- `orvix calls <id>` — what a symbol depends on

Ids are short and stable across edits: reuse an id you were given earlier rather than
re-running `map`. Names work too — `orvix show validate`, `orvix show Service.validate`.

Queries answer from a prebuilt index and never reparse on their own, so run
`orvix index` after you change files. (Under Claude Code this is automatic: a hook marks
edited files and the next query picks them up.)

Do not use orvix for files outside TypeScript, TSX, JavaScript, Python, Go and Rust —
read those directly. Do not use it for anything that is not a symbol: string literals,
configuration keys, comments, TODOs. Use `grep` for those.
<!-- orvix:end -->
