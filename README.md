# aicode

`aicode` is a natural-language CLI assistant for your project folders. Run it inside any directory and ask it things in plain language (English, Spanish, Portuguese, French or Japanese) — it reads the folder as context and picks the right action for the request: answering questions, generating code, writing docs, creating diagrams, presentations, podcasts and more.

Its distinctive feature is that every capability is a plain **markdown file** (an "action") that combines a prompt template, a response schema, and executable code blocks — so you can add new capabilities without touching the core.

## Install

```bash
npm install -g aicode
```

Requires Node.js 20+.

## Setup

On first run, aicode asks for your API keys and stores them in `~/.aicode/keys.json`:

- **OpenAI** (`OPENAI_KEY`) — used for the smart tier (`gpt-5.5`) and fast tier (`gpt-5.4-mini`)
- **Anthropic** (`ANTHROPIC_KEY`) — `claude-sonnet-5` / `claude-haiku-4-5`
- **Groq** (`GROQ_KEY`) — fast open-weights models
- **Replicate** (`REPLICATE_API_TOKEN`) — optional, for image/video/speech actions

Only one provider is required. Keys can also be provided via environment variables or a `.env` file.

### Local models (offline use)

If you have **Ollama** or **LM Studio** running and no cloud keys configured, aicode detects the local server automatically and lets you pick an installed model — no account needed. You can also force local mode for any run (e.g. for private codebases):

```bash
aicode "explain this project" --local
```

Local settings live in `~/.aicode/keys.json` as `LOCAL_BASE_URL`, `LOCAL_MODEL`, and optionally `LOCAL_FAST_MODEL` and `LOCAL_CONTEXT` (context window size, defaults to 32000). Any OpenAI-compatible server works (Ollama, LM Studio, llama.cpp server, vLLM).

## Usage

```bash
cd your-project
aicode "your request in natural language" [options]
```

Options:

| Flag | Description |
|------|-------------|
| `-l, --language <lang>` | Language for the output (auto-detected by default) |
| `-c, --confirm` | Ask before writing files or running commands |
| `--local` | Force the local model provider for this run |
| `-d, --debug` | Verbose debug output |

### Examples

```bash
# ask anything about the current folder
aicode "what does this project do?"
aicode "how many API endpoints are defined and where?"

# generate documentation
aicode "write a README for this project"
aicode "document this project in Japanese"

# generate or modify code (asks for plan approval first)
aicode "add input validation to the signup form" --confirm

# other built-in actions
aicode "create a diagram of the architecture"
aicode "create a podcast reviewing this codebase"
aicode "create a presentation about this project"
```

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

Code blocks have access to helpers like `queryLLM(question, zodSchema)`, `queryContext(question, zodSchema)` (includes the project as context), `writeFile`, `readFile`, `editFile(file, instructions)` (targeted search/replace edits), `ask`, `select`, `log`, `t()` (translate), `executeBash`, `executePython`, and Replicate media helpers.

## License

MIT
