# aicode

`aicode` is a natural-language CLI assistant for your project folders. Run it inside any directory and ask it things in plain language (English, Spanish, Portuguese, French or Japanese) — it reads the folder as context and picks the right action for the request: answering questions, generating code, writing docs, creating diagrams, presentations, podcasts and more.

Its distinctive feature is that every capability is a plain **markdown file** (an "action") that combines a prompt template, a response schema, and executable code blocks — so you can add new capabilities without touching the core.

- **Modern terminal UI** — a branded header, live step transcript with durations, progressively rendered (syntax-highlighted) markdown answers, colored diff previews before file writes, and a model/token/cost/time footer.
- **Interactive TUI session** — run `aicode` with no arguments for a REPL-style session with a scrollback transcript, slash commands, and a live token/cost status bar.
- **Multi-provider** — OpenAI, Anthropic, Groq, plus any local OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM).
- **Extensible** — drop a markdown file in `actions/` to add a new capability.

## Install

```bash
npm install -g aicode
```

Requires Node.js 20+.

## Interactive session (TUI)

Run `aicode` with **no input** (or `aicode --tui`) inside a project to open an interactive session:

```bash
cd your-project
aicode
```

```
aicode v2.0.0  ·  /path/to/your-project  ·  openai/gpt-5.5

  interactive session · type a request, /help for commands, /exit to quit

❯ what does this project do?
```

Features:

- **Scrollback transcript** — completed steps, answers and diffs stay in your terminal history (selectable/copyable).
- **Live region** — the current step spinner and the streaming answer preview render in real time.
- **History** — press `↑` / `↓` to reuse previous prompts.
- **Esc** — cancels the current run.
- **Status bar** — shows the working directory, provider/model, and the running token/cost total for the session.

Slash commands:

| Command | Description |
|---------|-------------|
| `/help` | Show the available commands |
| `/actions` | List the available action templates |
| `/model` | Choose the primary model provider for this session |
| `/local` | Toggle the local model provider (Ollama/LM Studio) |
| `/clear` | Clear the screen transcript |
| `/exit` | Quit the session |

## One-shot usage

```bash
cd your-project
aicode "your request in natural language" [options]
```

Options:

| Flag | Description |
|------|-------------|
| `-l, --language <lang>` | Language for the output (auto-detected by default) |
| `-c, --confirm` | Ask before writing files or running commands (shows a diff first) |
| `-q, --quiet` | Print only the final answer — no header, steps or footer (ideal for piping) |
| `--local` | Force the local model provider for this run |
| `--tui` | Open the interactive TUI session |
| `-d, --debug` | Verbose debug output (also prints full error stack traces) |

Output automatically switches to clean, uncolored, sequential text when piped (e.g. `aicode "..." | cat`), and honors the `NO_COLOR` environment variable.

### Examples

```bash
# ask anything about the current folder
aicode "what does this project do?"
aicode "how many API endpoints are defined and where?"

# generate documentation
aicode "write a README for this project"
aicode "document this project in Japanese"

# generate or modify code (shows a diff and asks before writing)
aicode "add input validation to the signup form" --confirm

# pipe a clean answer into another tool
aicode -q "summarize the architecture in three bullets" > summary.md

# other built-in actions
aicode "create a diagram of the architecture"
aicode "create a podcast reviewing this codebase"
aicode "create a presentation about this project"
```

## Setup

On first run, aicode asks for your API keys and stores them (encrypted) in `~/.aicode/keys.json`:

- **OpenAI** (`OPENAI_KEY`) — used for the smart tier (`gpt-5.5`) and fast tier (`gpt-5.4-mini`)
- **Anthropic** (`ANTHROPIC_KEY`) — `claude-sonnet-5` / `claude-haiku-4-5`
- **Groq** (`GROQ_KEY`) — fast open-weights models
- **Replicate** (`REPLICATE_API_TOKEN`) — optional, for image/video/speech actions

Only one provider is required. Keys can also be provided via environment variables or a `.env` file. aicode routes each call to a **smart** tier (code generation, complex answers) or a **fast** tier (classification, routing) and falls back to the next configured provider on failure.

### Local models (offline use)

If you have **Ollama** or **LM Studio** running and no cloud keys configured, aicode detects the local server automatically and lets you pick an installed model — no account needed. You can also force local mode for any run (e.g. for private codebases):

```bash
aicode "explain this project" --local
```

Local settings live in `~/.aicode/keys.json` as `LOCAL_BASE_URL`, `LOCAL_MODEL`, and optionally `LOCAL_FAST_MODEL` and `LOCAL_CONTEXT` (context window size, defaults to 32000). Any OpenAI-compatible server works (Ollama, LM Studio, llama.cpp server, vLLM).

## Writing your own actions

Actions are markdown files in the `actions/` folder. Each action combines:

1. A ```` ```description ```` block — used to route user requests to the action.
2. A Handlebars prompt body — receives `{{source_tree}}`, `{{files}}`, `{{english_user_prompt}}`, `{{language}}`, etc.
3. An optional ```` ```json:schema ```` block — the structured response shape.
4. Executable code blocks — ```` ```js:pre ```` runs before the LLM call (to prepare context), ```` ```js ```` runs after (receives the response as `schema`). `bash` and `python` blocks are also supported.

Minimal example:

````markdown
```description
Counts the TODO comments in the project and reports them.
```

Project Path: {{ absolute_code_path }}

{{#each files}}{{#if code}}`{{path}}`:
{{{code}}}
{{/if}}{{/each}}

# List every TODO comment in the files above.

```json:schema
{
    "todos": [{ "file": "file path", "text": "the TODO text" }]
}
```

```js
log(`Found *${schema.todos.length}* TODOs`);
schema.todos.forEach((t) => log(`#${t.file}#: ${t.text}`));
```
````

Code blocks have access to helpers like:

- `queryLLM(question, zodSchema)` — an LLM call with no project context.
- `queryContext(question, zodSchema)` — an LLM call that includes the project folder as context.
- `writeFile(file, content)` / `readFile(file)` — file I/O (writes show a diff/created line, and respect `--confirm`).
- `editFile(file, instructions)` — targeted search/replace edits (shows a diff before applying).
- `ask(question)` / `select(question, choices)` — prompt the user (styled prompts, or plain fallback when non-interactive).
- `log(message, data)` / `debug(message, data)` — transcript output.
- `t(text)` — translate to the user's language.
- `executeBash(code)` / `executePython(code)` — run shell/Python (gated by `--confirm`).
- Replicate media helpers for image/video/speech generation.

The UI adapts to the run mode automatically: the same helpers render into the one-shot transcript, the interactive TUI, or plain piped output without any changes to the action.

## License

MIT
