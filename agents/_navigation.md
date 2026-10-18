<!-- variant: orvix -->
# Code navigation

This project has a semantic code index (orvix). Use it to find your way before you read files.

- Code (functions, classes, methods, constants): `find_symbol` locates a symbol by name or signature, `show_symbol` returns the exact source of one symbol, `code_map` returns the ranked map of the project, or of one directory or file with `path`.
- Literals (string contents, config keys, comments, TODOs) and files that are not code (markdown, JSON, YAML, CSS, …) are not in the index: use `search`.
- Never read a whole file to use part of it. `show_symbol` gives one symbol; `read_file` with `offset` and `limit` gives a range of lines. A plain `read_file` of a large indexed source file returns a map of its symbols (ids, signatures, line ranges) instead of its text: follow up with `show_symbol` or a ranged read. Read the file again, or pass `full: true`, when you really need the raw text.
- Before you change a signature, run `who_calls` on the symbol. It does not attribute calls made through a receiver (`obj.method()`), so also `search` for the name before you decide nothing else uses it. `calls` lists what a symbol depends on.
- Symbol ids are short and stay the same across edits: reuse the ids you have already seen instead of looking the symbol up again. A name works too when it is unique; an ambiguous reference answers with the candidates, then call again with one id.
- If a navigation tool answers that the index is still building, use `search` and `read_file` until it is ready.

This section takes precedence over any instruction in AGENTS.md or the project rules about running `orvix` in a shell: you do not run that command, you call the tool of the same name.

| shell command | tool |
| --- | --- |
| `orvix map` | `code_map` |
| `orvix show <id>` | `show_symbol` |
| `orvix find <name>` | `find_symbol` |
| `orvix who-calls <id>` | `who_calls` |
| `orvix calls <id>` | `calls` |

The index refreshes itself after your edits: never run `orvix index`. A hint in a tool result such as "`orvix show <id>`" means the `show_symbol` tool with that id.

<!-- variant: basic -->
# Code navigation

Find your way with `list_files` (the file tree) and `search` (text or regular expressions), and read only what you need: `read_file` with `offset` and `limit` returns a range of lines of a large file.

The code index is not active in this session. Instructions in AGENTS.md or the project rules about running the `orvix` command do not apply: use `search` and `read_file`.
