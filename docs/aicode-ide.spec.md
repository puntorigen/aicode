# aicode IDE

aicode gains a VS Code/Cursor-style interface: `aicode ide` downloads and launches a local VS Code web (code-server) with a preinstalled aicode extension, connected over a loopback WebSocket to an Agent Server that runs the existing `runPrompt` pipeline and agent loop. The same core gains Auto/Agent/Plan/Ask modes, orvix-based code navigation on by default, project memory from `AGENTS.md` + Cursor rules, Cursor-installed skills, Cursor conversations as context, parallel sub-agents isolated in git worktrees, and an OpenRouter provider with a Cursor-style model picker (model + `MAX` effort, next to the mode selector) and in-IDE API-key settings.

This spec is the single source of truth for the implementation. It was written for an AI executor (Claude Sonnet 5.5 max) working inside the aicode repository: every identifier, path, message name, flag, and env var written in backticks is a contract to reproduce byte-exact; behavior described in prose is what to build; anything not mentioned is left to idiomatic judgment consistent with the existing code.

## Overview

### Intent

Keep aicode's prompt-as-plugin core and add surfaces and capabilities around it. The CLI (one-shot), the Ink TUI, and the new IDE share one runtime; the IDE is a thin client speaking a JSON protocol. Nothing in this spec changes what `aicode "..."` does today in `auto` mode without extra flags, except that code navigation gets cheaper (orvix), project memory gets richer (rules), and — once the user picks a model in the IDE or TUI — that `ModelSelection` becomes the default for every surface (`config.models.selected`), the way Cursor remembers the last model.

### Existing system this builds on (do not rewrite)

- `index.js` — yargs CLI, key prompts, provider detection, `codePrompt` engine factory (line ~278), `describeProvider` (~187), `runPrompt` (~506, the per-turn pipeline: fast-tier pre-flight classification → action template or agent loop), `additional_context` helpers (`writeFile`, `readFile`, `editFile`, `executeBash`, `ask`, `select`, …), dispatch to one-shot/TUI.
- `lib/engine.js` — `Code2Prompt` class: AI SDK v6 transport (`_complete`, `_withProviderFallback`), `runAgentLoop` (streamText + tools + `stepCountIs`), module-level usage ledger (`resetUsage`/`getUsage`/`_recordUsage`), `traverseDirectory` + `invalidateTraverseCache`.
- `lib/agents.js` — `loadAgents()` (parses `agents/*.md`: ```` ```description ````, ```` ```tools ````, body), `buildTools(runtime, allowed)` (AI SDK `tool()` registry over `ctx` helpers), `readProjectMemory(cwd)`, `projectBrief`, `runAgent({ engine, agentName, agents, task, ctx, ui, history, depth, streamAnswer, skill })`, `MAX_DEPTH = 2`, `MAX_OUTPUT_CHARS = 12000`.
- `lib/ui.js` — transcript renderer; the UI interface is: `header, footer, step(label)→{update,done,fail}, status, statusStart, statusStop, streamStart, streamChunk, streamEnd, isStreaming, answer, markdown, raw, note, debug, diff(file, oldStr, newStr), fileWritten(file,{created,lines}), error, confirm, select, ask, progressShim, dispose, colorize, renderMarkdown`.
- `lib/tui/index.mjs` — Ink TUI; `makeTuiAdapter(controller, shared)` re-implements the UI interface; slash commands; `sessionHistoryRef` + `trimSessionHistory`; `startTui(deps)`.
- `lib/skills.js` — `skillDirs(cwd)`, `discoverSkills(cwd)` (cap `MAX_SKILLS = 60`, `MAX_DESC = 300`), `loadSkill`, `installSkill`.
- `lib/models.js` — `PROVIDERS` (`OPENAI`, `ANTHROPIC`, `GROQ`, `LOCAL` with `tiers`/`efforts`), `PRICES`, `EFFORT_BUDGETS` (`none 0, low 4000, medium 8000, high 16000, xhigh 32000, max 64000`), `resolveModelSpec` (honors `OPENAI_MODEL`/`ANTHROPIC_MODEL`/`GROQ_MODEL`/`ANTHROPIC_EFFORT` from config), `resolveProvider`, `createModel`, `callOptions` (Anthropic extended thinking only), `hasCredentials`, `modelId`, `estimateTokens`, `estimateCost`.
- `helpers/db.js` — `EncryptedJsonDB('keys.json')` with `load()`/`save(data)`; `index.js` reads it once into `db_keys_data` and passes the fields into every engine's `config`; engine default preference order `["OPENAI","ANTHROPIC","GROQ","LOCAL"]`; `setModelPreferences` always appends `LOCAL` when configured.
- `agents/main.md`, `explorer.md`, `coder.md`, `reviewer.md`; `actions/*.md` (some call `setModelPreferences([...])` to reorder providers); `test/agent-loop.test.mjs` (`npm test`, must keep passing).

### Guidance for the implementer

- Work only on the branch `feature/aicode-ide` cut from `main`, never on `main` itself; every phase ends in a commit and the work ships as one pull request to `main` (see `## Version control`).
- Deliver in the order of `## Delivery phases`. After every phase: `node --check` on changed CJS files, `npm test` green, and `aicode "what does this project do?"` still works.
- CommonJS for everything under `lib/` except `lib/tui/index.mjs` (ESM). Tests are `.mjs` under `test/`. The extension is TypeScript bundled by esbuild.
- Reuse the existing confirm gate (`confirmAction`), diff preview, usage ledger, and abort signal; never add a parallel mechanism.
- When this spec says "confirm-gated", it means: the operation goes through `ctx.confirmAction(description)` which returns `true` immediately unless `flags.confirm` is on, in which case the UI's `confirm` prompt decides.
- Never write into Cursor's own storage (`~/.cursor`, `~/Library/Application Support/Cursor`). Never modify a user's `.gitignore` or `AGENTS.md` unless they run an explicit command for it.
- Keep user-facing strings in English; add yargs option descriptions to both `locales/en.json` and `locales/es.json`.

## Constraints

### Dependencies

- Add to `dependencies`: `ws` (`^8.18.0`), `orvix-cli` (`^0.2.0`), `minimatch` (`^9.0.0`; `npm install minimatch@^9.0.0` records `^9.0.9`, the newest 9.x, and that is what `package.json` carries), `@openrouter/ai-sdk-provider` (`^2.10.0` — the 2.x line is the last one whose peer dependency is `ai ^6.0.0`; 3.x requires `ai@7`, so do not upgrade it while `ai@6` stays).
- Add to `optionalDependencies`: `@vscode/ripgrep` (`^1.15.0`).
- Add to `devDependencies` (root `package.json`, no nested installs): `esbuild` (`^0.24.0`), `typescript` (`^5.6.0`), `@types/vscode` (`^1.96.0`), `@types/node` (`^20.0.0`), `@types/react` (`^19.0.0`), `@types/ws` (`^8.5.0`), `@vscode/codicons` (`^0.0.36`).
- Keep `ai@6`, `zod@3`, `ink@6`, `react@19` as they are. No Electron, no Tauri, no new UI frameworks.

### Packaging

- `.gitignore` currently ignores `dist` (line 92), which would also drop the extension bundle from npm publishes (no `.npmignore`, no `files` field). Append the negation line `!ide/extension/dist/` to `.gitignore` so the built bundle is committed and published.
- `package.json` scripts: `"build:ide": "node ide/extension/build.mjs"`, `"prepublishOnly": "npm run build:ide"`, `"test": "node test/run.mjs"` (see `## Verification`).

### Security

- The Agent Server binds `127.0.0.1` only and requires a per-process random token on the first message; connections that do not authenticate within 5 s are closed.
- code-server runs with `--auth none` but is bound to `127.0.0.1` and told `--trusted-origins http://127.0.0.1:$port,http://localhost:$port`.
- Cursor data is read with `sqlite3 -readonly` or file reads only.
- API keys are accepted only over the authenticated loopback socket (`keys.set`), stored through the existing `EncryptedJsonDB`, and never sent back, logged, or echoed in `ui.debug`; clients only ever see `masked` values.

### Behavior preservation

- `flags.mode = 'auto'` reproduces today's routing exactly (`needs_agent`, skill matching, classic templates).
- Intentional exception: the default provider order becomes `DEFAULT_PROVIDER_ORDER` (`OPENROUTER, ANTHROPIC, OPENAI, GROQ, LOCAL`, see `## Models and providers`). A user holding both an OpenAI and an Anthropic key, who today routes to OpenAI by default, routes to Anthropic after this change unless a model is selected; document this in the README.
- Existing agent tool names keep their names and schemas; new tools are additive.
- The static usage ledger API (`Code2Prompt.resetUsage()/getUsage()`) keeps working when no per-turn ledger is installed (the existing test relies on it).

## Storage and configuration

### `Config` (`~/.aicode/config.json`)

Plain JSON (unlike `keys.json`, which stays encrypted via `helpers/db.js`). Read by `lib/config.js` → `loadConfig()`, which deep-merges over these defaults:

```json
{
  "orvix": { "enabled": true, "mapBudget": 1500 },
  "skills": { "ignore": [], "allow": [] },
  "conversations": { "cursorImport": true, "sqlite": true },
  "ide": { "version": "4.141.0", "port": 0, "open": true, "confirm": true },
  "server": { "port": 7865 },
  "models": {
    "selected": null,
    "recent": [],
    "featuredVendors": ["anthropic", "openai", "google", "moonshotai", "z-ai", "deepseek", "x-ai", "qwen", "mistralai"],
    "catalogTtlHours": 24,
    "fallbackOnError": false
  }
}
```

- **Behavior:** a missing or malformed file yields the defaults; malformed JSON logs a debug note, never throws. `models.selected` is a `ModelSelection` or `null`; `models.recent` is a list of model ids (newest first, max 8); see `## Models and providers`. `orvix.mapBudget` (tokens, default 1500, at most 20000) sizes the code map in the system brief; an optional `orvix.bin` (a path, not part of the defaults) names an executable that answers every orvix command in place of the bundled `orvix-cli`; see `## Code navigation`.
- **`keys.json` fields added:** `OPENROUTER_KEY` (credential), `OPENROUTER_MODEL`, `OPENROUTER_FAST_MODEL`, `OPENROUTER_EFFORT` (optional overrides, same semantics as the existing `ANTHROPIC_MODEL`/`ANTHROPIC_EFFORT`).

### Directory layout

- `~/.aicode/keys.json` — existing encrypted credentials.
- `~/.aicode/config.json` — `Config`.
- `~/.aicode/ide/downloads/` — code-server tarballs; `~/.aicode/ide/code-server-$version-$platform/` — extracted builds; `~/.aicode/ide/extensions/aicode.aicode-ide-$version/` — the unpacked extension; `~/.aicode/ide/data/` — code-server `--user-data-dir`; `~/.aicode/ide/logs/code-server.log`.
- `~/.aicode/projects/$slug/sessions/$sessionId.jsonl` — persisted aicode sessions (`$slug` per `Project slug`).
- `~/.aicode/worktrees/$slug/$id/` — isolated sub-agent worktrees.
- `~/.aicode/cache/conversations/$conversationId.md` — conversation summaries; `~/.aicode/cache/cursor-composers.json` — cached SQLite listing; `~/.aicode/cache/openrouter-models.json` — cached OpenRouter model catalog (`Catalog`).
- Project-local: `.aicode/memory.md` (existing), `.aicode/plans/*.plan.md` (new), `.orvix/` (orvix index, owned by orvix).

### Environment variables

- `AICODE_AGENT_URL` — `ws://127.0.0.1:$port`; `AICODE_AGENT_TOKEN` — handshake token. Set by the launcher for the code-server process; read by the extension.
- `AICODE_IDE_DIR` — overrides `~/.aicode/ide`. `AICODE_IDE_VERSION` — overrides `config.ide.version`.
- `AICODE_NO_ORVIX=1` (also `true`, `yes`, `on`) — disables the orvix layer entirely; `test/run.mjs` sets it for every test file but the ones that exercise the layer. `AICODE_NO_CURSOR_IMPORT=1` — disables reading Cursor skills, rules-from-`.cursor` stay enabled (they belong to the repo), and Cursor conversations.
- `OPENROUTER_KEY` — OpenRouter credential, read like `OPENAI_KEY` is today (env wins over nothing, `keys.json` wins over env once saved); `OPENROUTER_API_KEY` (OpenRouter's conventional name) is accepted as a fallback. `AICODE_OPENROUTER_API` — base URL for OpenRouter: the REST calls made by `lib/openrouter.js` and the `baseURL` of the model client built by `createModel('OPENROUTER', …)`, so tests can run a whole request, cost accounting included, against a local stub (default `https://openrouter.ai/api/v1`).

## Core modules

### `lib/runtime.js`

The per-session pipeline, extracted from `index.js` with no behavior change.

- **Inputs:** `createRuntime({ cwd, keysData, flags, debug, ide, sessionId })` where `sessionId` is what the code index's result compression remembers a session by (a random id when omitted) and `flags` is a mutable object `{ confirm: boolean, local: boolean, mode: 'auto'|'agent'|'plan'|'ask', language: string|null, quiet: boolean, debug: boolean, modelPreferences: string[]|null, model: ModelSelection|null }` and `ide` is an optional `IdeBridge` (see `IDE RPC`). `keysData` is kept by reference (see `Credentials`).
- **Returns:** a `Runtime`: `{ cwd, flags, keysData, ide, orvix, runPrompt, describeProvider, listActions, codePrompt, makeFileHelpers, usage }` (`orvix` is the project's code index, see `Code navigation`).
- **Behavior:**
  - `runPrompt(input, ui, opts)` is today's function body. `opts` adds: `history` (array of `{ role, content }`), `refs` (array of `Ref`, see `Mentions and refs`), `editor` (see `Editor context`), `modeOverride` (a mode used for this turn only; anything that is not one of `MODES` counts as `auto`), `verbatim` (run the turn on `input` exactly as written: the router classifies an excerpt of it and its English version is not used; the Implement flow sets it, see `Implement flow` — this replaces the `planPath` the first draft of this spec listed, because the entry points compose the text themselves), `sessionId` (used as the orvix hook `session_id` and for persistence), `model` (a `ModelSelection` for this turn only). Model preferences come from `opts.modelPreferences || flags.modelPreferences`; an active `ModelSelection` (`opts.model || flags.model`) takes precedence over both and is applied to every engine the turn creates with `applyModelSelection` (see `Applying a selection`). When `flags.model` was not set by the caller, `createRuntime` seeds it from `config.models.selected` if that provider still has credentials.
  - Every `argv.*` read inside the moved code becomes `flags.*`. `additional_context.argv` is kept as an alias of `flags` (no action template reads it today; the alias is for backward compatibility).
  - `makeFileHelpers(baseDir, ui, confirmAction)` builds `{ readFile, writeFile, editFile, executeBash }` bound to `$baseDir`, so the same helpers can be rebuilt for a worktree. The main `additional_context` uses it with `baseDir = cwd`.
  - `writeFile` is changed to compute the diff before asking: read the previous content, call `ui.diff(display, previous, content)` when the file exists and differs, then `confirmAction("write file #$display#")`, then write. (`editFile` already shows the diff first.)
  - A per-turn `UsageLedger` (see below) is created at the start of `runPrompt` and installed on every engine the turn creates; the usage returned to callers comes from it.
  - `runPrompt` is a thin wrapper around the pipeline body (`runTurn`): it first calls `orvix.ensureIndex({ ui })` (a project with no index starts building one while the router thinks, shown as a step), runs the turn, and in a `finally` detaches the step of a build that outlived the turn. `additional_context.orvix` hands the index to the agent loop, which registers the navigation tools only when it is enabled; a turn that goes to the agent waits up to 3 s for a first build. The `codePrompt` ignore list gains `**/.git/**` and `**/.orvix/**` (see `Index lifecycle`).
- **Implementation:** `index.js` becomes a thin CLI: yargs, key prompts, `createRuntime`, dispatch. Move `findBestRatio`, `detectLocalProvider` (stays in `index.js`, it prompts), replicate model wrappers, and the `codePrompt` factory into the runtime module.

### `UsageLedger` (in `lib/engine.js`)

- **Behavior:** `new Code2Prompt.UsageLedger()` with `record(provider, tier, model, usage)`, `summary()` (same shape `getUsage()` returns today), `reset()`. `engine.setUsageLedger(ledger)` installs it; `_recordUsage` writes to the instance ledger when set, otherwise to the module-level static ledger. This makes concurrent sessions safe without breaking the static API.

### `lib/config.js`

- **Behavior:** `loadConfig()` (cached for the process, `reloadConfig()` to refresh), `configPath()`, and `saveConfig(partial)` — deep-merges `partial` into the current file contents (arrays replace, objects merge), writes `~/.aicode/config.json` with 2-space JSON, and refreshes the cache. Deep-merge defaults from `Config`.

### `lib/history.js`

- **Behavior:** `trimSessionHistory(history, maxTurns = 10, maxChars = 32000)` — keep the last `$maxTurns` user/assistant pairs and drop oldest pairs while total content length exceeds `$maxChars`. The TUI imports it (`import historyLib from '../history.js'`) instead of its local copy; the server uses it too.

### `index.js` (CLI surface)

- **Behavior:** adds commands `serve`, `ide`, `chats`, `orvix`, `models`, `keys`, and options `--mode`, `--plan`, `--ref-chat`, `--model` (details in `## CLI and TUI surfaces`). `--agent` becomes an alias: after parsing, `if (argv.agent && argv.mode === 'auto') argv.mode = 'agent'`. The first-run key prompts gain `Enter your OPENROUTER API key (or empty if none):`, asked first (before the OpenAI prompt, since OpenRouter heads `DEFAULT_PROVIDER_ORDER`; the existing prompts keep their relative order), and the "at least one provider" check counts `OPENROUTER_KEY`; the `serve`, `ide`, `models`, and `keys` commands never run the interactive key prompts. The OpenRouter prompt is asked only when both stdin and stdout are TTYs and reads the key masked (`ui.ask(message, { secret: true })`); an OpenRouter key found only in the environment (`OPENROUTER_KEY`, else `OPENROUTER_API_KEY`) is used for the run and never written to `keys.json` (the legacy `OPENAI`/`GROQ`/`ANTHROPIC` environment keys keep being persisted as today). `--model` first refreshes the catalog when an OpenRouter key exists (a failure falls back to the cache), then resolves the spec and checks credentials; an error prints and exits 1.

## Agent Server

### `lib/server/index.js`

A WebSocket server exposing the runtime to clients.

- **Inputs:** `startAgentServer({ host = '127.0.0.1', port = 0, token, runtimeFactory, debug })` where `runtimeFactory(cwd, flags)` returns a `Runtime`.
- **Returns:** `{ url, port, token, close() }`.
- **Behavior:**
  - Uses `ws`. Each connection must send `hello` with the right `$token` as its first message within 5 s; otherwise the socket is closed with code `4401`. Afterwards the connection may own many sessions.
  - One `Runtime` per session (sessions in the same `$cwd` may share a runtime; flags are per session, so give each session its own runtime object — a runtime is cheap).
  - One running turn per session; a second `session.input` while busy replies `session.error { code: 'busy' }`.
  - `session.cancel` aborts the turn's `AbortController` and resolves any pending prompt with `false`/`null`.
  - On client disconnect, running turns are aborted and sessions are kept in memory for 10 minutes so `session.resume` works after a page reload.
  - Default port for `aicode serve` is `config.server.port` (`7865`); the launcher always uses port `0` (ephemeral).

### `lib/server/adapter.js`

- **Behavior:** `makeWsAdapter(send, sessionId)` implements the full UI interface (`## Overview › Existing system`) by emitting the messages in `UI event mapping`. It keeps `lastAnswer` (set by `streamEnd`, `answer`, `markdown` when non-empty, like the TUI adapter), exposes `getLastAnswer()`/`resetAnswer()`, and tracks `lastDiffId` (set by `diff`, cleared by `fileWritten` and by `step(...).done/fail`) so `confirm()` can attach it.
- **Data:** step ids are `s$n` and diff ids `d$n`, `$n` incrementing per session; prompt ids `p$n`.

### `lib/server/sessions.js`

- **Behavior:**
  - `Session { id, cwd, flags, runtime, history, busy, abort, pendingPrompts: Map, pendingIdeCalls: Map, createdAt, title }`.
  - After each successful turn (not cancelled), append `{ role: 'user', content: $text }` and `{ role: 'assistant', content: $lastAnswer }` to `history` (trimmed with `trimSessionHistory`) and persist.
  - Persistence file `~/.aicode/projects/$slug/sessions/$sessionId.jsonl`: first line `{ "type": "session", "id": $sessionId, "cwd": $cwd, "createdAt": $iso, "title": $title }`; then, per turn, `{ "role": "user", "message": { "content": [{ "type": "text", "text": $text }] } }`, `{ "role": "assistant", "message": { "content": [{ "type": "text", "text": $answer }] } }`, `{ "type": "turn_ended" }` — the same shape as Cursor transcripts so `lib/conversations.js` reads both with one parser. `$title` is the first 80 characters of the first user input.
  - `listSessions(cwd)` reads the directory and returns `{ id, title, createdAt, updatedAt (file mtime), turns }`.

## Protocol

### Envelope

- Every message is one JSON object with a string `type`. Messages about a session carry `sessionId`. Request/response pairs share `id`. Unknown `type` → `error { code: 'unknown_type' }`. Payload fields are top-level (no nested `payload`).

### Client → server

- `hello { token, client: 'ide'|'cli'|'tui'|'test', version }` → `hello.ok { serverVersion, host }`.
- `session.create { cwd, flags? }` → `session.created { sessionId, cwd, flags, provider, model, orvix: { enabled, symbols, indexing } }`. Omitted flags take defaults; for `client: 'ide'` the default `confirm` is `config.ide.confirm` (`true`). `flags.model` in the reply is the resolved `ModelSelection|null`; `provider`/`model` are the display chip from `describeProvider()` (empty strings when no provider is configured).
- `session.resume { sessionId }` → `session.resumed { sessionId, cwd, flags, provider, model, orvix: { enabled, symbols, indexing }, turns: [{ role, text }] }` (from memory, else from the persisted file; unknown id → `error { code: 'not_found' }`).
- `session.list { cwd }` → `session.list { sessions: [{ id, title, createdAt, updatedAt, turns }] }`.
- `session.input { sessionId, text, refs?: Ref[], editor?: EditorContext }` → stream of `ui.*`, then `session.done { sessionId, usage }`.
- `session.cancel { sessionId }`.
- `session.flags { sessionId, flags }` (partial) → `session.flags { sessionId, flags }` (full, after merge). When the partial contains `model`: a `ModelSelection` is validated (`provider` is a known provider, `model` is a non-empty string, `effort` is `null` or in `EFFORT_ORDER`, and `hasCredentials(provider)` holds) — invalid → `session.error { sessionId, code: 'unknown_model' | 'no_credentials', message }` and no change; valid → stored on the session's `flags.model` and persisted per `Applying a selection › Persistence`. `model: null` clears the selection (and `config.models.selected`).
- `session.input` on a session whose `cwd` has no configured provider at all → `session.error { sessionId, code: 'no_provider', message: 'no API key configured — add one in Settings' }` without running a turn.
- `prompt.response { id, value }`.
- `ide.result { id, result?, error? }`.
- `catalog.get { id, kind: 'skills'|'conversations'|'plans'|'rules', cwd, query? }` → `catalog.result { id, kind, items }`. `cwd` must be an existing absolute directory (`error { code: 'bad_cwd' }` otherwise); `query` is a string of words that must all appear (any case) in the item's text, anything else is no query. The kinds arrive with the phase that owns them: `plans` and `rules` with `Modes`, `skills` with the skills phase and `conversations` with the conversations phase; a kind that does not exist (yet), or is a property every object has (`toString`, `__proto__`), answers `error { id, code: 'bad_request', message: 'unknown catalog kind: $kind. Available: $kinds' }`. `plans` items are `{ path, title, overview, todos: [{ id, content, status }], updatedAt }` (see `lib/plans.js`), newest first, at most 50, matched on title, overview and path; `rules` items are `{ name, description, globs, alwaysApply, file }` (the rule text stays on the server), matched on name and description.
- `plan.implement { sessionId, path }` → behaves like `session.input` with the text defined in `Implement flow`, `modeOverride: 'agent'` and `verbatim: true`; the user turn it persists is that text. Only a file inside the session's project can be named, since the path comes from a client: a missing or blank `path`, a file that does not exist, a directory, a file outside the project (also through `..` or a link), or one over 100 KB → `session.error { sessionId, code: 'bad_request', message }` with the reason (`plan not found: $path`, `not a file: $path`, `the plan must be inside the project: $path`, `the plan is too large to implement ($n KB, the limit is 100 KB): $path`); then the checks of `session.input` apply (`busy`, `no_provider`, `unknown_model`/`no_credentials`), and a session the connection does not own is `not_found`.
- `orvix.command { sessionId, command: 'status'|'index'|'init'|'gain', agents?: string[] }` → `orvix.status { id?, sessionId, enabled, symbols, indexing, saved?, output? }`. `output` is one human-readable line (for `init`, orvix's own output) and `saved` (tokens) comes with `gain`. `status` of a project where the layer is off answers `output: 'the code index is off for this project: $reason'` (so does `index`, without running anything); a runtime without a code index answers `output: 'the code index is not available in this session'`; `index` runs a pass now and answers `$files files, $symbols symbols ($added added, $updated updated, $removed removed)`; `init` takes `agents` (strings, any case, from `claude`, `codex`, `cursor`, `gemini`). An unknown command, malformed `agents` or an unknown agent → `session.error { code: 'bad_request' }` before orvix runs; a session the connection does not own → `not_found`.
- `models.list { id, query?, refresh? }` → `models.result { id, models: ModelInfo[], selected: ModelSelection|null, catalog: { fetchedAt, count, stale } | null, error? }` (see `Model catalog`). With `refresh: true` the OpenRouter catalog is fetched before answering (15 s timeout; on failure answer from the cache and set `error`). Without it, a stale catalog is refreshed in the background after answering.
- `keys.list { id }` → `keys.status { id, providers: KeyStatusRow[] }`.
- `keys.set { id, provider, value }` → `keys.status` (after saving); failures → `error { id, code: 'invalid_key', message }`. `value` is a string, or `{ baseURL, model, fastModel? }` for `LOCAL`.
- `keys.remove { id, provider }` → `keys.status`.
- `keys.test { id, provider }` → `keys.testResult { id, provider, ok, detail }`.
- Raw key values never travel server → client; only `masked` (see `Credentials`).

### Server → client

- `error { id?, code, message }`, `session.error { sessionId, code, message }`.
- `ui.step.start { sessionId, stepId, label }`, `ui.step.update { stepId, label }`, `ui.step.end { stepId, ok, label, elapsed, extra }`.
- `ui.status { sessionId, text }`, `ui.status.stop { sessionId }`.
- `ui.stream.start { sessionId }`, `ui.stream.chunk { sessionId, text }`, `ui.stream.end { sessionId, text }` (`text` = the complete streamed markdown).
- `ui.answer { sessionId, text, markdown }`, `ui.markdown { sessionId, text }`, `ui.raw { sessionId, text }`, `ui.note { sessionId, message, data, color }`, `ui.debug { sessionId, message, data }`.
- `ui.diff { sessionId, diffId, file, oldText, newText }`, `ui.fileWritten { sessionId, file, created, lines }`, `ui.error { sessionId, message, stack }`, `ui.footer { sessionId, usage }`, `ui.header { sessionId, info }`.
- `prompt.request { id, sessionId, kind: 'confirm'|'select'|'ask', message, initial?, choices?: [{ title, value, description? }], placeholder?, diffId? }`, `prompt.resolved { id, cancelled }`.
- `ide.call { id, sessionId, method, args }`.
- `plan.created { sessionId, path, title, overview, todos: [{ id, content, status }] }` (`path` relative to the project; every text is masked of key values).
- `orvix.status { sessionId, enabled, symbols, indexing }` is also pushed, unprompted, every time the status of the session's code index changes (an index run starts or ends, the symbol count moves); the stream starts with the session and stops when it expires or the server closes. Nothing else about the index (`dirty`, `reason`) travels.
- `catalog.result`, `orvix.status`, `models.result`, `keys.status`, `keys.testResult`, `session.created`, `session.resumed`, `session.list`, `session.flags`, `session.done`, `hello.ok`.

### UI event mapping

- `header(info)` → `ui.header`; `footer(summary)` → `ui.footer`.
- `step(label)` → `ui.step.start`; returned `update(t)` → `ui.step.update`; `done(extra)` → `ui.step.end { ok: true, elapsed }`; `fail(text)` → `ui.step.end { ok: false }`. `$elapsed` is seconds with one decimal, as a string, like `formatStep` expects.
- `status(text)`/`statusStart(text)` → `ui.status`; `statusStop()` → `ui.status.stop`.
- `streamStart()` → `ui.stream.start`; `streamChunk(c)` → `ui.stream.chunk`; `streamEnd()` → `ui.stream.end` with the accumulated text (and nothing when the buffer is empty).
- `answer/markdown/raw/note/debug/diff/fileWritten/error` → the same-named `ui.*` messages. `debug` is only emitted when the session's `flags.debug` is on.
- `confirm(message, { initial })` → `prompt.request { kind: 'confirm', diffId: $lastDiffId }` and awaits `prompt.response`; `select(message, choices)` → `kind: 'select'`; `ask(message, { placeholder })` → `kind: 'ask'`. Responses: confirm → boolean; select → chosen `value` or `null`; ask → string or `null`.
- `progressShim()` → `{ text, start, stop }` wired to `status*`; `dispose()` → no-op; `isStreaming()` → whether a stream buffer is open.
- `planCreated({ path, title, overview, todos })` → `plan.created` (missing details become empty strings and `[]`). This is a new optional UI method: the transcript UI (`lib/ui.js`, silent under `--quiet`) and the TUI adapter implement it as a note `plan written to $path` followed by a dim line that says how to start the implementation (`implement it with: aicode --plan $path` in the terminal, `implement it with /plan build` in the TUI); callers check `typeof ui.planCreated === 'function'`.

### IDE RPC (`ide.call`)

- **Behavior:** the runtime receives an `IdeBridge` with `call(method, args) → Promise<result>` which sends `ide.call { id, method, args }` and resolves on `ide.result`. Timeout 10 s → rejects with `Error('IDE did not answer: $method')`. Only sessions created by a `client: 'ide'` connection have a bridge; tools that need it are not offered otherwise.
- **Methods:** `getDiagnostics { path? } → [{ file, line, column, severity: 'error'|'warning'|'info'|'hint', message, source }]` (file paths relative to `cwd`; at most 200 entries, errors first); `openFile { path, line? } → true`; `getActiveContext {} → EditorContext`.

### Editor context

- **Data:** `EditorContext = { activeFile: string|null, selection: { startLine, endLine, text }|null, openFiles: string[] }` (paths relative to `cwd`, `text` capped to 4000 chars). The extension attaches it to every `session.input`; the runtime injects it into the system brief as a `# Editor context` section and uses `activeFile` for glob-scoped rules.

### Mentions and refs

- **Data:** `Ref = { kind: 'conversation', id } | { kind: 'skill', name } | { kind: 'file', path }`.
- **Behavior:** `conversation` refs append a `# Referenced conversation: $title` section (the summary from `Summaries`, max 4000 chars each) to the task text; `skill` refs select that skill directly (bypassing the router) exactly like a routed `selectedSkill`; `file` refs append the file contents (max 12000 chars) under `# Referenced file: $path`.

## Models and providers

OpenRouter becomes a first-class provider so one key gives access to the whole catalog (Claude, GPT, Gemini, Kimi, GLM, DeepSeek, …), and the user picks a concrete model — plus a Cursor-style `MAX` effort toggle — per session from the IDE, the TUI, or the CLI. Catalog facts below were verified against the live API on 2026-10-17.

### `ModelSelection`

- **Data:** `{ provider: 'OPENROUTER'|'OPENAI'|'ANTHROPIC'|'GROQ'|'LOCAL', model: string, effort: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'|null }`. `effort: null` means "the model's default".
- **Data:** `EFFORT_ORDER = ['none','minimal','low','medium','high','xhigh','max']` (ascending) in `lib/models.js` is the canonical ordering wherever efforts are compared; `EFFORT_BUDGETS` gains `minimal: 1000`.
- **Behavior:** `null` selection keeps today's routing (per-provider `*_MODEL` overrides from `keys.json`, provider fallback) over `DEFAULT_PROVIDER_ORDER`.

### `OPENROUTER` provider (`lib/models.js`)

- **Data:** `PROVIDERS.OPENROUTER = { contextSize: 128000, tiers: { smart: '~anthropic/claude-sonnet-latest', fast: '~anthropic/claude-haiku-latest' } }`. Both ids are OpenRouter "latest" aliases present in the live catalog; the per-model `contextLength` from the catalog overrides `contextSize` when cached.
- **Data:** `DEFAULT_PROVIDER_ORDER = ['OPENROUTER', 'ANTHROPIC', 'OPENAI', 'GROQ', 'LOCAL']` exported from `lib/models.js` (user decision). It is the single source of provider ordering: the `Code2Prompt` constructor default (`this.modelPreferences = [...DEFAULT_PROVIDER_ORDER]`, replacing today's literal `["OPENAI", "ANTHROPIC", "GROQ", "LOCAL"]`), `describeProvider()` (replacing today's loop over `['OPENAI', 'ANTHROPIC', 'GROQ']` in `index.js`), `listProviders` / `SettingsPanel` row order, the first-run key prompts, the `fallbackOnError` tail, the non-OpenRouter ordering in `listModels`, and the provider lists in the README. Never hard-code another order.
- **Behavior:**
  - `setModelPreferences(preferences, { strict = false } = {})` on the engine: filter unknown providers as today; when `strict` is false, append every provider of `DEFAULT_PROVIDER_ORDER` that has credentials and is not already listed (this generalizes today's LOCAL-only append, so an action template calling `setModelPreferences(["OPENAI","ANTHROPIC","GROQ"])` still works for a user whose only key is OpenRouter — it routes to the listed providers first, then OpenRouter). `strict: true` keeps exactly the given list. The action templates' own `setModelPreferences([...])` lists are not edited.
  - `hasCredentials('OPENROUTER', config)` → `config.OPENROUTER_KEY` is non-empty.
  - `resolveModelSpec('OPENROUTER', tier, config)`: smart model = `config.OPENROUTER_MODEL || tiers.smart`; fast model = `config.OPENROUTER_FAST_MODEL || tiers.fast`, but if a catalog is cached and the fast id is not in it, the fast tier uses the smart model. Smart effort = `config.OPENROUTER_EFFORT || null`; fast effort = `'none'`.
  - `resolveModelSpec` honors `config.$P_EFFORT` for every provider (`OPENROUTER_EFFORT`, `ANTHROPIC_EFFORT` as today, `OPENAI_EFFORT`, `GROQ_EFFORT`, `LOCAL_EFFORT`); `callOptions` acts on it only for `ANTHROPIC` (unchanged) and `OPENROUTER` (below) — the others accept and ignore it.
  - `contextSizeFor('OPENROUTER', config)` = the cached catalog entry's `contextLength` for the resolved smart model, else `128000`.
  - `createModel('OPENROUTER', tier, config)` = `createOpenRouter({ apiKey: config.OPENROUTER_KEY, headers: { 'HTTP-Referer': 'https://github.com/puntorigen/aicode', 'X-Title': 'aicode' } })($modelId, { usage: { include: true } })` using `createOpenRouter` from `@openrouter/ai-sdk-provider` (`usage.include` turns on OpenRouter usage accounting so responses carry the real cost).
  - `callOptions('OPENROUTER', tier, config, opts)`: return `{}` when `opts.structured` is true or the resolved `$effort` is `null`. Otherwise compute `$reasoning` from the cached catalog entry `$entry` of the model (via `loadCatalog()`):
    - `$entry.reasoning.supportedEfforts` is an array → `$sent` = `$effort` if included; otherwise the nearest lower value in `EFFORT_ORDER` that is included; if nothing lower is included, the lowest included value. If `$sent` would be `'none'` but `'none'` is not included, send no reasoning at all. `$reasoning = { effort: $sent }`.
    - `$entry.reasoning.supportedEfforts` is `null` → `$reasoning = { effort: $effort }` (the gateway accepts every value).
    - `$entry.reasoning` exists without `supportedEfforts` → `$reasoning = { max_tokens: EFFORT_BUDGETS[$effort] }` when `$entry.reasoning.supportsMaxTokens` is true and `$effort !== 'none'`; otherwise no reasoning.
    - `$entry` missing or without `reasoning` → `$reasoning = { effort: $effort }` for `$effort !== 'none'`; nothing for `'none'`.
    - When `$reasoning` was produced return `{ providerOptions: { openrouter: { reasoning: $reasoning } }, maxOutputTokens: min($entry.maxCompletionTokens || 32000, 64000) }`; otherwise `{}`.
  - `estimateCost(model, inputTokens, outputTokens)`: `PRICES[model]` first; otherwise the cached catalog entry's `pricing` (USD per token) → `inputTokens × pricing.prompt + outputTokens × pricing.completion`; otherwise `0`.

### `lib/openrouter.js`

- **API:** `fetchCatalog({ apiKey, force, onError }) → Promise<Catalog>`, `loadCatalog() → Catalog|null` (cache only, synchronous), `isStale(catalog, ttlHours)`, `normalizeModel(raw) → OpenRouterModel|null`, `verifyKey(apiKey) → Promise<KeyStatus>`.
- **Data:**
  - `Catalog = { fetchedAt: iso, models: OpenRouterModel[] }`, cached at `~/.aicode/cache/openrouter-models.json`.
  - `OpenRouterModel = { id, name, shortName, contextLength, maxCompletionTokens, pricing: { prompt, completion }, supportsTools, supportsStructuredOutputs, reasoning: { supportedEfforts: string[]|null, defaultEffort: string|null, mandatory: boolean, supportsMaxTokens: boolean } | null, created, isAlias, isFree }` — `pricing` values are numbers in USD per token parsed from the API's strings (`"0.000002"` → `0.000002`); `created` is unix seconds; `isAlias` = id starts with `~`; `isFree` = id ends with `:free`.
  - `KeyStatus = { ok: true, label, usage, limit, limitRemaining, isFreeTier } | { ok: false, error }`.
- **Behavior:**
  - `fetchCatalog`: `GET $AICODE_OPENROUTER_API/models` (`Authorization: Bearer $apiKey` when given — the endpoint is public), 15 s timeout. For each entry of `data`: drop it when `id` ends with `:batch` or `architecture.output_modalities` lacks `"text"`; `shortName` = `name` with everything up to and including the first `: ` removed (`Anthropic: Claude Sonnet 5.5` → `Claude Sonnet 5.5`; no `: ` → `name`); `contextLength = context_length`; `maxCompletionTokens = top_provider.max_completion_tokens` (may be null); `supportsTools` = `supported_parameters` includes `"tools"`; `supportsStructuredOutputs` = includes `"structured_outputs"`; `reasoning` from the API's `reasoning` object (`supported_efforts` → `supportedEfforts` (array or `null`), `default_effort` → `defaultEffort`, `mandatory` (default `false`), `supports_max_tokens` → `supportsMaxTokens` (default `false`)), `null` when the object is absent. Write the cache and return it. A fresh cache (younger than `catalogTtlHours`) is returned without a request unless `force` is true. On any failure (HTTP error, unparseable body, or an answer without a single usable model, which never replaces a good cache) call `onError(err)` when given (a throwing hook is ignored) and return the cached catalog when present, else rethrow.
  - `verifyKey`: `GET $AICODE_OPENROUTER_API/key` with `Authorization: Bearer $apiKey`, 10 s timeout → on HTTP 200 `{ ok: true, label: data.label, usage: data.usage, limit: data.limit, limitRemaining: data.limit_remaining, isFreeTier: data.is_free_tier }`; on 401/403 `{ ok: false, error: 'invalid key' }`; otherwise `{ ok: false, error: 'HTTP $status' }` (network errors → the error message).

### Model catalog

- **Data:** `ModelInfo = { provider, id, name, shortName, contextLength, pricing: { prompt, completion } | null, supportsTools, supportsStructuredOutputs, reasoning, created, groups: ('recent'|'featured')[], available }` — `pricing` here is USD per 1M tokens rounded to 2 decimals (for display); `reasoning` has the `OpenRouterModel` shape or is `null`.
- **Behavior:** `listModels({ keysData, config, query }) → { models: ModelInfo[], selected, catalog }` in `lib/models.js`:
  - `OPENROUTER` entries come from `loadCatalog()` (none, with `catalog: null`, when no cache exists yet); `available = hasCredentials('OPENROUTER', keysData)`.
  - `ANTHROPIC` entries: every key of `PROVIDERS.ANTHROPIC.efforts` plus its tier models; `OPENAI` and `GROQ`: tier models; `LOCAL`: `LOCAL_MODEL` and `LOCAL_FAST_MODEL` when set. For these `shortName = id`, `pricing` from `PRICES` (converted to per-1M) or `null`, `supportsTools = true`, `supportsStructuredOutputs = true`, `created = 0`, `reasoning = { supportedEfforts: ['none','low','medium','high','xhigh','max'], defaultEffort: PROVIDERS.ANTHROPIC.efforts[id] || 'none', mandatory: false, supportsMaxTokens: true }` for `ANTHROPIC` and `null` for the rest; `available = hasCredentials(provider, keysData)`.
  - `groups` contains `recent` when the id is in `config.models.recent`; `featured` when the model is one of the 3 newest (`created` desc) OpenRouter models of a vendor listed in `config.models.featuredVendors` (vendor = id prefix before `/`) that `supportsTools` and is neither `isAlias` nor `isFree`, or when it is a non-OpenRouter model of an available provider.
  - `query`: lowercase, split on whitespace; every token must be a substring of `id` or `name` lowercased (`sonnet 5.5` matches `anthropic/claude-sonnet-5.5`).
  - Order: `recent` (in `config.models.recent` order) → `featured` (OpenRouter entries first, vendor order from `featuredVendors`, newest first; then non-OpenRouter featured entries in `DEFAULT_PROVIDER_ORDER`) → everything else by `created` desc.
  - `catalog = { fetchedAt, count: models.length (OpenRouter only), stale: isStale(catalog, config.models.catalogTtlHours) }`.

### Model spec grammar

- **Behavior:** `parseModelSpec(spec, { keysData, config }) → ModelSelection` backs `--model`, `/model <spec>`, and the ids printed by `aicode models`:
  - Grammar: `[$provider:]$modelId[@$effort]` with `$provider ∈ openrouter|openai|anthropic|groq|local` (case-insensitive) and `$effort ∈ EFFORT_ORDER`. Example: `openrouter:anthropic/claude-sonnet-5.5@max`.
  - Without a prefix: an id containing `/` or starting with `~` is `OPENROUTER`; otherwise the first provider (walking `DEFAULT_PROVIDER_ORDER` without `OPENROUTER`, i.e. `ANTHROPIC, OPENAI, GROQ, LOCAL`) whose `listModels` entries contain the exact id; otherwise, when a catalog is cached, the first OpenRouter model whose lowercased `id` equals `$modelId` or ends with `/$modelId`.
  - Cursor-style phrases: when nothing matched, treat `$spec` as a `query`; a trailing token `max` (also `-max`, `.max`) is removed and sets `effort: 'max'`; run `listModels({ query })` and take the first entry with `supportsTools` (featured entries come first by construction). `sonnet 5.5 max` → `{ provider: 'OPENROUTER', model: 'anthropic/claude-sonnet-5.5', effort: 'max' }` with today's catalog.
  - No match → throw `Error('unknown model: $spec (use provider:model, see "aicode models")')`. A known provider prefix with nothing after it (`openai:`), an empty spec and an effort without a model (`@max`) are errors too, never phrases; an unknown effort throws `unknown effort "$e" in "$spec" (use none, minimal, …)`.

### Applying a selection

- **Behavior:** `applyModelSelection(engine, selection, keysData)` in `lib/runtime.js`, called on every engine a turn creates:
  - If `!hasCredentials(selection.provider, keysData)` → throw `Error('no credentials for $provider')` (the server maps it to `session.error { code: 'no_credentials' }`; CLI/TUI print it).
  - `engine.setModelPreferences([selection.provider], { strict: true })` (no automatic append, see `OPENROUTER provider`); when `config.models.fallbackOnError` is `true`, call it with `[selection.provider, ...DEFAULT_PROVIDER_ORDER.filter(p => p !== selection.provider)]` instead.
  - Set `engine.config.$P_MODEL = selection.model` and `engine.config.$P_EFFORT = selection.effort` where `$P` is the provider name (`OPENROUTER_MODEL`/`OPENROUTER_EFFORT`, `ANTHROPIC_MODEL`/`ANTHROPIC_EFFORT`, `OPENAI_MODEL`/`OPENAI_EFFORT`, `GROQ_MODEL`/`GROQ_EFFORT`, `LOCAL_MODEL`/`LOCAL_EFFORT`). For `LOCAL`, `LOCAL_FAST_MODEL` is left as configured.
  - The runtime's `setModelPreferences` helper (the one action templates call, implemented by the exported `applyTemplatePreferences(engine, order, { keysData, ui, local, selection })`) returns `true` without changes when `flags.local` is on or a selection is active. Otherwise it calls `engine.setModelPreferences(order)` and asks for a missing key (`Enter your *$P API key* (or empty if none):`, only for `OPENAI`, `GROQ`, `ANTHROPIC` in that order and only for providers the resulting list contains, one question per call, stored through `setKey`) **only when no provider of that list has credentials and the client can take a secret** (`ui.ask` exists and `ui.canAskSecrets !== false`; the WebSocket adapter sets it to `false`, so the IDE is never asked for a key through a prompt). A user with just an OpenRouter key is therefore never asked for an OpenAI key, which the previous behavior would have done.
  - `runPrompt` reports a selection that cannot run (`applyModelSelection` throws, e.g. its key was removed after it was chosen) through `ui.error` and the usual footer and resolves with the usage summary; it does not throw.
  - `describeProvider()` returns `{ provider: selection.provider.toLowerCase(), model: $shortName + (selection.effort === 'max' ? ' MAX' : '') }` when a selection is active (`$shortName` from the catalog for OpenRouter, the id otherwise). Without a selection it keeps today's logic but walks `DEFAULT_PROVIDER_ORDER` (`flags.local` → the local model first; otherwise the first non-`LOCAL` provider with credentials; `LOCAL` only when nothing else is configured).
- **Persistence:** the IDE `ModelSelector` and TUI `/model` persist the selection as `config.models.selected` and push `selection.model` onto `config.models.recent` (dedup, newest first, max 8) through `saveConfig`. CLI `--model` applies to that run only.

### Cost accounting

- **Behavior:** `_recordUsage(provider, tier, usage, providerMetadata)` stores `cost` on the ledger entry when `providerMetadata.openrouter.usage.cost` is a finite number (OpenRouter usage accounting). `_complete` passes `response.providerMetadata` (awaited for `streamText`); `runAgentLoop` passes `step.providerMetadata` from `onStepFinish`. `summary()`/`getUsage()` sum stored costs and call `estimateCost` only for entries without one. `ui.footer`, `UsageFooter`, and the status bar need no change.

### Credentials (`lib/keys.js`)

- **Data:** `PROVIDER_KEYS = { OPENROUTER: 'OPENROUTER_KEY', ANTHROPIC: 'ANTHROPIC_KEY', OPENAI: 'OPENAI_KEY', GROQ: 'GROQ_KEY' }` (key order = `DEFAULT_PROVIDER_ORDER`); `KeyStatusRow = { provider, configured, masked: string|null, source: 'keys.json'|'env'|null, model: string|null }` where `masked` = first 6 characters + `…` + last 4 (`sk-or-…4f2a`; values shorter than 12 characters → `••••`) and `model` = the provider's resolved smart model id (`modelId(provider, 'smart', keysData)`), `null` when not configured.
- **Behavior:**
  - `listProviders(keysData)` → one row per entry of `PROVIDER_KEYS` plus `LOCAL` (`configured` when `LOCAL_BASE_URL` and `LOCAL_MODEL` are set; `masked = LOCAL_BASE_URL`). `source` is `env` when the value came from the environment and is not in `keys.json`.
  - `setKey(provider, value, keysData)`: trims strings; empty → `Error('empty key')`; `LOCAL` takes `{ baseURL, model, fastModel? }`; mutates `keysData` in place and writes **only the changed fields** into the stored file (read with `new EncryptedJsonDB('keys.json').load()`, merged, saved, mode `0600` best effort), so a value that came only from the environment is never copied to disk. `removeKey(provider, keysData)` deletes the field(s) (`LOCAL`: `LOCAL_BASE_URL`, `LOCAL_MODEL`, `LOCAL_FAST_MODEL`, `LOCAL_API_KEY`) from `keysData` and from the stored file. `loadKeys({ onWarn })` returns the stored file plus the environment (`OPENROUTER_KEY` else `OPENROUTER_API_KEY`, `ANTHROPIC_KEY`, `OPENAI_KEY`, `GROQ_KEY`, `REPLICATE_API_TOKEN`; the stored value wins, blank values are ignored) in memory only, and calls `onWarn` when the file cannot be read.
  - `testKey(provider, keysData) → { ok, detail }`: `OPENROUTER` via `verifyKey` (`detail` = `$label · $limitRemaining credits left` with two decimals and `?` when the key has a limit but reports no remaining amount, or `$label · unlimited` when `limit` is null; `$label` is `key` when the API gives none); every other provider runs `generateText` on its fast tier with prompt `Reply with the single word OK.`, `maxOutputTokens: 5`, 20 s timeout (`detail` = `$modelId answered` or the error message). Every error text is scrubbed of the key values held in `keysData` (replaced by `***`); `testKey` never throws and answers `{ ok: false, detail: 'not configured' }` for a provider without credentials.
  - Shared object: `index.js` loads `keysData` once and `createRuntime` keeps the same object by reference, so a `setKey` performed by the server is visible to every later `codePrompt` of every session without restarting.

## Modes

### Mode resolution

- **Behavior:** `$mode = opts.modeOverride || flags.mode`; a value that is not in `MODES` (`lib/modes.js`: `auto`, `agent`, `plan`, `ask`) counts as `auto`. `flags.mode` is read at every turn, so a `/mode` or `session.flags { mode }` applies to the next one. In `runPrompt`, after `additional_context` is built: `ask`, `plan`, `agent` force the agent route (`agentsReg.runAgent({ ..., mode: $mode })`); `auto` keeps today's logic (`needs_agent`, skills) and, when it reaches the loop, runs it as `agent`. A matched skill is followed in every mode, with that mode's tools. The pre-flight classification still runs in every mode (it is read-only and yields language/English text/personality), except that a `verbatim` turn (see `Implement flow`) gives the router an excerpt and does not use its English text. `--local` does not turn a forced mode back into `auto`: the user asked for the loop.
- `lib/modes.js` exports `MODES` and `cliMode({ agent, mode })` (`--agent` is `agent` only while `--mode` is still its default `auto`: `--mode ask --agent` is `ask`). It is a module of its own so that the CLI lists the choices without loading the agent stack.
- **Data:** `MODE_TOOLS` in `lib/agents.js`:
  - `READ_ONLY = ['list_files','read_file','grep','glob','search','code_map','find_symbol','show_symbol','who_calls','calls','read_rule','list_skills','use_skill','list_conversations','read_conversation','get_diagnostics','ask_user','delegate']`
  - `ask: READ_ONLY`; `plan: [...READ_ONLY, 'write_plan']`; `agent: null` (no restriction); `auto` never reaches `runAgent` with a mode other than `agent` (`runAgent` takes `mode` — default `agent` — and runs anything that is not `ask` or `plan` as `agent`).
  - A name in this list that does not exist yet (`grep`, `glob`, `list_conversations`, `read_conversation`, `get_diagnostics` before the phases that add them) is simply absent: the list only restricts, it never adds a tool.
- **Implementation:** `buildTools(runtime, allowed)` (with `runtime.mode`) intersects the agent's whitelist with `MODE_TOOLS[$mode]` when it is non-null; sub-agents inherit `$mode`, so a `reviewer` in Ask mode has no `run_bash`. In `ask`/`plan`, `delegate` only accepts `explorer` and `reviewer`: its description and `agent` argument name only those two, and a call for another agent answers `{ error: "sub-agent '$name' is not available in $mode mode, which is read-only. Available: …" }` (an unknown name: `unknown sub-agent '$name'. Available: …`; both lists are the delegable agents, sorted, and never include `main`).
- The system prompt of a loop is, in this order: the agent body, the project brief, `# Project memory`, the navigation policy, the skill section, the mode section, `# Voice / tone`. `runAgent` appends the mode prompt (`agents/modes/$mode.md`, read once and trimmed) under `# Mode: $mode` **for the orchestrator only** (depth 0). A sub-agent of `ask`/`plan` gets one line instead — `# Mode: $mode` then `This session is read-only: you cannot change files or run commands. Report what you find, and never claim to have changed anything.` — because its tools are already read-only and the orchestrator's instructions (`write_plan`, `ask_user`) are not its business; a sub-agent of `agent` gets no mode section. While the orchestrator waits for the model the status line reads `$mode · thinking …` (`ask · thinking …`; a sub-agent keeps `sub-agent · thinking …`).

### Ask

- Read-only question answering. Answers cite locations as `path:line`. Never claims to have changed anything; when the user asks for a change, it describes what it would change and suggests switching to Agent mode.

### Plan

- Investigates with read-only tools, asks at most two clarifying questions through `ask_user` when a decision is genuinely the user's, then calls `write_plan` once and finishes with a short summary pointing at the plan file. Prompt file `agents/modes/plan.md` must say: plans name concrete files and functions, list verification steps, and keep todos small and ordered.

### `write_plan` tool

- **Inputs:** `{ title: string, overview: string, markdown: string, todos: [{ id: string, content: string }] }`.
- **Behavior:** writes `.aicode/plans/$kebab(title).plan.md` (append `-2`, `-3`, … if the name exists) through the confirm-gated `writeFile` (so a diff or `fileWritten` shows and `--confirm` asks first; the directory is created), then calls `ui.planCreated({ path, title, overview, todos })` (see `UI event mapping`; the todos carry `status: 'pending'`). Returns `{ path }`, relative to the project. Title, overview and every todo's `id` and `content` have their white space collapsed to single spaces. Failures are answered as `{ error }` and write nothing: no title (`the plan needs a title`), a todo without `id` or `content`, two todos with the same id, a rendered file over 100 KB (`the plan is too long (… KB, the limit is 100 KB): make it shorter`), a write the user declined (`write cancelled or failed`; no card either). A UI whose `planCreated` throws does not lose the plan. The step reads `write plan "$title"` and ends with the path.
- **Data:** file format mirrors Cursor's plan files; frontmatter string values are always JSON-quoted:

```markdown
---
name: "$title"
overview: "$overview"
todos:
  - id: "$id"
    content: "$content"
    status: pending
isProject: false
---
$markdown
```

### `plan_todo` tool

- **Inputs:** `{ path: string, id: string, status: 'pending'|'in_progress'|'completed' }`.
- **Behavior:** rewrites the `status:` of the todo with `$id` inside the frontmatter of `$path` (regex-based, no YAML dependency) without touching the body or any other line (a todo with no `status:` line gets one, in its indentation and the file's line ending); returns `{ path, todos: [{ id, content, status }] }`. Agent mode only (not in the `ask`/`plan` toolsets); not confirm-gated (it only edits plan files under `.aicode/plans/`: the path must end in `.plan.md`, lie inside that directory — also after resolving links — and exist, else `{ error: 'plan_todo only edits plan files under .aicode/plans/ (not $path)' }` / `plan not found: $path`). An unknown id answers `todo '$id' not found in the plan. Todos: $ids`, a status outside the three `status must be one of: pending, in_progress, completed`, a file without frontmatter `not a plan file: it has no frontmatter`. The step reads `plan todo $id → $status` and ends with `$completed/$total completed`.

### Implement flow

- **Behavior:** given `$planPath`, the turn's input text is exactly:

```
Implement the plan at $relativePlanPath. Work through its todos in order: call plan_todo to mark a todo in_progress when you start it and completed once it is done and verified. The plan follows.

$planFileContent
```

  and the turn runs with `modeOverride: 'agent'` and `verbatim: true`. With additional instructions the text is the same up to the plan, followed by a blank line and `Additional instructions: $text` (trailing newlines of the plan dropped). Entry points: IDE `plan.implement` (project files only, see the protocol), TUI `/plan build [path]` (defaults to the most recently modified file in `.aicode/plans`; the transcript shows `Implement the plan at $path`, not the file), CLI `aicode --plan <path>` (implies `--mode agent`, refused with `--mode ask`/`--mode plan`, `--plan` alone is `give the path of a plan file`; the file is read before any key prompt, so a wrong path fails at once; the positional input, if any, is appended after the plan as `Additional instructions: ...`). The CLI and the TUI take any readable file, the IDE only files of the project; a plan over 100 KB is not implemented; a file that is not a `.plan.md` under `.aicode/plans/` can be implemented but `plan_todo` will not track it.
- **Why `verbatim`:** the router's "English version" of the input is what the agent loop works on, and a model asked to copy a whole plan back token by token is slow and may shorten or paraphrase it (a long plan can also overrun its output limit). With `opts.verbatim` the router prompt carries only an excerpt of the input — its first 2000 and last 1000 characters, `\n[... $n characters omitted ...]\n` between them when it is longer than 3000 — and step 1 reads `# 1. Classify it as an action or a question and detect its language. The text is used exactly as written, so set english to an empty string.`; whatever it answers, `english` is replaced by the input, so the agent's task is the plan exactly as written. Without `verbatim` the prompt and the English version work as before.

### `lib/plans.js`

- **Behavior:** the plan-file module behind `write_plan`, `plan_todo`, `catalog.get plans`, `/plan` and `--plan`. `PLANS_DIR = '.aicode/plans'`, `PLAN_SUFFIX = '.plan.md'`, `STATUSES`, `MAX_PLAN_BYTES = 100 KB`.
  - `kebab(title)` — lower case, accents dropped, runs of anything but `a-z0-9` become one `-`, at most 60 characters, `plan` when nothing is left. `uniquePlanPath(cwd, title)` → `{ abs, rel }` with `-2`, `-3`, … while the name is taken. `renderPlan({ title, overview, markdown, todos })` writes the format above (an unknown status is `pending`, no todos is `todos: []`, the body ends with one newline).
  - `parsePlan(text)` → `{ name, overview, todos: [{ id, content, status }], body }`, `null` without a closing `---`. It reads leniently, so a plan Cursor wrote works too: plain, double- and single-quoted values, `>` and `|` block scalars, comment lines, keys in any order, `-` followed by several spaces, CRLF and a BOM. `setTodoStatus(text, id, status)` → `{ text, todos }` changes one line only (see `plan_todo`).
  - `editablePlanFile(cwd, path)`, `listPlans(cwd, { query, limit })` (newest first, ties by path, at most 50, directories and files without the suffix skipped), `latestPlan(cwd)`, `readPlanFile(cwd, path, { insideProject })` → `{ abs, rel, text }` (errors: `give the path of a plan file`, `plan not found: $path`, `not a file: $path`, `the plan must be inside the project: $path`, `the plan is too large to implement (…)`), `implementText(rel, content, extra)`, `displayPath`.

## Project memory

### `readProjectMemory(cwd, { activeFile })`

- **Behavior:** implemented in `lib/memory.js` (`lib/agents.js` re-exports `readProjectMemory`); called at the start of every `runAgent` (fresh read each turn, sub-agents included) with `activeFile = ctx.editor && ctx.editor.activeFile`. Returns `{ text, rules, injected }` where `text` is the composed memory section (`''` when the project has none), `rules` is the parsed `Rule[]` (for glob matching during the turn; `.cursorrules` comes first when present) and `injected` lists the names of the rules whose text made it into `text`. `activeFile` may be absolute; it is made relative to `$cwd` and ignored when it is outside the project. Composition order and caps (characters):
  - `AGENTS.md` at `$cwd` verbatim (cap 12000) under `## AGENTS.md`.
  - `.cursorrules` at `$cwd`, as a rule named `.cursorrules` with `alwaysApply: true` (cap 6000) under `## Rule: .cursorrules`.
  - Rules with `alwaysApply: true` (cap 6000 each) under `## Rule: $name`.
  - Rules with `globs` matching `$activeFile` (same cap) under `## Rule: $name (applies to $activeFile)`. A rule with both `alwaysApply: true` and `globs` is loaded once, as an always-on rule.
  - A list `## Available rules` (cap 4000) with `- $name — $description` for the remaining rules (those with a description), telling the agent to call `read_rule`.
  - `.aicode/memory.md` (cap 6000) under `## .aicode/memory.md`.
  - Total cap 32000; truncated sections end with `… [truncated]` (a cut never splits a surrogate pair). The section that crosses the total cap is cut so the whole text is exactly 32000 characters; when fewer than 200 characters of room remain it is dropped whole, and every later section is dropped too. Files are read in part (at most `4 × cap` bytes), so a huge `AGENTS.md` costs no more than a small one.

### Cursor rules

- **Data:** files `$cwd/.cursor/rules/**/*.mdc`. Frontmatter between `---` lines with keys `description` (string), `globs` (string, comma-separated string, or YAML list), `alwaysApply` (boolean). Parsed into `Rule = { name, description, globs: string[], alwaysApply: boolean, body, file }` where `name` = file path relative to `.cursor/rules` without `.mdc` (nested rules use `/`), `body` = text after the frontmatter and `file` = the path relative to `$cwd`.
- **Behavior:**
  - The frontmatter is read line by line, not as strict YAML, because Cursor writes unquoted globs such as `globs: *.ts,*.tsx`. Keys are case-insensitive; `globs` accepts a comma-separated string (commas inside `{...}` do not split), an inline list `[a, b]` or a block list; a leading `./` or `/` is dropped from every glob; `description` is one line capped at 240 characters; only the exact value `true` (any case, quoted or not) is `alwaysApply`. A file without a closed header is all body. Files are read up to 64000 characters, at most 200 rule files are considered (sorted by path), empty rules are skipped, symlinked files are followed and symlinked directories are not.
  - Glob matching uses `minimatch` with `{ dot: true, matchBase: !pattern.includes('/') }` against `cwd`-relative paths.
  - During a turn, when `read_file`, `edit_file`, or `write_file` touches a path matching a glob rule not yet injected, the tool result gets a trailing `\n\n# Applicable rule: $name\n$body` (body capped at 6000) once per rule per turn. "Per turn" means per `additional_context` object: sub-agents of the turn share it, and a new prompt starts clean. Rules whose text is already in the system prompt (`injected`) and `alwaysApply` rules are never appended. Failed writes and edits stay plain errors.
  - `runPrompt` exposes the turn's editor context as `additional_context.editor` (`opts.editor || null`); only `activeFile` is used here — the `# Editor context` section of the brief belongs to the IDE phase.

### `read_rule` tool

- **Inputs:** `{ name: string }`. **Returns:** `{ name, description, globs, body }` or `{ error }` listing available names. The name is matched exactly, then case-insensitively, then without a `.mdc` suffix, then by unique basename (an ambiguous basename is an error); `body` is capped like any tool output (12000). The tool is part of the default read-only tool set and of the `tools` blocks of `agents/main.md` and `agents/explorer.md`; a runtime built without `rules` loads them on first use.

### orvix block in `AGENTS.md`

- **Behavior:** the block between `<!-- orvix:start -->` and `<!-- orvix:end -->` is injected as part of `AGENTS.md`. The navigation section (`agents/_navigation.md`, see `Navigation policy`) maps the shell commands it mentions to native tools and states that it takes precedence; the agent never runs `orvix index`.

## Code navigation

### `lib/orvix.js`

- **Implementation:** resolve the package root as `path.dirname(require.resolve('orvix-cli/package.json'))` (the package has no `exports` map, so this works). Paths: `$root/dist/main.js` (full CLI: `index`, `init`, `gain`), `$root/dist/query.js` (fast queries: `map`, `show`, `find`, `who-calls`, `calls`, options `-p`, `-b`, `--json`), `$root/hooks/orvix-compress.mjs`. Always spawn with `process.execPath`. `config.orvix.bin`, when set, replaces `main.js` and `query.js` with that executable (the compression hook stays the package's). `orvix-cli` is a regular dependency (`^0.2.0`); its postinstall script only prints a notice.
- **API:** `createOrvix(cwd, { sessionId, debug, config }) → { enabled, reason, root, sessionId, mapBudget, status(), onStatus(listener) → stop, ensureIndex({ ui }), ready(timeoutMs), markDirty(files?), indexNow(), flush(), settle(timeoutMs), map(budget, { path, wait }), find(query), show(idOrName), whoCalls(id), calls(id), compress(toolName, toolInput, text), gain(), init({ agents }), passthrough(args) }`. Every function that talks to orvix resolves a value and never throws: `{ error }` on failure, and `{ ambiguous: true, message, candidates: [{ id, file, startLine, signature }] }` for a reference that matches several symbols. Symbol results are `{ id, name, kind, container?, file, startLine, endLine, signature, exported }` (byte offsets stay inside orvix). Several runtimes of the same directory in one process share one state (index run, debounce, status listeners).
- **Behavior:**
  - `enabled` is decided once per instance (`reason` says why not). It is false when `AICODE_NO_ORVIX` is `1`, `true`, `yes` or `on`; when `config.orvix.enabled === false`; when `orvix-cli` cannot be located; and when `$cwd` is the home directory or a filesystem root. Otherwise it is true when `.orvix/symbols.json` already exists, or `$cwd` is inside a git repository (a `.git` directory or file at `$cwd` or any ancestor), or `$cwd` holds at least 5 indexable files (a bounded walk that skips dot directories, `node_modules`, `vendor`, `dist`, `build`, `target`, `venv`, `__pycache__`, `bower_components`). Indexable extensions are the ones orvix-cli 0.2.0 parses: `.ts .mts .cts .tsx .js .jsx .mjs .cjs .py .pyi .go .rs .java .cs .cpp .cc .cxx .hpp .hh .hxx .c .h`.
  - Queries run `query.js` with `--json -p $cwd` (timeout 10 s) and parse the JSON. A reference that starts with `-` is refused (the CLI would read it as an option). A reference that matches several symbols makes orvix exit 1 with `"$ref" matches $n symbols:` and one `$id  $file:$line $signature ←$callers` line per candidate on stderr; that is parsed into the `ambiguous` shape. `show` returns the text of the declaration, without a leading `export`. Calls made through a receiver (`obj.method()`) and CommonJS `require` imports are not attributed by `who-calls`/`calls`.
  - `map(budget, { path, wait })` returns the human-readable text form (no `--json`), which is what prompts embed. `path` keeps only one directory or file (the map is requested with 8 times the budget and filtered by whole path segments, then fitted to the budget; nothing under the path answers `no indexed symbols under $path`). The budget is capped at 20000 tokens. `wait: false` answers from the index as it is (the system brief wants speed, not the last edit).
  - `gain()` parses `main.js gain --json $cwd` → `{ sessions, total: { compressions, before, after, saved, ratio } }` and returns `total`.
  - `compress(toolName, toolInput, text)`: see `Result compression`. `init({ agents })`: see `Index lifecycle`. `passthrough(args)` runs any orvix command with the terminal attached (`aicode orvix …`) and resolves its exit code.
  - `status()` is `{ enabled, symbols, indexing, dirty }`; `onStatus(listener)` calls `listener(status)` when that object changes (not on repeated identical states) and returns the function that stops it.
- **orvix-cli 0.2.0 facts this design rests on (verified by reading the package and by running it):**
  - Queries never re-stat the tree. `openQuery` only catches up the files named in `.orvix/dirty` (an entry for a new file or a deleted file is handled); the `--no-refresh` option is declared and unused. Anything else needs an `index` run.
  - `main.js index` does not clear `.orvix/dirty`; `lib/orvix.js` removes the entries a finished run took into account (the byte count of the log when the run started).
  - The cache files are written non-atomically, which is why index runs are detached (own process group, unref'd): Ctrl-C and the exit of aicode do not interrupt one half-way.
  - `index --json` prints `{ files, symbols, edges, ambiguous, added, updated, removed, unchanged, skipped, skippedFiles }`; `gain --json` prints `{ sessions, total }`; an empty map prints `no symbols indexed`; an unknown reference prints to stderr and exits 1.
  - `.orvix/session.log` (which files the compression hook already showed) is one file per project keyed by `session_id`: two sessions on one project replace each other's log, so a file may be compressed again; re-reading it or `read_file { full: true }` is the way out.

### Index lifecycle

- **Behavior:**
  - `ensureIndex({ ui })` runs at the start of every turn (`runPrompt` calls it before the pipeline, so the build overlaps the router call) and on session creation. If `.orvix/symbols.json` does not exist and no run is in flight, it starts `main.js index --json $cwd` in the background (detached, timeout 120 s) and, with a `ui`, shows a step `indexing symbols (orvix)` that ends with `$n symbols` (or fails with `orvix: $reason`). It resolves `{ enabled, building, symbols, step }`; `step.detach(note)` ends the step early, which `runPrompt` does when the turn finishes before the build (`continues in the background`). `ready(timeoutMs)` waits for a first build that is running; before the agent loop starts, a turn waits up to 3 s so that a small project's first turn already has the code tools.
  - Until the first index exists every query answers `{ error: 'orvix index is still building; use text search meanwhile' }` (the wording becomes `use grep meanwhile` when Phase 8 adds `grep`). A failed run is not retried for 30 s; queries then answer `orvix index is not available ($reason); use text search`.
  - Exclusion: if `.orvix/` is not already ignored (`git check-ignore -q .orvix/`; the trailing slash makes git treat a directory that does not exist yet as one) and the directory is in a git repository, append `.orvix/` to the file returned by `git rev-parse --git-path info/exclude` (a missing final newline is respected; once per project and process). Never edit `.gitignore`. Outside a repository nothing is written.
  - Freshness. A write the agent made to a known file (`write_file`, `edit_file`) is appended to `.orvix/dirty` (`markDirty([path])`; paths outside the project and files orvix does not index are ignored), and the next query applies it. A change nobody can name (`run_bash` unless the command is known to be read-only, a worktree merge, or the start of every orchestrator turn: the user, git or another tool may have changed anything) is `markDirty()`: it schedules a debounced (1500 ms), detached `index` run and flags the project; any query or compression that comes first starts that run at once and waits for it (at most 10 s, 3 s for compression). `flush()` starts a pending run immediately (aicode is about to exit; the run survives it), `settle()` waits for nothing to be pending or running. A change that arrives while a run works (the project was flagged after the run began) gets another pass. With no index yet, `markDirty` just schedules the first build.
  - A shell command counts as read-only when every segment (split on `&&`, `||`, `;`, `|`, `&`, newlines) starts with a well-known read-only command (`ls`, `cat`, `grep`, `rg`, `find` without `-delete`/`-exec`/`-ok`/`-fprint*`, `git status|log|diff|show|…`) and the command has no redirection other than to `/dev/null` and no command substitution.
  - `symbols` count = `Object.keys(symbols.json.symbols).length` (memoized per file stamp); `status().dirty` is true while the project is flagged or the dirty log is not empty.
  - `aicode orvix init [--agents cursor,claude,codex,gemini]` / `/orvix init` / `orvix.command init` run `main.js init $cwd -a $agents` (this is the only path that writes `AGENTS.md` and `.gitignore`, and it is the user's explicit choice). `orvix init` indexes the project itself, so nothing is left pending; the status listeners are told about the new symbol count. An agent name other than `claude`, `codex`, `cursor` or `gemini` is refused before orvix runs.
  - The runtime's project snapshot (`codePrompt`'s ignore list) excludes `**/.git/**` and `**/.orvix/**`: without it, every prompt and every `list_files`/`search` read the repository's objects and the whole symbol table as if they were sources.

### orvix tools

Available in every mode (they are read-only) while the layer is enabled for the project; without it none of them is registered. Object results are passed through a 12000-character cap; a result that is too big becomes truncated JSON text like any other tool output.

- `code_map { budget: number|null (default config.orvix.mapBudget), path: string|null }` → the text map.
- `find_symbol { query: string }` → `[{ id, name, kind, container?, file, startLine, endLine, signature, exported }]`.
- `show_symbol { id: string }` → `{ id, name, kind, container?, file, startLine, endLine, signature, exported, source }` (`id` accepts a short id prefix or a name; a reference that matches several symbols returns `{ ambiguous, message, candidates }`). A `source` that would not fit is cut so that the whole JSON result stays within the cap (quotes, backslashes and newlines count double) and ends with `… [truncated $n chars]`.
- `who_calls { id: string }` and `calls { id: string }` → the same symbol list shape; `who_calls` with no callers answers `{ symbols: [], note: "Calls through a receiver (obj.method()) are not attributed; confirm with a text search before changing a signature." }` (`grep` replaces "a text search" in Phase 8).
- A symbol list longer than 50 is returned as `{ total, shown: 50, note: 'refine the query …', symbols }`.
- Every parameter is required in the schema and optional ones are `nullable` (the strict structured-output schemas of some providers need every key).

### Result compression

- **Behavior:** `compress(toolName, toolInput, text)` spawns `hooks/orvix-compress.mjs` with stdin JSON `{ "session_id": $sessionId, "cwd": $cwd, "hook_event_name": "PostToolUse", "tool_name": $toolName, "tool_input": $toolInput, "tool_response": $text }` (3 s timeout). If stdout is empty or unparsable, return `$text` unchanged. Otherwise return `hookSpecificOutput.updatedToolOutput` (a string, because `tool_response` was a string), followed by `\n\n` + `hookSpecificOutput.additionalContext` when present (the hook adds it once per session). The hook only trusts an index that is current: a pending refresh is waited for (3 s; otherwise the text is returned unchanged) and the dirty log is applied first (a `map -b 1` query forces the catch-up). Texts over 2 MiB, results with no index yet, and a layer that is disabled are never sent to the hook.
- **What the hook does (orvix-cli 0.2.0):** a whole-file `Read` of an indexed source file of at least 200 lines becomes `$path — $n lines, $m symbols (body elided by orvix)` plus one `$id  [*]$signature  :$start-$end` line per symbol; the same file read again in the session, ranged reads, unindexed files and anything where the rewrite is not under half the size stay as they were. Search hits (`Grep`, or `Bash` whose command matches `/\b(grep|egrep|fgrep|rg|ag|ack)\b/`) of at least 5 lines become the symbols that contain them when at least half of the hits land inside known symbols (`$n symbols contain the matches ($h hits, resolved by orvix)`); a search for a literal, a config key or a TODO is left alone.
- **Wiring:** `read_file` without `offset`/`limit` and without `full: true` → `compress('Read', { file_path: $absolutePath }, text)`. `run_bash` whose command matches that same expression → `compress('Bash', { command }, text)`. In Phase 8 the `grep` tool's content results → `compress('Grep', { pattern }, text)`.
- `read_file` schema becomes `{ path: string, offset: number|null, limit: number|null, full: boolean|null }`. `offset`/`limit` (1-based) return that range: a header `$path · lines $a-$b of $total`, each line as `%6d|$text` (a line is cut at 2000 characters), and a footer `… $n more lines (continue with offset $next)` when the file goes on; with only `offset` the window is 500 lines, and every window ends where the 12000-character output cap does (the footer says where to continue). An `offset` past the end is `{ error: 'offset $n is past the end of $path ($total lines)' }`; an empty file answers `$path: (empty file)`. `full: true` returns the whole file uncompressed (still capped at 12000 characters like any output).

### System brief with code map

- **Behavior:** in `projectBrief`, when orvix is enabled and the index answers (an index that is still being built, or an empty one, keeps today's tree), replace the full source tree with: `# Code map (orvix)` + `map(config.orvix.mapBudget, { wait: false })` + `# Directories` (top-level files as `- ./ ($n files at the top level)` and the top-level and second-level directories as `- $dir/ ($n files)` from the traverse snapshot, at most 60 lines) + the sentence `Use list_files for the complete file tree, find_symbol/show_symbol for code, search for literals.` (`grep for literals` in Phase 8). Otherwise keep today's tree. At the start of every orchestrator turn (depth 0) `runAgent` marks the project dirty and starts a refresh, so the first query of the turn waits for an index that includes whatever changed since the last one.

### Navigation policy

- **Data:** new file `agents/_navigation.md` with two variants under `<!-- variant: orvix -->` and `<!-- variant: basic -->` markers (files whose basename starts with `_` are skipped by `loadAgents`). `runAgent` appends the `orvix` variant to every agent's system prompt (all depths, all modes) when orvix is enabled, the shorter `basic` variant otherwise, right after the project memory so that it takes precedence over any `orvix` shell instruction in `AGENTS.md`. The tool lists of the four agents (`agents/main.md`, `explorer.md`, `coder.md`, `reviewer.md`) include the five navigation tools.
- **Behavior (content requirements):** symbols → `find_symbol`/`show_symbol`/`code_map`; literals, config keys, comments, TODOs, markdown/JSON/YAML/CSS → `search` (`grep` after Phase 8); before changing a signature run `who_calls` and confirm with a text search for receiver calls; reuse ids already seen; mapping table `orvix map`→`code_map`, `orvix show`→`show_symbol`, `orvix find`→`find_symbol`, `orvix who-calls`→`who_calls`, `orvix calls`→`calls`; never run `orvix index`; `read_file` returns a symbol map for large files — follow up with `show_symbol` or `read_file` with `offset`/`limit`, or read again / pass `full: true` for the raw text; when a tool says the index is still building, use `search` and `read_file`. The `basic` variant says the index is not active and that `orvix` instructions in `AGENTS.md` do not apply.

### `lib/ripgrep.js`

- **Behavior:** `findRg()` returns the first existing of: `rg` on `PATH`; `$ideDir/code-server-*/lib/vscode/node_modules/@vscode/ripgrep/bin/rg`; `require('@vscode/ripgrep').rgPath` (optional dependency); else `null`. `run(args, { cwd, signal, timeoutMs = 20000 })` resolves `{ code, stdout, stderr }`.

### `grep` tool

- **Inputs:** `{ pattern: string, path?: string, glob?: string, type?: string, output_mode?: 'content'|'files_with_matches'|'count' (default 'content'), context?: number, case_insensitive?: boolean, multiline?: boolean, head_limit?: number (default 200, max 2000), offset?: number }`.
- **Behavior:**
  - Base args: `--hidden -g '!.git' -g '!node_modules' --max-filesize 2M --no-messages -S`; `-i` when `case_insensitive`; `--multiline --multiline-dotall` when `multiline`; `--type $type`; `-g $glob` unless `$glob` is `*`, `**`, or `**/*` (ignored as meaningless); `-C $context`.
  - `content`: add `--json -n --max-columns 400 --max-columns-preview`; parse lines of types `begin`, `match`, `context`, `end`; render `path:line: text` for matches and `path-line- text` for context, grouped by file; apply `offset`/`head_limit` over match entries; when more remain append `… at least $remaining more matches (use offset=$next)`.
  - `files_with_matches`: add `-l`; return one path per line.
  - `count`: add `--count-matches`; return `path:count` lines.
  - Exit code 1 → `no matches`; code 2 → `{ error: stderr }`. Without `rg`, fall back to the existing in-memory `search` over the traverse snapshot for `content`/`files_with_matches`.
- The legacy `search` tool stays registered as the fallback and is listed last in prompts.

### `glob` tool

- **Inputs:** `{ pattern: string, path?: string }`. **Behavior:** `rg --files --hidden -g '!.git' -g '!node_modules' -g $pattern` sorted by mtime desc, capped at 500 with `… and $n more`; falls back to the `glob` package.

## Skills

### Discovery directories and precedence

- **Data:** `skillDirs(cwd)` returns, in order: `$cwd/.cursor/skills` (`cursor-project`), `$cwd/.agents/skills` (`project`), `$cwd/.claude/skills` (`project`), `~/.cursor/skills` (`cursor-user`), `~/.agents/skills` (`global`), `~/.config/agents/skills` (`global`), `~/.claude/skills` (`global`), `~/.cursor/skills-cursor` (`cursor-builtin`). Entries with origins starting with `cursor-` are skipped when `AICODE_NO_CURSOR_IMPORT=1`, except `$cwd/.cursor/skills` (it belongs to the repo).
- **Behavior:** first match by lowercase name wins. `MAX_SKILLS` becomes `200`. `discoverSkills(cwd)` caches per `cwd` for 30 s. `list_skills`, `use_skill`, `/skills`, and the IDE picker show `$origin`.

### Two-stage routing

- **Behavior:** when `skills_list.length > 12`, before the pre-flight classification: build the compact catalog (`- $name: $first100CharsOfDescription`), run a fast-tier `queryLLM` with schema `{ candidates: string[] }` (max 5 exact names, empty when none clearly matches) and the prompt `Pick up to 5 installed skills that could fulfill this request better than a generic coding assistant; return exact names only, or an empty list.`; stage 2 (the existing classification) receives only the candidates, with full 300-char descriptions. With 12 or fewer skills the single-stage path is unchanged.

### Deny-list

- **Data:** `DEFAULT_IGNORED_SKILLS = ['canvas','automate','loop','new-repo','origin','share','statusline','update-cursor-settings','review-bugbot','review-security']` (Cursor-internal skills that cannot work outside Cursor). Effective ignore = defaults ∪ `config.skills.ignore` − `config.skills.allow`, compared by lowercase name. Ignored skills are omitted from discovery results.

## Conversations

### `lib/conversations.js`

- **API:** `listConversations(cwd, { source?: 'cursor'|'cursor-db'|'aicode'|'all', query?, limit = 50 }) → Conversation[]`, `readConversation(id, { offset = 0, limit = 10, maxChars = 12000 }) → { id, title, source, turns: [{ role, text }], total }`, `summarizeConversation(engine, id) → string`, `projectSlug(path)`.
- **Data:** `Conversation = { id, source, title, createdAt, updatedAt, turns, path? }`. Ids: `cursor:$transcriptId`, `cursor-db:$composerId`, `aicode:$sessionId`. Results sorted by `updatedAt` desc; `query` is a case-insensitive substring filter on `title` and the first user text.
- **Behavior:** Cursor sources are skipped when `AICODE_NO_CURSOR_IMPORT=1` or `config.conversations.cursorImport === false`.

### Project slug

- **Behavior:** `projectSlug(absPath) = absPath.replace(/[^A-Za-z0-9]/g, '-').replace(/^-+/, '')` (verified: `/Users/pabloschaffner/Documents/code/aicode` → `Users-pabloschaffner-Documents-code-aicode`; `/var/folders/jh/6b23zyrn3nl_8y7x5hyxtpdr0000gn/T/...` → `var-folders-jh-6b23zyrn3nl-8y7x5hyxtpdr0000gn-T-...`). When `~/.cursor/projects/$slug` does not exist, fall back to the directory whose name equals `$slug` after lowercasing both. The same function names aicode's own `~/.aicode/projects/$slug`.

### Source: Cursor transcripts (JSONL)

- **Data:** `~/.cursor/projects/$slug/agent-transcripts/$id/$id.jsonl` (ignore the sibling `subagents/` directories). Lines are `{ "role": "user"|"assistant", "message": { "content": [{ "type": "text", "text": "..." }] } }` or `{ "type": "turn_ended" }`; other shapes are skipped. User text may be wrapped in `<timestamp>…</timestamp>` and `<user_query>…</user_query>` and may contain `<system_reminder>…</system_reminder>`, `<attached_files>…</attached_files>`, `<open_and_recently_viewed_files>…</open_and_recently_viewed_files>`, `<system_notification>…</system_notification>`, `<manually_attached_skills>…</manually_attached_skills>` blocks.
- **Behavior:** `title` = first 80 chars of the first normalized user text; `createdAt` = file birthtime (fall back to mtime); `updatedAt` = mtime; `turns` = count of user lines. Normalization: if `<user_query>` exists use its inner text, otherwise strip all the wrapper blocks listed above; collapse runs of blank lines. Parse lazily: listing reads only the first 64 KB of each file for the title.

### Source: Cursor SQLite (phase 2)

- **Data:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS; Linux `~/.config/Cursor/User/globalStorage/state.vscdb`), table `cursorDiskKV(key, value)`. `composerData:$composerId` → JSON with `composerId`, `name`, `subtitle`, `unifiedMode` (`agent`|`plan`|`ask`|…), `createdAt` (ms epoch), `workspaceIdentifier.uri.fsPath` (project folder), `fullConversationHeadersOnly: [{ bubbleId, type, createdAt }]`, `isDraft`, `isBestOfNSubcomposer`, `subagentComposerIds`. `bubbleId:$composerId:$bubbleId` → JSON with `type` (`1` user, `2` assistant) and `text`.
- **Behavior:** only when `config.conversations.sqlite` is true and the `sqlite3` binary exists (`node:sqlite` may be used instead on Node ≥ 22.5; otherwise this source is silently skipped). Listing query, run once and cached in `~/.aicode/cache/cursor-composers.json` for 10 minutes (and refreshable via `/chats refresh`): `select key, json_extract(value,'$.name'), json_extract(value,'$.subtitle'), json_extract(value,'$.createdAt'), json_extract(value,'$.unifiedMode'), json_extract(value,'$.workspaceIdentifier.uri.fsPath'), json_array_length(json_extract(value,'$.fullConversationHeadersOnly')) from cursorDiskKV where key like 'composerData:%'`, filtered to rows whose `fsPath` equals `$cwd`, excluding `isDraft` and `isBestOfNSubcomposer`. Reading one conversation fetches `composerData:$id` and then each bubble by exact key, in header order, skipping empty `text`. Always invoke `sqlite3 -readonly -json`. The file can be tens of gigabytes: never copy it, never `select value` without a key or key-prefix condition, and cap any single read to the first 60 bubbles unless `offset`/`limit` ask otherwise.

### Source: aicode sessions

- **Behavior:** files under `~/.aicode/projects/$slug/sessions/`, parsed with the transcript parser; `title` from the `session` header line.

### Summaries

- **Behavior:** `summarizeConversation(engine, id)` returns the cached `~/.aicode/cache/conversations/$id.md` if present; otherwise reads up to the last 40 turns (max 24000 chars), asks the fast tier for a markdown summary with the headings `## Request`, `## Decisions`, `## Files touched`, `## Open items` (max 300 words), caches it, and returns it. Cache key includes `updatedAt` so a conversation that grew gets re-summarized.

### Conversation tools

- `list_conversations { query?: string, limit?: number }` → `[{ id, source, title, updatedAt, turns }]`.
- `read_conversation { id: string, offset?: number, limit?: number, summary?: boolean }` → with `summary: true` the summary text; otherwise `{ title, turns: [{ role, text }], total }` capped at 12000 chars.
- Both are in `READ_ONLY` and in `explorer`'s whitelist.

## Multi-agent

### Parallel delegation

- **Behavior:** several `delegate` calls in one step already run concurrently (AI SDK executes a step's tool calls with `Promise.all`). `agents/main.md` instructs: "When sub-tasks are independent, issue all `delegate` calls in the same step so they run in parallel." Each delegate step is rendered with its `toolCallId`; the IDE shows concurrent steps as parallel lanes; TUI/CLI keep sequential step lines.

### Isolated worktrees

- **Inputs:** `delegate { agent: string, task: string, isolated?: boolean }`.
- **Behavior:** when `isolated` is true and `$cwd` is inside a git repository: `$id` = 8 lowercase hex chars; `$branch = aicode/$agent-$id`; `$dir = ~/.aicode/worktrees/$slug/$id`; run `git worktree add -b $branch $dir HEAD` in `$cwd`. The sub-agent receives a `ctx` built by `makeFileHelpers($dir, ui, confirmAction)` with `userDirectory = $dir`, and its own `createOrvix($dir)` (indexed lazily). The tool result is `{ agent, report, worktree: { id, branch, dir } }`. When not in a git repo, `isolated` is ignored with a note in the result. Worktree creation failures return `{ error }`.

### Worktree tools (agent mode, orchestrator only)

- `list_worktrees {}` → from `git worktree list --porcelain`, entries whose branch starts with `refs/heads/aicode/`: `[{ id, branch, dir, head }]`.
- `merge_worktree { id: string, squash?: boolean }` — confirm-gated (`merge worktree #$branch#`). `squash` → `git merge --squash $branch` (changes left staged, reported as such); otherwise `git merge --no-ff $branch -m "Merge aicode worktree $id"`. On conflict run `git merge --abort` and return `{ error, conflicts: [paths] }`. Marks orvix dirty.
- `remove_worktree { id: string, deleteBranch?: boolean }` — confirm-gated; `git worktree remove --force $dir` then optionally `git branch -D $branch`.

### Sub-agent reminder

- **Behavior:** when `depth > 0`, `runAgent` appends this exact paragraph to the system prompt: `You are running as a sub-agent under a parent agent. Do not delegate further and do not ask the user questions; make reasonable decisions, state them, and finish with a concise report for the parent agent.`

### IDE-aware tools

- `get_diagnostics { path?: string }` → `IdeBridge.call('getDiagnostics', { path })`; offered only when the session has an `IdeBridge`; in `READ_ONLY` and in `coder`/`reviewer`/`main` whitelists.
- `EditorContext` injection as described in `Editor context`.

## IDE extension

Lives in `ide/extension/` with `package.json`, `src/extension.ts`, `src/diff.ts`, `src/bridge.ts`, `src/webview/` (React), `media/aicode.svg`, `build.mjs`, `tsconfig.json`; output in `dist/`.

### Package manifest

- **Data:** `name: "aicode-ide"`, `displayName: "aicode"`, `publisher: "aicode"`, `version` = aicode's version, `engines.vscode: "^1.96.0"`, `main: "./dist/extension.js"`, `activationEvents: ["onStartupFinished"]`.
- **Contributes:** `viewsContainers.activitybar: [{ id: "aicode", title: "aicode", icon: "media/aicode.svg" }]`; `views.aicode: [{ type: "webview", id: "aicode.agent", name: "Agent" }]`; commands `aicode.newSession` ("aicode: New Session"), `aicode.cancel`, `aicode.setMode`, `aicode.selectModel` ("aicode: Select Model"), `aicode.openSettings` ("aicode: Settings (API keys)"), `aicode.installSkill`, `aicode.openPlans`, `aicode.reconnect`; keybindings `{ command: "aicode.agent.focus", key: "ctrl+shift+a", mac: "cmd+shift+a" }` and `{ command: "aicode.selectModel", key: "ctrl+/", mac: "cmd+/", when: "focusedView == aicode.agent" }`; configuration `aicode.agentUrl` and `aicode.agentToken` (strings, fallbacks when the env vars are absent).

### Extension host (`src/extension.ts`, `src/bridge.ts`)

- **Behavior:**
  - On activation: read `AICODE_AGENT_URL`/`AICODE_AGENT_TOKEN` (or settings), connect with `ws` (bundled), send `hello { client: 'ide' }`, create or resume one session per workspace folder (`session.list` → resume the most recent if it is younger than 24 h, else `session.create { cwd }`), then `executeCommand('aicode.agent.focus')`.
  - Reconnects with exponential backoff (1 s → 30 s) and shows a status bar warning while disconnected.
  - Bridges messages verbatim between the webview and the server, except: `ui.diff` (handled by `Diff review` and forwarded), `prompt.request` with `diffId` (handled by `Diff review` and forwarded), `ide.call` (answered locally, never forwarded). Webview-only messages handled by the host: `openDiff { diffId }` (re-opens the diff tab) and `openExternal { url }` (`vscode.env.openExternal`, only `https:` URLs).
  - Commands `aicode.selectModel` and `aicode.openSettings` post `{ type: 'ui.open', panel: 'models' | 'settings' }` to the webview, which opens `ModelSelector` or `SettingsPanel`.
  - `session.input` sent from the webview is enriched with `editor: EditorContext` built from `vscode.window.activeTextEditor` and `vscode.window.tabGroups`.
  - `ui.fileWritten` → reveal the file in the explorer and open it preserving focus.
  - `ide.call` handlers: `getDiagnostics` from `vscode.languages.getDiagnostics()`; `openFile` via `window.showTextDocument`; `getActiveContext`.

### Diff review (`src/diff.ts`)

- **Behavior:**
  - A `TextDocumentContentProvider` for scheme `aicode-proposed` serves texts registered by `$diffId`: `aicode-proposed:/$diffId/new/$file` → `$newText`, `aicode-proposed:/$diffId/old/$file` → `$oldText`.
  - On `ui.diff`: register both texts and run `vscode.diff(oldUri, newUri, "aicode: $file")` where `oldUri` is the real file URI when it exists on disk and `$oldText` equals its current content, otherwise the `old` proposed URI.
  - On `prompt.request { kind: 'confirm', diffId }`: besides the panel card, call `window.showInformationMessage("aicode wants to write $file", { modal: false }, "Accept", "Reject")`; the first answer (panel or message) sends `prompt.response { id, value }`; then close the diff tab for `$diffId` and dispose its texts.
  - Prompts without `diffId` are shown only in the panel.

### Agent panel (webview)

- **Layout:** `SessionTabs` on top; `Timeline` filling the middle; `Composer` at the bottom; `UsageFooter` under it. `SettingsPanel` and `ModelSelector` are overlays. Styling only through `--vscode-*` CSS variables and `@vscode/codicons`; no external UI library.
- **State:** per session: `turns[]` (each with `input`, `steps[]`, `streamText`, `answer`, `diffs[]`, `prompts[]`, `usage`), `flags` (including `model`), `busy`, `orvix`. Global: `providers: KeyStatusRow[]` (from `keys.list`, requested on connect and after every `keys.status`), `models: ModelInfo[]` + `catalog` (from `models.list`, requested when `ModelSelector` first opens and after a key is saved). Restored from `session.resumed.turns` on load.

### `SessionTabs`

- **Behavior:** one tab per open session (`+` creates via `session.create { cwd }`); tab label = session title or `New session`; a spinning icon while busy; middle-click/`×` closes the tab (the server keeps the session for resume). A gear icon (`codicon-gear`) at the right end opens `SettingsPanel`; it shows a warning dot while `providers` has no configured entry.

### `Timeline` and `TurnBlock`

- **Behavior:** renders turns in order. Each `TurnBlock` shows the user input (with ref chips), then `StepRow`s, then the streaming/final answer rendered as markdown (code blocks with copy buttons), then `DiffCard`s and `PromptCard`s inline where they occurred, then a compact usage line. Auto-scrolls while busy unless the user scrolled up.
- `StepRow`: label, live elapsed time while running, `✓`/`✗` on end, `extra` dimmed. Steps whose labels start with `delegate →` and overlap in time are rendered side by side inside a `ParallelLanes` row (one column per concurrent step).

### `DiffCard`

- **Behavior:** file name, `+n/−n` counts, collapsed unified diff (computed in the webview from `oldText`/`newText` with a small LCS line diff), buttons `Open in editor` (sends `ide.call`-free local command through the bridge: `openDiff { diffId }`) and, when a pending confirm references it, `Accept` / `Reject`.

### `PromptCard`

- **Behavior:** `confirm` → message + `Yes`/`No` (Enter = Yes, Esc = No when focused); `select` → radio list + `OK`; `ask` → text input + `Send`. Disabled after resolution, showing the chosen value.

### `PlanCard`

- **Behavior:** shown for `plan.created` and for `catalog.get { kind: 'plans' }` results: title, overview, todo checklist (status icons), buttons `Open` and `Implement` (→ `plan.implement { path }`, which switches the composer's mode chip to Agent for that turn).

### `Composer`

- **Behavior:**
  - Multiline input; Enter sends, Shift+Enter newlines; `↑`/`↓` on an empty input recall previous inputs; `Esc` cancels a running turn (`session.cancel`).
  - Bottom-left row of the input, in this order (Cursor's layout): `ModeSelector` chip cycling `Auto · Agent · Plan · Ask` (sends `session.flags { mode }`), then the `ModelSelector` chip; bottom-right: toggles `Confirm`, `Local`.
  - Typing `@` opens `MentionPicker` with two groups from `catalog.get`: `Conversations` (title, relative date, source badge `Cursor`/`aicode`) and `Skills` (name, origin). Selected items become chips and are sent as `refs`.
  - Slash commands handled locally: `/mode <m>`, `/local`, `/confirm`, `/model [spec|max|clear]` (no argument opens `ModelSelector`; `max` toggles the current model's effort between `max` and `null`; `clear` sends `model: null`; anything else is sent as `session.flags { model }` after resolving it through `models.list { query }` — first entry wins), `/keys` (opens `SettingsPanel`), `/skills [install <src>]`, `/chats [query]`, `/plan [list|build <path>]`, `/orvix [status|index|init|gain]`, `/clear` (clears the view and asks the server to start a fresh session), `/help`.
  - Shows `indexing symbols…` under the input while `orvix.indexing`. Disabled, with the placeholder `Add an API key to start (see Settings)`, while `providers` has no configured entry.

### `ModelSelector`

The model picker, visible next to `ModeSelector` like Cursor's.

- **Chip:** text = `$shortName` of `flags.model` (ellipsis after 28 characters) followed by a `MAX` badge when `flags.model.effort === 'max'`; `Auto` when `flags.model` is `null`, with the tooltip `provider default: $provider/$model` from `session.created`. Clicking the chip, `/model`, `aicode.selectModel`, or `Ctrl+/` / `Cmd+/` opens the popover.
- **Popover:** anchored above the chip, closes on `Esc`, outside click, or selection. Contents, top to bottom:
  - A search input (autofocus). Typing filters the loaded `models` client-side with the same token rule as `Model catalog › query`; when `catalog.stale` or `models` is empty, `models.list { refresh: true }` runs once on open and a `loading models…` row shows meanwhile.
  - Group `Recent` (entries with `recent` in `groups`), group `Featured` (entries with `featured`), group `All models` collapsed behind a `Show all ($n)` row until a query is typed or it is clicked.
  - Each row: `shortName`; a provider badge (`OpenRouter`, `Anthropic`, `OpenAI`, `Groq`, `Local`); context (`$contextLength` formatted `1M`, `200K`); price `$$prompt / $$completion per 1M` when `pricing` is present; a `MAX` toggle on the right when `reasoning.supportedEfforts` includes `max` or `reasoning.supportsMaxTokens` is true. Rows with `available: false` show an `add key` link instead of being selectable (opens `SettingsPanel` focused on that provider); rows with `supportsTools: false` are dimmed, not selectable, and titled `no tool calling — cannot run the agent loop`.
  - Selecting a row sends `session.flags { sessionId, flags: { model: { provider, model: id, effort } } }` where `effort` is `'max'` when the row's `MAX` toggle is on, else `null`; the chip updates from the echoed `session.flags`. Toggling `MAX` on the row of the currently selected model re-sends the selection with the new effort without closing the popover.
  - Keyboard: `↑`/`↓` move the highlight, `Enter` selects, `m` toggles `MAX` on the highlighted row, `Esc` closes.
- **Empty states:** no OpenRouter key → `Featured` shows the row `Add an OpenRouter key to see 400+ models` (opens `SettingsPanel`) above the non-OpenRouter entries; key present but no cache → `loading models…`; `models.result.error` → a dimmed row `catalog refresh failed: $error (showing cached list)`.

### `SettingsPanel`

- **Behavior:** an overlay inside the webview (opened from the gear in `SessionTabs`, `/keys`, `aicode.openSettings`, or an `add key` link). One row per `KeyStatusRow` in `DEFAULT_PROVIDER_ORDER` (`OpenRouter`, `Anthropic`, `OpenAI`, `Groq`, `Local`): a status dot (configured / missing), the `masked` value with its `source` (`env` shown as `from environment`), a password-type input, and buttons `Save` (`keys.set`), `Test` (`keys.test` → inline `ok · $detail` or `failed · $detail`), `Remove` (`keys.remove`, after an inline `Remove this key?` confirmation). The `OpenRouter` row shows the link `Get a key at openrouter.ai/settings/keys` → `openExternal { url: 'https://openrouter.ai/settings/keys' }`. The `Local` row has inputs `Base URL` and `Model`. A `Default model` row shows `describeProvider()`'s chip text and a `Change…` button that opens `ModelSelector`. Footer line: `Keys are stored encrypted in ~/.aicode/keys.json · Settings in ~/.aicode/config.json`.
- After a successful `keys.set` for `OPENROUTER` the panel requests `models.list { refresh: true }` so `ModelSelector` is populated immediately.

### `OnboardingCard`

- **Behavior:** rendered at the top of `Timeline` while `providers` has no configured entry: `Add an API key to start. One OpenRouter key gives you Claude, GPT, Gemini, Kimi, GLM and more; or use your own OpenAI, Anthropic, Groq, or local model.` with buttons `Add OpenRouter key` (opens `SettingsPanel` focused on the OpenRouter input) and `Other providers` (opens `SettingsPanel`). Disappears on the first `keys.status` with a configured provider, after which `ModelSelector` opens automatically once.

### `UsageFooter`

- **Behavior:** one dimmed line under the `Composer`: `$provider/$model · $in in / $out out · ~$$cost · $elapsed` for the last turn plus a session total `(session: $totalIn/$totalOut · ~$$totalCost)`, fed by `ui.footer` and `session.done.usage`. Hidden until the first turn completes.

### Status bar

- **Behavior:** `vscode.StatusBarItem` (right, priority 100) with text `$(hubot) aicode · $provider/$model · $in/$out tok · ~$$cost · orvix $symbols` (omit segments that are unknown; `$(hubot)` is the codicon). Click → `aicode.agent.focus`. Turns yellow with `disconnected` while reconnecting.

### Build (`ide/extension/build.mjs`)

- **Behavior:** esbuild API, two bundles: `src/extension.ts` → `dist/extension.js` (`platform: 'node'`, `format: 'cjs'`, `external: ['vscode']`, `bundle: true`, bundles `ws`), and `src/webview/index.tsx` → `dist/webview.js` (`platform: 'browser'`, `format: 'iife'`, `bundle: true`, React 19 from the root `node_modules`) plus `dist/webview.css` and the codicon font copied from `@vscode/codicons/dist/`. `--watch` flag for development. `tsc --noEmit` is run first and fails the build on type errors.

## Launcher

### `aicode ide [folder] [--port <n>] [--no-open] [--ide-version <v>]`

- **Behavior:**
  1. Resolve `$cwd` (`folder` or the current directory). Load `keysData` without the interactive key prompts: the IDE is usable with no credentials (`OnboardingCard` + `SettingsPanel` take over). When no provider is configured print `no API keys configured yet — add one in the aicode panel (Settings)`.
  2. `ensureCodeServer()` (see `code-server acquisition`).
  3. `installExtension()`: copy `ide/extension/{package.json,dist,media}` to `~/.aicode/ide/extensions/aicode.aicode-ide-$version/` when missing or when the bundled `package.json` version differs.
  4. `startAgentServer({ port: 0, token })` with a runtime factory bound to the key data; print `agent server ws://127.0.0.1:$agentPort`.
  5. Spawn code-server and wait until `GET http://127.0.0.1:$port/healthz` answers 200 (poll every 250 ms, give up after 60 s).
  6. Unless `--no-open`/`config.ide.open === false`, open `http://127.0.0.1:$port/?folder=$cwd` with `open` (macOS), `xdg-open` (Linux), or `cmd /c start "" $url` (Windows). Print the URL in any case.
  7. On SIGINT/SIGTERM: close the agent server, send SIGTERM to code-server, SIGKILL after 5 s, exit 0.
- **Inputs to code-server:** `bin/code-server --bind-addr 127.0.0.1:$port --auth none --app-name aicode --extensions-dir $ideDir/extensions --user-data-dir $ideDir/data --disable-telemetry --disable-update-check --disable-workspace-trust --disable-getting-started-override --trusted-origins http://127.0.0.1:$port,http://localhost:$port $cwd`, with env `AICODE_AGENT_URL`, `AICODE_AGENT_TOKEN`, and `stdio` piped to `$ideDir/logs/code-server.log`. `$port` = `--port`, else `config.ide.port`, else a free port.

### code-server acquisition

- **Data:** version `$v` = `--ide-version` | `AICODE_IDE_VERSION` | `config.ide.version` (default `4.141.0`). Platform id from `process.platform`/`process.arch`: `darwin/arm64 → macos-arm64`, `darwin/x64 → macos-amd64`, `linux/x64 → linux-amd64`, `linux/arm64 → linux-arm64`, `win32/x64 → windows-amd64`; anything else → error `unsupported platform for aicode ide`. URL `https://github.com/coder/code-server/releases/download/v$v/code-server-$v-$platform.tar.gz`. Extracted directory `$ideDir/code-server-$v-$platform/`; binary `bin/code-server` (`bin/code-server.cmd` on Windows, best effort).
- **Behavior:** if the binary exists, done. Otherwise download to `$ideDir/downloads/` with a UI step showing MB progress (follow redirects; verify `Content-Length` when provided), extract with the system `tar -xzf $file -C $ideDir`, verify the binary exists, delete the tarball. Download failures print the URL and the manual steps (`mkdir -p $ideDir && tar -xzf <file> -C $ideDir`).

### Default settings

- **Behavior:** create `$ideDir/data/User/settings.json` only when missing, with: `"workbench.startupEditor": "none"`, `"workbench.colorTheme": "Default Dark Modern"`, `"security.workspace.trust.enabled": false`, `"telemetry.telemetryLevel": "off"`, `"update.mode": "none"`, `"extensions.autoUpdate": false`, `"workbench.tips.enabled": false`.

### `aicode serve [--port <n>] [--token <t>]`

- **Behavior:** starts only the Agent Server (default port `config.server.port`), prints `ws://127.0.0.1:$port` and the token, and stays in the foreground until Ctrl-C. Used for development and alternative frontends.

## CLI and TUI surfaces

### New CLI options and commands

- `--mode <auto|agent|plan|ask>` (default `auto`); `-a/--agent` kept as alias to `--mode agent` (it never overrides another mode: `--mode ask --agent` is `ask`). An invalid value is refused by the option parser and lists the four. The `--help` texts are the locale keys below, so they follow the language of the machine.
- `--plan <path>` → `Implement flow`.
- `--ref-chat <id|n>` (repeatable) → `conversation` refs; `n` is the 1-based index in `aicode chats` output.
- `aicode chats [query] [--source cursor|aicode|all]` → prints `n  source  date  turns  title  id`.
- `aicode orvix [status|index|init|gain|map|find|show|who-calls|calls] [args…]` (no action = `status`; `init` takes `--agents cursor,claude,codex,gemini`). `status` is aicode's own report (`orvix is active in $cwd` with `symbols`, `indexing` and `changes`, or `orvix is off for this project: $reason`); every other action is orvix itself, run in the current directory with the terminal attached, so its options pass through (`aicode orvix show add --json`) and its exit code is aicode's (an ambiguous reference exits 1). An unknown action or agent prints an error and exits 1. These commands never run the interactive key prompts.
- `aicode serve`, `aicode ide` as above.
- `--model <spec>` → `parseModelSpec` → `flags.model` for this run only (errors print the `unknown model` message and exit 1). Example: `aicode --model "sonnet 5.5 max" --mode ask "where is provider fallback implemented?"`.
- `aicode models [query] [--refresh]` → when an OpenRouter key exists (or `--refresh`), fetch the catalog (`fetchCatalog`), then print one row per `listModels({ query })` entry: `n  provider  id  context  $prompt/$completion per 1M  tools  efforts  groups` (`efforts` = `reasoning.supportedEfforts` joined with `,` or `-`; `groups` = `recent`/`featured` markers). `n` is accepted by `/model <n>`-style selections only inside the TUI; the CLI always takes a spec.
- `aicode keys [list|set <provider> [value]|remove <provider>|test <provider>]` → `list` prints `KeyStatusRow`s (`provider  configured  masked  source  model`); `set` without a value asks for it with `ui.ask` (OpenRouter: `Paste your OpenRouter API key (openrouter.ai/settings/keys):`) and then runs `testKey`, printing its `detail`; `test` prints `ok · $detail` / `failed · $detail`; `remove` asks for confirmation.
- Locale keys to add (identical English key and value in `en.json`, Spanish value in `es.json`): `Interaction mode: auto, agent, plan or ask`, `Implement a plan file in agent mode`, `Attach an existing conversation (id or index from "aicode chats") as context`, `List Cursor and aicode conversations for this project`, `Run orvix (semantic code index) commands for this project`, `Start the Agent Server only (for the IDE extension or other frontends)`, `Open this project in the embedded VS Code (code-server) with the aicode agent`, `Do not open the browser automatically`, `code-server version to download and run`, `Model for this run: [provider:]model[@effort], e.g. openrouter:anthropic/claude-sonnet-5.5@max or "sonnet 5.5 max"`, `List available models (OpenRouter catalog plus configured providers)`, `Refresh the OpenRouter model catalog`, `Manage provider API keys: list, set, remove, test`.

### TUI commands

- `/mode [auto|agent|plan|ask]` (no argument lists the four with the current one marked; an unknown word is refused and lists them; a change confirms with `✓ mode: $mode — $what it does` and applies to the next turn); the status bar shows `(agent)`, `(plan)`, `(ask)` like `(local)` today (`(local, ask)` for both; nothing for `auto`); `/agent` remains as a toggle between `agent` and `auto`.
- `/model` replaces today's provider-only picker: without arguments it opens a `select` prompt listing the `recent` and `featured` entries of `listModels` (choice title `$shortName · $provider · $context · $$prompt/$$completion`, plus a first choice `search…` that asks for a query and shows the matching entries) and a final choice `MAX: on/off` for the current model; `/model <spec>` resolves through `parseModelSpec`; `/model max` toggles the current effort between `max` and `null`; `/model clear` returns to `Auto`. Every change goes through `applyModelSelection` for the next turns and is persisted (`Applying a selection › Persistence`); the status bar chip shows `describeProvider()`.
- `/keys [provider]` → `select` the provider (or use the argument), `ask` for the value, `setKey`, then `testKey` and print `ok · $detail` / `failed · $detail`.
- `/plan list` (also plain `/plan`: one row per plan with its todos done, newest first), `/plan build [path]` (the latest plan without a path; the input is the plan text, the transcript line is `Implement the plan at $path`, and the turn runs in agent mode whatever the session's mode is).
- `/chats [query]`, `/chats use <n>` (attaches to the next turn), `/chats refresh`.
- `/orvix [status|index|init|gain]`.
- `/help` lists them; `/clear` also clears pending refs.

## Agent definitions

### `agents/main.md`

- **Behavior (content requirements):** keep the current principles; add the parallel-delegation instruction, the `isolated` option (use it for risky or competing approaches; call `merge_worktree`/`remove_worktree` afterwards), `get_diagnostics` after edits when available, `plan_todo` when implementing a plan, `remember` sparingly. ```` ```tools ```` block lists every tool in this spec.

### `agents/explorer.md`, `agents/coder.md`, `agents/reviewer.md`

- **Behavior:** `explorer` gains `grep, glob, code_map, find_symbol, show_symbol, who_calls, calls, read_rule, list_conversations, read_conversation` and a `Thoroughness` convention: the task may start with `Thoroughness: quick|medium|very thorough` (quick = one or two lookups; very thorough = multiple naming conventions and locations). `coder` gains the navigation tools plus `get_diagnostics`; `reviewer` gains the navigation tools plus `get_diagnostics`.

### `agents/modes/ask.md`, `agents/modes/plan.md`, `agents/modes/agent.md`

- **Behavior:** plain markdown bodies (no fenced metadata) appended under `# Mode: $mode`. `agent.md` is the short reminder to verify work and finish with a user-facing summary.

### `agents/_navigation.md`

- See `Navigation policy`.

## Verification

### Automated tests (`test/`)

- `test/run.mjs` runs every `test/*.test.mjs` sequentially and exits non-zero on the first failure; `npm test` calls it. Tests use `MockLanguageModelV3` from `ai/test` like `test/agent-loop.test.mjs` (which must keep passing unchanged).
- `test/server.test.mjs`: start the server on port 0, connect with `ws`, assert `4401` without token; `hello` → `hello.ok`; `session.create` → `session.created`; a turn with a stubbed runtime emits `ui.step.*`, `ui.stream.*`, `session.done`; a `confirm` round-trip resolves through `prompt.response`; `session.cancel` aborts and resolves pending prompts with `false`; persisted JSONL has the documented shape. With a temp `HOME` holding a fixture `cache/openrouter-models.json`: `models.list` returns `ModelInfo`s with `groups`; `session.flags { model }` echoes and writes `config.models.selected`/`recent`; a provider without credentials → `session.error { code: 'no_credentials' }`; `keys.set` → `keys.status` with `masked` and never the raw value; `keys.test` for `OPENROUTER` against a local `http` stub reached through `AICODE_OPENROUTER_API` (200 → `ok`, 401 → `invalid key`).
- `test/models.test.mjs`: `normalizeModel` on fixtures copied from the live API (a `reasoning.supported_efforts` entry, a `supports_max_tokens` entry, a `:batch` entry that is dropped, a `~…-latest` alias flagged `isAlias`); `callOptions('OPENROUTER')` cases: effort `none` with a list lacking `none` → `{}`; `max` on `['high','medium','low']` → `{ effort: 'high' }`; `supportedEfforts: null` → the effort as given; `supportsMaxTokens` → `{ max_tokens }`; `structured: true` → `{}`; `maxOutputTokens` clamp; `parseModelSpec` for `openrouter:anthropic/claude-sonnet-5.5@max`, `anthropic/claude-sonnet-5.5`, `claude-opus-4-8` → `ANTHROPIC`, `sonnet 5.5 max` via the fixture catalog, and an unknown spec throwing; `estimateCost` from catalog pricing; `applyModelSelection` on a stub engine sets strict preferences and the `$P_MODEL`/`$P_EFFORT` config; `DEFAULT_PROVIDER_ORDER` deep-equals `['OPENROUTER','ANTHROPIC','OPENAI','GROQ','LOCAL']` and a fresh `Code2Prompt` starts with it; `setModelPreferences(['OPENAI','ANTHROPIC','GROQ'])` on an engine whose only credential is `OPENROUTER_KEY` yields `['OPENAI','ANTHROPIC','GROQ','OPENROUTER']`, and with `{ strict: true }` yields the list unchanged; `listProviders` masking and row order; `setKey`/`removeKey` round-trip on a temp `HOME`. Beyond that list the file also covers: the Anthropic adaptive/budget thinking forms and their clamps; the catalog download, cache, TTL and failure fallbacks and `verifyKey` against a local `http` stub; `listModels` ordering, groups and `query`; the Cursor-style phrases; a chat completion and a stream through `createModel('OPENROUTER')` against the stub, asserting the request (`reasoning.effort`, `usage.include`, headers) and that the real cost reaches the ledger; `loadKeys` (environment names, damaged file) and `testKey`.
- `test/runtime.test.mjs` (model selection): the chip order and `MAX`; the remembered selection seeding `flags.model` (only while its provider has credentials, never over a caller's pick, damaged values ignored); `applyModelSelection` routing (strict, `fallbackOnError`, `LOCAL` keeps its fast model, no credentials refused); a whole turn on the pick (every model creation carries the provider, model and effort; `opts.model` and `--local` precedence; an unusable pick ends the turn with an error); and the template `setModelPreferences` helper (`applyTemplatePreferences`).
- `test/modes.test.mjs` (offline: a scripted mock model, plus a local `http` stub playing OpenRouter for the command-line part): the modes and `cliMode`; the plan file format (round trips of awkward strings, Cursor-style files with block scalars, comments, shuffled keys, CRLF and BOM) and `setTodoStatus` changing exactly one line; plans on disk (listing, queries, ordering, links out of the project, size); the toolset of every mode and agent (`ask` has no `write_file`/`edit_file`/`run_bash`/`remember`/`write_plan`/`plan_todo`; `plan` has `write_plan` and no writes; the code-index tools are read-only and present in every mode when the index is active); `write_plan` and `plan_todo` and their errors; `delegate` in `ask`/`plan` (rejects `coder`, sub-agents lose `run_bash`, a sub-agent gets the one-line mode reminder); the mode prompt files and where the mode section sits in the system prompt; the routing of a turn per mode (`ask`/`plan`/`agent` force the loop, `auto` keeps the router, `opts.modeOverride`, `--local`, a skill); `opts.verbatim` (the agent gets the input exactly, the router an excerpt, 3000 vs 3001 characters); whole turns (a plan turn writes the file and shows the card, a model that calls `write_file` in `ask` mode changes nothing, an implement turn moves the todos); the terminal surfaces; and `aicode` as a child process (`--mode`, `--plan` and their refusals, the locale keys, then `--plan <file>`, `--mode ask|plan|agent` and `--agent` against the stub: the request the model receives carries the right tools, mode section and the plan exactly as written).
- `test/server.test.mjs` (plans over the wire, section N): `plan.created` (fields, masking, an empty one), `plan.implement` (the turn it runs, its refusals for a missing, blank, outside, linked-out, huge or foreign-session path, `busy`, `no_provider`) and `catalog.get` for `plans` and `rules` (fields, queries, ordering, every refusal).
- `test/memory.test.mjs`: temp dir with `AGENTS.md`, `.cursorrules`, `.cursor/rules/a.mdc` (`alwaysApply: true`), `b.mdc` (`globs: "*.ts"`), `c.mdc` (description only): composition order, glob injection for `activeFile: 'x.ts'`, available-rules list, `read_rule`, caps.
- `test/orvix.test.mjs` (the real `orvix-cli` against small temp projects; skipped with a notice when it cannot run; `test/run.mjs` sets `AICODE_NO_ORVIX=1` for every other file so no test builds an index, and this file clears it): the enablement rules (git repository, worktree `.git` file, 4 vs 5 source files, every skipped directory, an existing index, both switches, home and root); the shell-command classification; the index lifecycle (step, status events, a second runtime joining the build, `.orvix/` excluded once through `info/exclude` and `.gitignore` untouched, an index built by hand adopted and excluded; executables standing in through `config.orvix.bin` that refuse every call (back-off, compression not trusting a stale index), answer oddly (never a crash), or are slow (a change whose debounce fires during a run still gets its own pass); `orvix init` and its agent check); the query shapes (`find`, `show` by id, prefix, name and `Box.open`, ambiguity, `who-calls` across files, `map` with budget and path, `gain`); freshness (dirty log, absolute and out-of-project paths, deleted files, `markDirty()` waiting for a run, trimming, debounce and `flush`, a change during a run); compression (small file untouched, a 300-line file as its symbol map, second read raw, per-session hint, unindexed and non-code files, search hits and literals, the size cap, a write the index has not caught up with); the agent tools (`read_file` ranges and `full`, the symbol cap, truncated sources including escape-heavy ones, `write_file`/`edit_file`/`run_bash` marking the index dirty); the brief, the policy variants and their order in the system prompt; how each navigation call shows in the UI; and the `aicode orvix` command through a child process. A mutation pass over `lib/orvix.js` and the code-index parts of `lib/agents.js` (114 mutants) had one survivor, the memoization of the git exclusion, which only saves spawning git.
- `test/runtime.test.mjs` (code index): the first turn builds the index as a step and already has the map, the policy and the tools; the next turn shows no step; a turn that never reaches the agent still starts it and closes its step; a build outliving the turn is detached, also when the turn fails; an index that cannot start never breaks the turn; `AICODE_NO_ORVIX` leaves the file tree, the basic policy and no tools; the snapshot excludes `.git` and `.orvix`. `test/server.test.mjs` (code index over the wire, with a fake index): status in `session.created`/`session.resumed`, `orvix.status` pushes, each `orvix.command`, its validation, ownership, and the stream ending with the session.
- `test/ripgrep.test.mjs`: fixture `rg --json` lines → rendered content; pagination (`offset`/`head_limit`), `files_with_matches`, `count`; broad globs ignored. Live `rg` part skipped when not found.
- `test/skills.test.mjs`: precedence across `.cursor/skills` (project) vs `~/.cursor/skills` (user) using a fake `HOME`; deny-list and `allow`; compact catalog; stage-1 routing invoked only above 12 skills (mock model).
- `test/conversations.test.mjs`: `projectSlug` for the two verified examples; JSONL fixtures with wrappers → normalized turns and title; aicode session files; summary caching.
- `test/worktrees.test.mjs`: sets `GIT_AUTHOR_NAME=aicode-test`, `GIT_AUTHOR_EMAIL=test@aicode.local`, `GIT_COMMITTER_NAME=aicode-test`, `GIT_COMMITTER_EMAIL=test@aicode.local` in `process.env` before spawning any git (so commits and merges work on a CI runner with no global identity); temp git repo with one commit; isolated delegate helper creates `aicode/explorer-$id` and the dir; `list_worktrees`; `merge_worktree` fast path and conflict abort; `remove_worktree`.

### Manual smoke (in this repository, which already has an orvix index)

- `aicode "what does this project do?"` unchanged.
- `aicode --mode ask "where is provider fallback implemented?"` → cites `lib/engine.js:$line`, no writes.
- `aicode --mode plan "add a /health endpoint"` → `.aicode/plans/add-a-health-endpoint.plan.md`; `aicode --plan .aicode/plans/add-a-health-endpoint.plan.md` implements it.
- `aicode chats` lists this Cursor conversation; `aicode --ref-chat 1 --mode ask "summarize what we decided about orvix"`.
- `aicode ide` → browser opens, Agent panel focused, status bar shows `orvix 3xx`; ask for a multi-file change with Confirm on → native diff opens, Accept writes; `get_diagnostics` reports problems after an intentional syntax error; `@` picker lists conversations and skills; `/mode plan` → `PlanCard` → `Implement`.
- `aicode keys set openrouter` (paste a key) → `ok · $label · …`; `aicode models sonnet` lists `anthropic/claude-sonnet-5.5` with `efforts max,xhigh,high,medium,low`; `aicode --model "sonnet 5.5 max" --mode ask "where is provider fallback implemented?"` → footer shows `openrouter/Claude Sonnet 5.5 MAX` and a cost taken from usage accounting.
- In the IDE: open `ModelSelector` (`Cmd+/`), pick `Kimi K3` from `Featured`, toggle `MAX`, run a turn → chip shows `Kimi K3 MAX`, `UsageFooter` shows `openrouter/Kimi K3 MAX`; remove the OpenRouter key in `SettingsPanel` → the next `session.input` yields `no_credentials`/`no_provider` and `OnboardingCard` appears when no other key exists.

## Version control

The whole implementation lives on one feature branch and reaches `main` through one pull request, so every phase is reviewable and revertible. Facts verified on 2026-10-17: remote `origin` = `https://github.com/puntorigen/aicode.git` (public, default branch `main`); local `main` = `origin/main` = `bae97af`; no `.github/workflows`, no git hooks; `gh` 2.52.0 is installed and authenticated as `puntorigen`.

### Branch

- **Data:** name `feature/aicode-ide`; base `main`.
- **Behavior:** create it with `git switch main && git pull --ff-only origin main && git switch -c feature/aicode-ide`. If the branch already exists locally or on `origin`, switch to it (`git switch feature/aicode-ide && git pull --ff-only`) and continue from its last commit instead of recreating it.
- The working tree currently carries two uncommitted changes made by the user when enabling orvix (`.gitignore` gained the line `.orvix/`; `AGENTS.md` is a new 22-line file holding the `<!-- orvix:start --> … <!-- orvix:end -->` block). They move with the checkout and become the first commit of the branch (see `Commits`), never a commit on `main`.
- `.orvix/` (ignored), `~/.aicode/*`, logs, and anything under `ide/extension/node_modules/` (must not exist — no nested installs) are never committed. `ide/extension/dist/` is committed (see `## Constraints › Packaging`). `package-lock.json` is committed in the same commit as the `package.json` change that caused it; dependencies are added with `npm install <pkg>@<range>` (never `npm update`).

### Spec in the repository

- **Behavior:** the second commit of the branch adds `docs/aicode-ide.spec.md`, a verbatim copy of this file. From that commit on, the repository copy is the version-controlled source of truth: when an entry of `## Open questions` is resolved during implementation, update the repository copy in the same commit as the code that resolves it (replace the question with the verified fact), and keep this file in sync.

### Continuous integration

- **Data:** new file `.github/workflows/test.yml`, committed in Phase 0 (the repository has no CI today), with exactly this content:

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: test (node ${{ matrix.node }})
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - name: Install ripgrep (exercises the live grep path)
        run: sudo apt-get update -qq && sudo apt-get install -y -qq ripgrep
      - run: npm ci
      - name: Build the IDE extension (type-checks TypeScript)
        run: npm run build:ide --if-present
      - run: npm test
```

- **Behavior:** `actions/checkout@v7` and `actions/setup-node@v7` are the current majors (verified 2026-10-17); Node `20` matches `engines.node >= 20` and `22` covers the optional `node:sqlite` path. `--if-present` lets the workflow pass before Phase 9 adds `build:ide`. The suite must stay runnable on a clean runner: no network beyond `npm ci` and the ripgrep package, no API keys, no global git identity (see `test/worktrees.test.mjs` in `## Verification`), temp `HOME`s for anything that touches `~/.aicode`.
- The workflow becomes a required signal for the pull request: the executor runs `gh pr checks feature/aicode-ide --watch` after every push and fixes failures before moving to the next phase.

### Commits

- **Behavior:** at least one commit per delivery phase, made only when `npm test` is green and `node --check` passes on every changed `.js`/`.cjs` file; `git status` is inspected before each commit so no unintended file is added (`git add -A` is allowed only after that check). Work-in-progress commits inside a long phase (9, 11) are fine; squashing them before push is optional.
- **Data:** message format is Conventional Commits, `type(scope): imperative summary` with the first line at most 72 characters (the only exception is the per-phase subjects listed below: they are byte-exact and 10 of them are longer, up to 86 characters), a blank line, then a short bullet body of what changed and how it was verified. Extra commits (a `fix(...)` for a defect found on the way, work-in-progress commits) follow the 72-character limit. Subjects per phase (byte-exact first lines):
  - Phase 0a: `chore: enable orvix index for this repository`
  - Phase 0b: `docs: add the aicode IDE SpecLang spec`
  - Phase 0c: `ci: run the test suite on pull requests and pushes to main`
  - Phase 1: `refactor(runtime): extract runPrompt into lib/runtime.js with per-session flags`
  - Phase 2: `feat(server): add the loopback Agent Server, JSON protocol and aicode serve`
  - Phase 2b: `feat(models): add OpenRouter, model selection with MAX effort, and key management`
  - Phase 3: `feat(memory): inject AGENTS.md, Cursor rules and .cursorrules as project memory`
  - Phase 4: `feat(orvix): make orvix the default code-navigation layer`
  - Phase 5: `feat(modes): add auto/agent/plan/ask modes and the plan → implement flow`
  - Phase 6: `feat(skills): discover .cursor skills with precedence and two-stage routing`
  - Phase 7: `feat(conversations): reference Cursor and aicode conversations as context`
  - Phase 8: `feat(ripgrep): add Cursor-style grep and glob tools as the literal-search fallback`
  - Phase 9: `feat(ide): add the VS Code extension with agent panel, native diff review and settings`
  - Phase 10: `feat(ide): add aicode ide launcher with code-server download and install`
  - Phase 11: `feat(agents): isolated worktree delegation, parallel lanes and IDE diagnostics`
  - Phase 12: `docs: document the IDE, modes, orvix, project memory, models and conversations`
- Never: commit to `main`, push to `main`, force-push the branch once the pull request exists, amend or rebase pushed commits, or commit a key, token, or `.env` file. If `main` moves while the branch is open, integrate with `git merge origin/main` (a merge commit, no rebase) and resolve conflicts in favor of this spec.
- `package.json` `version` stays `2.0.0` in this pull request; releasing is a separate step for the user.

### Pull request

- **Behavior:** after the Phase 1 commit, push with `git push -u origin feature/aicode-ide` and open a draft pull request:
  `gh pr create --base main --head feature/aicode-ide --draft --title "feat: aicode IDE — embedded VS Code, agent server, modes, orvix navigation, OpenRouter models" --body-file /tmp/aicode-ide-pr.md`
  (the title is byte-exact; the body file is written by the executor from the template below). If `gh` is unavailable or not authenticated, print the compare URL `https://github.com/puntorigen/aicode/compare/main...feature/aicode-ide?expand=1` and continue.
- After every later phase: push (`git push`), then update the body's phase checklist with `gh pr edit --body-file /tmp/aicode-ide-pr.md` (check the phase's box, add anything new under `## Behavior changes`).
- After Phase 12, when every box is checked, `npm test` is green locally, and `gh pr checks feature/aicode-ide` reports the `CI` workflow green on the pushed head: `gh pr ready`. Merging, choosing squash vs. merge commit, and closing are the user's decisions; the executor never merges.
- **Data:** body template (markdown; `[ ]` boxes are checked as phases land):

```markdown
## Summary
`aicode ide` launches a local VS Code web (code-server) with a preinstalled aicode extension talking to a loopback Agent Server that runs the existing pipeline and agent loop. Adds Auto/Agent/Plan/Ask modes, orvix code navigation by default, project memory from AGENTS.md + Cursor rules, `.cursor` skills, Cursor conversations as context, worktree-isolated sub-agents, and OpenRouter with a Cursor-style model picker.

Spec (source of truth): `docs/aicode-ide.spec.md` on this branch.

## Phases
- [ ] 0 Branch, orvix activation, spec
- [ ] 1 Runtime extraction
- [ ] 2 Agent Server and protocol
- [ ] 2b Models, OpenRouter and credentials
- [ ] 3 Project memory
- [ ] 4 orvix layer
- [ ] 5 Modes
- [ ] 6 Skills from .cursor
- [ ] 7 Conversations
- [ ] 8 ripgrep fallback
- [ ] 9 IDE extension
- [ ] 10 Launcher
- [ ] 11 Multi-agent
- [ ] 12 Docs and locales

## How to test
- CI (`.github/workflows/test.yml`) runs `npm ci`, `npm run build:ide --if-present` and `npm test` on Node 20 and 22.
- Locally: `npm install && npm test`
- `aicode "what does this project do?"` (unchanged path)
- `aicode keys set openrouter` then `aicode --model "sonnet 5.5 max" --mode ask "where is provider fallback implemented?"`
- `aicode ide` in this repository (first run downloads code-server ~200 MB)

## Behavior changes
- Default provider order is now OpenRouter → Anthropic → OpenAI → Groq → local; users holding both OpenAI and Anthropic keys route to Anthropic unless they select a model.
- `writeFile` shows the diff before asking for confirmation.
- `--agent` is now an alias of `--mode agent`.

## Open questions
(copied from the spec; removed as they are resolved)
```

## Delivery phases

### Phase 0 — Branch and spec

- Realizes `## Version control › Branch`, `Spec in the repository`, and `Continuous integration`: create `feature/aicode-ide`, commit the carried orvix activation (`.gitignore`, `AGENTS.md`) as Phase 0a, commit `docs/aicode-ide.spec.md` as Phase 0b, commit `.github/workflows/test.yml` as Phase 0c. No code changes.

### Phase 1 — Runtime extraction

- Realizes `lib/runtime.js`, `UsageLedger`, `lib/config.js`, `lib/history.js`, `.gitignore` negation, `test/run.mjs`. Acceptance: `npm test` passes; CLI and TUI behave as before. Ends with the first push and the draft pull request (`## Version control › Pull request`).

### Phase 2 — Agent Server and protocol

- Realizes `## Agent Server`, `## Protocol`, `aicode serve`, `test/server.test.mjs`.

### Phase 2b — Models, OpenRouter and credentials

- Realizes `## Models and providers` (`OPENROUTER` provider, `lib/openrouter.js`, `listModels`, `parseModelSpec`, `applyModelSelection`, cost accounting, `lib/keys.js`), the `models.*`/`keys.*` protocol messages and `session.flags { model }` validation, `--model`, `aicode models`, `aicode keys`, `/model`, `/keys`, the first-run OpenRouter prompt, `test/models.test.mjs`, and the server test additions. Acceptance: `aicode --model "sonnet 5.5 max" "..."` runs through OpenRouter with the cost in the footer; `npm test` passes.

### Phase 3 — Project memory

- Realizes `## Project memory`, `read_rule`, `test/memory.test.mjs`.

### Phase 4 — orvix layer

- Realizes `lib/orvix.js`, index lifecycle, orvix tools, compression, code-map brief, `agents/_navigation.md`, `aicode orvix`, `/orvix`, the `orvix.status`/`orvix.command` messages, `test/orvix.test.mjs`. Acceptance: in this repository `aicode orvix status` reports the symbols, an agent turn lists the code map and offers the five navigation tools, a large file read comes back as its symbol map and a second read as its text; `npm test` passes.

### Phase 5 — Modes

- Realizes `## Modes`, `lib/modes.js`, `lib/plans.js`, mode prompt files, `--mode`, `--plan`, `/mode`, `/plan`, `plan.implement`, `catalog.get` for `plans` and `rules`, `opts.verbatim`, `test/modes.test.mjs` and the server test additions. Acceptance: `aicode --mode plan "…"` ends with a file under `.aicode/plans/`; `aicode --plan <file>` runs the plan in agent mode and the model receives it exactly as written; in `--mode ask` the model is offered no tool that writes; `npm test` passes.

### Phase 6 — Skills from `.cursor`

- Realizes `## Skills`, `test/skills.test.mjs`.

### Phase 7 — Conversations

- Realizes `## Conversations` (JSONL and aicode sources first, SQLite second), tools, `aicode chats`, `--ref-chat`, `/chats`, `test/conversations.test.mjs`.

### Phase 8 — ripgrep fallback

- Realizes `lib/ripgrep.js`, `grep`, `glob`, explorer thoroughness, `test/ripgrep.test.mjs`.

### Phase 9 — IDE extension

- Realizes `## IDE extension` and the build, including `ModelSelector`, `SettingsPanel`, and `OnboardingCard`; verify by running `aicode serve` plus a manual `code-server` or VS Code Extension Development Host pointing at it.

### Phase 10 — Launcher

- Realizes `## Launcher` (non-interactive key handling included); manual smoke of `aicode ide`, including a first run with no keys at all.

### Phase 11 — Multi-agent

- Realizes `## Multi-agent`, `test/worktrees.test.mjs`, `ParallelLanes`.

### Phase 12 — Docs and locales

- Ends with `gh pr ready` once every phase box is checked (`## Version control › Pull request`).
- README: add the CI badge `[![CI](https://github.com/puntorigen/aicode/actions/workflows/test.yml/badge.svg)](https://github.com/puntorigen/aicode/actions/workflows/test.yml)` on the line right after the H1 title.
- README sections: `aicode IDE`, `Modes`, `Code navigation (orvix)`, `Project memory`, `Agent Skills` (updated directories and two-stage routing), `Conversations as context` (sources, privacy, opt-out), `Models and OpenRouter` (one key for the whole catalog, the picker and `MAX`, `--model` grammar, `aicode models`/`aicode keys`, `keys.json`/`config.json` fields, cost accounting, the default order `OpenRouter → Anthropic → OpenAI → Groq → local` and the note for users holding several keys); the feature bullet and every provider list in the README follow `DEFAULT_PROVIDER_ORDER` (`OpenRouter, Anthropic, OpenAI, Groq, plus any local OpenAI-compatible server`); options table rows; the Configuration section lists `OPENROUTER_KEY` first; `locales/en.json` and `locales/es.json` entries from `## CLI and TUI surfaces`.

## Open questions

- Windows: the code-server Windows tarball layout (`bin/code-server.cmd`) was not verified on this machine; treat Windows as best effort and surface a clear error if the binary is not found after extraction.
- Whether unpacked extension folders are picked up by this code-server build without an `extensions.json` entry was not verified at runtime; if the extension does not appear, fall back to packaging a VSIX (zip with `extension/` + `extension.vsixmanifest` + `[Content_Types].xml`, buildable with the existing `jszip` dependency) and passing `--install-extension $vsix` to code-server once.
- Whether `@openrouter/ai-sdk-provider@2.10.0` populates `providerMetadata.openrouter.usage.cost` per step in `streamText`'s `onStepFinish` (documented for `generateText` results) was not verified at runtime; `Cost accounting` therefore treats the field as optional and falls back to catalog pricing.
- The `GET /api/v1/key` response fields (`label`, `limit`, `limit_remaining`, `usage`, `is_free_tier`) were taken from OpenRouter's documentation, not exercised with a live key; `verifyKey` must tolerate missing fields (`null`).
