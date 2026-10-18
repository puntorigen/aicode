// Multi-step agent loops and multi-agent turns.
// ---------------------------------------------------------------------------
// Agents are markdown files in agents/ (same prompt-as-plugin pattern as
// actions/personalities): a ```description``` block, an optional ```tools```
// whitelist, and a markdown body used as the system prompt.
//
// The loop itself lives in the engine (Code2Prompt.runAgentLoop, native AI SDK
// tool calling). This module builds the tool registry from the existing
// confirm-gated sandbox helpers (so diff previews / --confirm keep working),
// composes the system prompt (agent body + project brief + memory), renders
// each tool call as a UI step, and implements multi-agent delegation.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { z } = require('zod');
const { glob } = require('glob');
const codeblocks = require('code-blocks');
const skills = require('./skills');
const memory = require('./memory');
const plans = require('./plans');
const { commandMayChangeFiles } = require('./orvix');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const MODES_DIR = path.join(AGENTS_DIR, 'modes');
const MAX_DEPTH = 2;                 // orchestrator (0) -> sub-agent (1) -> (2)
const MAX_OUTPUT_CHARS = 12000;      // cap tool outputs fed back to the model
const MEMORY_FILE = memory.MEMORY_FILE;
const MAX_LISTED_SYMBOLS = 50;       // a symbol list longer than this comes back capped, with the total
const MAX_LISTED_SKILLS = 60;        // list_skills (and the names in a use_skill error) stop here, with the total
const RANGE_DEFAULT_LINES = 500;     // read_file with an offset but no limit
const MAX_LINE_CHARS = 2000;         // one line of a ranged read (a minified file is one huge line)
const MAX_DIRECTORY_LINES = 60;      // the "Directories" overview of the system brief
// shell commands whose output may be search hits; orvix can rewrite those as the symbols that contain them
const GREP_COMMAND = /\b(grep|egrep|fgrep|rg|ag|ack)\b/;

// the navigation tools that exist while the orvix index is active
const ORVIX_TOOLS = ['code_map', 'find_symbol', 'show_symbol', 'who_calls', 'calls'];

// default tool sets when an agent .md omits a ```tools``` block
const READONLY_TOOLS = ['list_files', 'read_file', 'search', ...ORVIX_TOOLS, 'read_rule', 'list_skills'];

// ---- interaction modes -------------------------------------------------------------
// `auto` is the router's own choice and never reaches runAgent as such: the loop runs as `agent`.
const { MODES } = require('./modes');
// The tools a mode allows (`null` = no restriction). A tool named here that does not exist (yet) is simply
// absent: buildTools intersects this list with the agent's own whitelist and the registry.
const READ_ONLY = [
    'list_files', 'read_file', 'grep', 'glob', 'search', ...ORVIX_TOOLS, 'read_rule', 'list_skills', 'use_skill',
    'list_conversations', 'read_conversation', 'get_diagnostics', 'ask_user', 'delegate',
];
const MODE_TOOLS = {
    ask: READ_ONLY,
    plan: [...READ_ONLY, 'write_plan'],
    agent: null,
};
// the sub-agents a read-only mode may delegate to
const READ_ONLY_AGENTS = ['explorer', 'reviewer'];
// the mode a loop runs in: the three real modes as they are, anything else (`auto`) as `agent`
const loopMode = (mode) => (mode === 'ask' || mode === 'plan' ? mode : 'agent');

// -----------------------------------------------------------------------------
// agent definitions
// -----------------------------------------------------------------------------
async function loadAgents() {
    const out = {};
    let files = [];
    try { files = await glob('*.md', { cwd: AGENTS_DIR, absolute: true }); } catch (e) { files = []; }
    for (const file of files) {
        // files starting with "_" are shared prompt fragments (agents/_navigation.md), not agents
        if (path.basename(file).startsWith('_')) continue;
        try {
            const content = await fsp.readFile(file, 'utf8');
            const blocks = await codeblocks.fromString(content);
            let description = '';
            let tools = null;
            let body = content;
            for (const b of blocks) {
                if (!b.lang) continue;
                const fence = '```' + b.lang + '\n' + b.value + '\n```';
                if (body.includes(fence)) body = body.replace(fence, '');
                if (b.lang === 'description') description = b.value.trim();
                else if (b.lang === 'tools') tools = b.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
            }
            const name = path.basename(file, '.md');
            out[name] = { name, description, tools, body: body.trim() };
        } catch (e) { /* skip malformed agent file */ }
    }
    return out;
}

// -----------------------------------------------------------------------------
// project memory (AGENTS.md, Cursor rules, .cursorrules, .aicode/memory.md) lives
// in lib/memory.js; readProjectMemory(cwd, { activeFile }) -> { text, rules, injected }
// -----------------------------------------------------------------------------
const readProjectMemory = memory.readProjectMemory;

// -----------------------------------------------------------------------------
// tool registry (wraps the confirm-gated sandbox helpers from runPrompt)
// -----------------------------------------------------------------------------
function truncate(str, max = MAX_OUTPUT_CHARS) {
    const s = String(str == null ? '' : str);
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

const { tool } = require('ai');

// `lines offset..offset+limit` of a file with line numbers, a header naming the range and the file's total,
// and a footer saying where to continue; the output stays within MAX_OUTPUT_CHARS
function readRange(file, text, offset, limit) {
    if (text === '') return { text: `${file}: (empty file)` };
    const lines = text.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // a final newline is not another line
    const total = lines.length;
    const start = Math.max(1, Math.trunc(Number(offset)) || 1);
    const wanted = limit === null || limit === undefined ? RANGE_DEFAULT_LINES : Math.max(1, Math.trunc(Number(limit)) || 1);
    if (start > total) return { error: `offset ${start} is past the end of ${file} (${total} lines)` };
    const out = [];
    let chars = 0;
    let n = start;
    for (; n < start + wanted && n <= total; n++) {
        let body = lines[n - 1];
        if (body.length > MAX_LINE_CHARS) body = body.slice(0, MAX_LINE_CHARS) + '…';
        const line = `${String(n).padStart(6)}|${body}`;
        if (out.length > 0 && chars + line.length + 1 > MAX_OUTPUT_CHARS) break;
        out.push(line);
        chars += line.length + 1;
    }
    const last = n - 1;
    const footer = last < total ? `\n… ${total - last} more lines (continue with offset ${last + 1})` : '';
    return { text: `${file} · lines ${start}-${last} of ${total}\n${out.join('\n')}${footer}` };
}

// a symbol list the model can read in full: past MAX_LISTED_SYMBOLS it is capped and carries the total
function capSymbols(list) {
    if (list.length <= MAX_LISTED_SYMBOLS) return list;
    return { total: list.length, shown: MAX_LISTED_SYMBOLS, note: 'refine the query (a more specific name, or a path in code_map) to see the rest', symbols: list.slice(0, MAX_LISTED_SYMBOLS) };
}

// an object result that is too big to send whole becomes truncated JSON text, like any other tool output
function bounded(value) {
    const text = JSON.stringify(value);
    return text.length <= MAX_OUTPUT_CHARS ? value : truncate(text);
}

// the source of a symbol, cut so that the whole `{ ...symbol, source }` result still fits the output cap
// (measured as JSON: newlines, quotes and backslashes take two characters there)
function fitSource(shown) {
    const source = shown.source;
    const room = MAX_OUTPUT_CHARS - JSON.stringify({ ...shown, source: '' }).length - 120;
    const escaped = (text) => JSON.stringify(text).length - 2;
    if (escaped(source) <= room) return source;
    let cut = Math.max(0, Math.min(source.length, room));
    while (cut > 0 && escaped(source.slice(0, cut)) > room) cut = Math.floor(cut * 0.9);
    return `${source.slice(0, cut)}\n… [truncated ${source.length - cut} chars]`;
}

function buildTools(runtime, allowed) {
    const { engine, ctx, cwd, ui } = runtime;
    const mode = loopMode(runtime.mode);
    const registry = {};
    // the orvix code index, when it is active for this project (without it, none of the symbol tools exist)
    const orvix = ctx && ctx.orvix && ctx.orvix.enabled ? ctx.orvix : null;

    // Project rules (.cursor/rules): runAgent hands them over already parsed; a runtime
    // built without them loads them on first use.
    const rulesOf = () => runtime.rules || (runtime.rules = memory.loadRules(cwd));
    // Glob rules are appended to the result of a tool that touches a matching file,
    // once per rule per turn (the per-turn state hangs off the shared ctx).
    const withRules = (result, file) => {
        if (typeof result !== 'string') return result;
        try { return result + memory.ruleNotices(rulesOf(), cwd, file, memory.turnState(ctx)); }
        catch (e) { return result; }
    };

    registry.list_files = tool({
        description: 'List the project files (source tree). Use this to orient yourself before reading files.',
        inputSchema: z.object({}),
        execute: async () => {
            try {
                const t = await engine.traverseDirectory(cwd);
                return truncate(t.sourceTree);
            } catch (e) { return { error: e.message }; }
        },
    });

    registry.read_file = tool({
        description: 'Read a file, relative to the project root. '
            + (orvix ? 'A large source file that is in the code index comes back as a map of its symbols (ids, signatures, line ranges) instead of its text: use show_symbol for one symbol, or read again with offset/limit for exact lines. ' : '')
            + 'offset and limit (1-based line numbers) return just that range, numbered; full: true returns the whole file as it is, never summarized.',
        inputSchema: z.object({
            path: z.string().describe('file path relative to the project root'),
            offset: z.number().int().nullable().describe('first line to read, 1-based (null = from the top)'),
            limit: z.number().int().nullable().describe('how many lines to read (null = the default window)'),
            full: z.boolean().nullable().describe('true = the whole file, never summarized (default false)'),
        }),
        execute: async ({ path: p, offset, limit, full }) => {
            try {
                const raw = String(await ctx.readFile(p));
                const ranged = (offset !== undefined && offset !== null) || (limit !== undefined && limit !== null);
                if (ranged) {
                    const range = readRange(p, raw, offset, limit);
                    return range.error ? { error: range.error } : withRules(range.text, p);
                }
                // a plain read may be shown as the file's symbol map when orvix can say it more cheaply
                const text = orvix && !full ? await orvix.compress('Read', { file_path: path.resolve(cwd, p) }, raw) : raw;
                return withRules(truncate(text), p);
            } catch (e) { return { error: `cannot read ${p}: ${e.message}` }; }
        },
    });

    registry.read_rule = tool({
        description: 'Read a project rule (.cursor/rules) in full by name. The rules that exist but are not loaded are listed under "Available rules" in the project memory; call this when one is relevant to the task.',
        inputSchema: z.object({ name: z.string().describe('the rule name, as listed under "Available rules"') }),
        execute: async ({ name }) => {
            try {
                const rules = rulesOf();
                const rule = memory.findRule(rules, name);
                if (!rule) return { error: `rule '${name}' not found. Available: ${rules.map((r) => r.name).join(', ') || '(none)'}` };
                return { name: rule.name, description: rule.description, globs: rule.globs, body: truncate(rule.body) };
            } catch (e) { return { error: e.message }; }
        },
    });

    registry.search = tool({
        description: 'Search the project files for a string or regular expression. Returns matching file:line entries.',
        inputSchema: z.object({
            query: z.string().describe('text or regular expression to search for'),
            regex: z.boolean().nullable().describe('treat query as a regular expression (default false)'),
        }),
        execute: async ({ query, regex }) => {
            try {
                const t = await engine.traverseDirectory(cwd);
                let re;
                try { re = regex ? new RegExp(query, 'i') : null; } catch (e) { return { error: 'invalid regex: ' + e.message }; }
                const hits = [];
                for (const f of (t.files || t.filesArray || [])) {
                    const code = f.code;
                    if (!code) continue;
                    const lines = String(code).split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        const matched = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(String(query).toLowerCase());
                        if (matched) {
                            hits.push(`${f.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                            if (hits.length >= 100) break;
                        }
                    }
                    if (hits.length >= 100) break;
                }
                return hits.length ? truncate(hits.join('\n')) : 'no matches';
            } catch (e) { return { error: e.message }; }
        },
    });

    // ---- code navigation through the orvix index (read-only; available in every mode) ----
    if (orvix) {
        registry.code_map = tool({
            description: 'The ranked map of the project\'s symbols (functions, classes, methods, constants), each with a short id, its signature, line and caller count, fitted to a token budget. Start here to find your way around; pass a path to see only one directory or file.',
            inputSchema: z.object({
                budget: z.number().int().nullable().describe(`approximate size in tokens (null = the default, ${orvix.mapBudget})`),
                path: z.string().nullable().describe('only this directory or file, relative to the project root (null = the whole project)'),
            }),
            execute: async ({ budget, path: sub }) => {
                try {
                    const map = await orvix.map(budget || orvix.mapBudget, { path: sub || undefined });
                    return typeof map === 'string' ? truncate(map) : map;
                } catch (e) { return { error: e.message }; }
            },
        });

        registry.find_symbol = tool({
            description: 'Find symbols by name or signature in the code index. Returns each match with its id, name, kind, container, file, line range, signature and whether it is exported.',
            inputSchema: z.object({ query: z.string().describe('a name, part of a name, or part of a signature') }),
            execute: async ({ query }) => {
                try {
                    const found = await orvix.find(query);
                    return Array.isArray(found) ? bounded(capSymbols(found)) : found;
                } catch (e) { return { error: e.message }; }
            },
        });

        registry.show_symbol = tool({
            description: 'The exact source of one symbol, by id (or a unique id prefix) or by name. Use it instead of reading a whole file. When the reference matches several symbols you get the candidates: call again with one id.',
            inputSchema: z.object({ id: z.string().describe('a symbol id, a short id prefix, or a name') }),
            execute: async ({ id }) => {
                try {
                    const shown = await orvix.show(id);
                    if (shown && typeof shown.source === 'string') return { ...shown, source: fitSource(shown) };
                    return shown;
                } catch (e) { return { error: e.message }; }
            },
        });

        registry.who_calls = tool({
            description: 'The symbols that call this one. Run it before changing a signature. Calls made through a receiver (obj.method()) are not attributed, so confirm with a text search as well.',
            inputSchema: z.object({ id: z.string().describe('a symbol id, a short id prefix, or a name') }),
            execute: async ({ id }) => {
                try {
                    const callers = await orvix.whoCalls(id);
                    if (!Array.isArray(callers)) return callers;
                    if (callers.length === 0) return { symbols: [], note: 'Calls through a receiver (obj.method()) are not attributed; confirm with a text search before changing a signature.' };
                    return bounded(capSymbols(callers));
                } catch (e) { return { error: e.message }; }
            },
        });

        registry.calls = tool({
            description: 'The symbols this one calls (what it depends on).',
            inputSchema: z.object({ id: z.string().describe('a symbol id, a short id prefix, or a name') }),
            execute: async ({ id }) => {
                try {
                    const callees = await orvix.calls(id);
                    return Array.isArray(callees) ? bounded(capSymbols(callees)) : callees;
                } catch (e) { return { error: e.message }; }
            },
        });
    }

    registry.write_file = tool({
        description: 'Create or overwrite a file with the given contents (shows a diff and asks for confirmation when --confirm is set).',
        inputSchema: z.object({
            path: z.string().describe('file path relative to the project root'),
            content: z.string().describe('the full contents to write'),
        }),
        execute: async ({ path: p, content }) => {
            try {
                const ok = await ctx.writeFile(p, content);
                if (ok && orvix) orvix.markDirty([p]);
                return ok ? withRules(`wrote ${p} (${String(content).split('\n').length} lines)`, p) : { error: 'write cancelled or failed' };
            } catch (e) { return { error: e.message }; }
        },
    });

    registry.edit_file = tool({
        description: 'Edit an existing file by describing the change in natural language (applied as targeted search/replace edits, with a diff preview).',
        inputSchema: z.object({
            path: z.string().describe('file path relative to the project root'),
            instructions: z.string().describe('what to change, described precisely'),
        }),
        execute: async ({ path: p, instructions }) => {
            try {
                const res = await ctx.editFile(p, instructions);
                if (res && res.ok) {
                    if (orvix) orvix.markDirty([p]);
                    return withRules(`edited ${p} (${res.applied} change(s))`, p);
                }
                return { error: (res && res.error) || 'edit failed' };
            } catch (e) { return { error: e.message }; }
        },
    });

    registry.run_bash = tool({
        description: 'Run a shell command from the project root and return its output (confirmation required when --confirm is set). Use for builds, tests, git, scaffolding, etc.',
        inputSchema: z.object({ command: z.string().describe('the shell command to run') }),
        execute: async ({ command }) => {
            try {
                const res = await ctx.executeBash(command);
                if (res === false) return { error: 'command cancelled or failed to run' };
                // the command may have changed any file: the code index refreshes in the background
                if (orvix && commandMayChangeFiles(command)) orvix.markDirty();
                let text;
                if (res && typeof res === 'object') {
                    text = [res.output || '', res.error ? '[stderr] ' + res.error : ''].filter(Boolean).join('\n') || '(no output)';
                } else {
                    text = String(res);
                }
                // search hits printed by grep/rg may be shown as the symbols that contain them
                if (orvix && GREP_COMMAND.test(command)) text = await orvix.compress('Bash', { command }, text);
                return truncate(text);
            } catch (e) { return { error: truncate(e.message, 2000) }; }
        },
    });

    registry.list_skills = tool({
        description: 'List installed Agent Skills (skills.sh / SKILL.md, Cursor\'s too) available in this project, each with where it comes from. The list can be long: pass a query to narrow it.',
        inputSchema: z.object({ query: z.string().optional().describe('words that must all appear in the name or description') }),
        execute: async ({ query } = {}) => {
            try {
                const list = skills.discoverSkills(cwd);
                if (!list.length) return 'no skills installed';
                const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
                const found = list.filter((s) => { const text = `${s.name}\n${s.description}`.toLowerCase(); return words.every((word) => text.includes(word)); });
                if (!found.length) return `no skill matches "${String(query).trim()}" (${list.length} installed)`;
                const lines = found.slice(0, MAX_LISTED_SKILLS).map((s) => `${s.name} (${s.origin}): ${s.description}`);
                if (found.length > MAX_LISTED_SKILLS) lines.push(`… ${found.length - MAX_LISTED_SKILLS} more of ${found.length}: pass a query to narrow the list`);
                return lines.join('\n');
            } catch (e) { return { error: e.message }; }
        },
    });

    registry.use_skill = tool({
        description: 'Load an installed skill by name to get its full instructions and bundled file paths, then follow them using the other tools.',
        inputSchema: z.object({ name: z.string().describe('the exact skill name') }),
        execute: async ({ name }) => {
            try {
                const list = skills.discoverSkills(cwd);
                const wanted = String(name == null ? '' : name).trim().toLowerCase();
                // an exact name first, then a part of one; no name at all is no skill (an empty string is "part of" every name)
                const match = wanted && (list.find((s) => s.name.toLowerCase() === wanted)
                    || list.find((s) => s.name.toLowerCase().includes(wanted)));
                if (!match) {
                    const names = list.slice(0, MAX_LISTED_SKILLS).map((s) => s.name).join(', ') + (list.length > MAX_LISTED_SKILLS ? `, … (${list.length - MAX_LISTED_SKILLS} more: list_skills with a query)` : '');
                    const denied = skills.isIgnored(name) ? ' (it is on the list of skills that need Cursor; config.skills.allow lifts that)' : '';
                    return { error: `skill '${name}' not found${denied}. Available: ${names || '(none)'}` };
                }
                const loaded = skills.loadSkill(match);
                return { name: match.name, origin: match.origin, dir: match.dir, files: loaded.files, instructions: truncate(loaded.body) };
            } catch (e) { return { error: e.message }; }
        },
    });

    registry.ask_user = tool({
        description: 'Ask the user a clarifying question and return their answer. Use sparingly, only when genuinely blocked.',
        inputSchema: z.object({ question: z.string().describe('the question to ask the user') }),
        execute: async ({ question }) => {
            try { const ans = await ctx.ask(question); return { answer: ans == null ? '' : String(ans) }; }
            catch (e) { return { error: e.message }; }
        },
    });

    registry.remember = tool({
        description: 'Save a short, durable note about this project to .aicode/memory.md for future runs (e.g. the test command, a convention, a user preference). Use sparingly, only for facts that will save time later.',
        inputSchema: z.object({ note: z.string().describe('a concise fact worth remembering') }),
        execute: async ({ note }) => {
            try {
                const clean = String(note).replace(/\s+/g, ' ').trim();
                if (!clean) return { error: 'empty note' };
                let existing = '';
                try { existing = await ctx.readFile(MEMORY_FILE); } catch (e) { existing = ''; }
                if (!existing) existing = '# Project memory\n\n(aicode-maintained notes)\n';
                const date = new Date().toISOString().slice(0, 10);
                const updated = existing.replace(/\s*$/, '') + `\n- (${date}) ${clean}\n`;
                try { await fsp.mkdir(path.join(cwd, '.aicode'), { recursive: true }); } catch (e) { }
                const ok = await ctx.writeFile(MEMORY_FILE, updated);
                return ok ? 'remembered' : { error: 'write cancelled' };
            } catch (e) { return { error: e.message }; }
        },
    });

    // ---- plans: written in Plan mode, followed in Agent mode ----
    registry.write_plan = tool({
        description: `Write the implementation plan as a markdown file under ${plans.PLANS_DIR}/ and show it to the user. Call it once, when your investigation is done. The plan names concrete files and functions, lists the verification steps, and keeps its todos small and in order.`,
        inputSchema: z.object({
            title: z.string().describe('a short title; it names the file'),
            overview: z.string().describe('one or two sentences: what the plan does and why'),
            markdown: z.string().describe('the plan itself, in markdown: the approach, the files and functions that change, the verification steps, the risks'),
            todos: z.array(z.object({
                id: z.string().describe('a short kebab-case slug, unique within the plan'),
                content: z.string().describe('one small, concrete step that starts with a verb'),
            })).describe('the steps that implement the plan, in order'),
        }),
        execute: async ({ title, overview, markdown, todos }) => {
            try {
                const oneLine = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
                const name = oneLine(title);
                if (!name) return { error: 'the plan needs a title' };
                const items = [];
                for (const todo of todos || []) {
                    const id = oneLine(todo.id);
                    const content = oneLine(todo.content);
                    if (!id || !content) return { error: 'every todo needs an id and a content' };
                    if (items.some((t) => t.id === id)) return { error: `duplicate todo id '${id}': every todo needs its own id` };
                    items.push({ id, content, status: 'pending' });
                }
                const summary = oneLine(overview);
                const text = plans.renderPlan({ title: name, overview: summary, markdown, todos: items });
                const size = Buffer.byteLength(text);
                if (size > plans.MAX_PLAN_BYTES) return { error: `the plan is too long (${Math.ceil(size / 1024)} KB, the limit is ${plans.MAX_PLAN_BYTES / 1024} KB): make it shorter` };
                const { abs, rel } = plans.uniquePlanPath(cwd, name);
                await fsp.mkdir(path.dirname(abs), { recursive: true });
                const ok = await ctx.writeFile(rel, text);
                if (!ok) return { error: 'write cancelled or failed' };
                if (ui && typeof ui.planCreated === 'function') {
                    try { ui.planCreated({ path: rel, title: name, overview: summary, todos: items }); } catch (e) { /* showing the plan is best-effort */ }
                }
                return { path: rel };
            } catch (e) { return { error: e.message }; }
        },
    });

    registry.plan_todo = tool({
        description: `Set the status of one todo of a plan file under ${plans.PLANS_DIR}/ while you implement it: in_progress when you start the todo, completed once it is done and verified. Returns the updated todo list.`,
        inputSchema: z.object({
            path: z.string().describe('the plan file, as it is named in the task (relative to the project root)'),
            id: z.string().describe('the id of the todo'),
            status: z.enum(plans.STATUSES).describe('pending | in_progress | completed'),
        }),
        execute: async ({ path: p, id, status }) => {
            try {
                const abs = plans.editablePlanFile(cwd, p);
                const updated = plans.setTodoStatus(await fsp.readFile(abs, 'utf8'), String(id), status);
                await fsp.writeFile(abs, updated.text, 'utf8');
                return { path: plans.displayPath(cwd, abs), todos: updated.todos };
            } catch (e) { return { error: e.message }; }
        },
    });

    // the read-only modes delegate to read-only sub-agents only
    const delegable = (name) => name !== 'main' && (mode === 'agent' || READ_ONLY_AGENTS.includes(name));
    registry.delegate = tool({
        description: mode === 'agent'
            ? 'Delegate a self-contained sub-task to a specialized sub-agent and get back its report. Available sub-agents: explorer (read-only research), coder (implementation), reviewer (read-only critique).'
            : `Delegate a self-contained read-only sub-task to a sub-agent and get back its report. This session is in ${mode} mode: the available sub-agents are explorer (research) and reviewer (critique).`,
        inputSchema: z.object({
            agent: z.string().describe(mode === 'agent' ? 'which sub-agent: explorer | coder | reviewer' : 'which sub-agent: explorer | reviewer'),
            task: z.string().describe('a clear, self-contained task description with all context the sub-agent needs'),
        }),
        execute: async ({ agent, task }) => {
            if (runtime.depth >= MAX_DEPTH) return { error: 'maximum delegation depth reached; do the work directly with your own tools' };
            const sub = runtime.agents[agent];
            const available = Object.keys(runtime.agents).filter(delegable).sort().join(', ');
            if (!sub || agent === 'main') return { error: `unknown sub-agent '${agent}'. Available: ${available}` };
            if (!delegable(agent)) return { error: `sub-agent '${agent}' is not available in ${mode} mode, which is read-only. Available: ${available}` };
            try {
                const text = await runAgent({
                    engine: runtime.engine, agentName: agent, agents: runtime.agents,
                    task, ctx: runtime.ctx, ui: runtime.ui, depth: runtime.depth + 1, streamAnswer: false,
                    mode,
                });
                return { agent, report: truncate(text) };
            } catch (e) { return { error: e.message }; }
        },
    });

    // The agent's own tools, narrowed to what the mode allows (names that do not exist are ignored).
    // Sub-agents run in their parent's mode, so a reviewer in Ask mode has no run_bash.
    const allowedByMode = MODE_TOOLS[mode];
    const names = ((allowed && allowed.length) ? allowed : READONLY_TOOLS).filter((n) => !allowedByMode || allowedByMode.includes(n));
    const picked = {};
    for (const n of names) if (registry[n]) picked[n] = registry[n];
    return picked;
}

// -----------------------------------------------------------------------------
// system prompt composition
// -----------------------------------------------------------------------------
// "- lib/ (23 files)": the top-level and second-level directories of a traverse snapshot, with file counts
function directoriesOverview(snapshot) {
    const counts = new Map();
    let topLevelFiles = 0;
    for (const file of (snapshot && (snapshot.filesArray || snapshot.files)) || []) {
        const parts = String(file.path || '').split(/[\\/]/).filter(Boolean);
        if (parts.length === 0) continue;
        if (parts.length === 1) { topLevelFiles++; continue; }
        const first = `${parts[0]}/`;
        counts.set(first, (counts.get(first) || 0) + 1);
        if (parts.length > 2) {
            const second = `${parts[0]}/${parts[1]}/`;
            counts.set(second, (counts.get(second) || 0) + 1);
        }
    }
    const lines = Array.from(counts.keys()).sort().map((dir) => `- ${dir} (${counts.get(dir)} files)`);
    if (topLevelFiles > 0) lines.unshift(`- ./ (${topLevelFiles} files at the top level)`);
    if (lines.length > MAX_DIRECTORY_LINES) {
        const more = lines.length - MAX_DIRECTORY_LINES;
        lines.length = MAX_DIRECTORY_LINES;
        lines.push(`… ${more} more directories`);
    }
    return lines.join('\n');
}

async function projectBrief(runtime) {
    const { engine, ctx } = runtime;
    let snapshot = null;
    try { snapshot = await engine.traverseDirectory(ctx.userDirectory); } catch (e) { snapshot = null; }
    const head = [
        '# Project context',
        `Working directory: ${ctx.userDirectory}`,
        `Operating system: ${os.platform()}`,
        ctx.language ? `Write your final answer to the user in: ${ctx.language}` : '',
    ].filter((l) => l !== '');

    // with a code index, the ranked symbol map replaces the full file tree: it costs far fewer tokens
    // and says what the code is, not just where files are
    const orvix = ctx.orvix && ctx.orvix.enabled ? ctx.orvix : null;
    if (orvix) {
        let map = null;
        try { map = await orvix.map(orvix.mapBudget, { wait: false }); } catch (e) { map = null; }
        if (typeof map === 'string' && map.trim() !== '' && !/^no symbols indexed/i.test(map.trim())) {
            return [
                ...head,
                '',
                '# Code map (orvix)',
                map,
                '',
                '# Directories',
                directoriesOverview(snapshot),
                '',
                'Use list_files for the complete file tree, find_symbol/show_symbol for code, search for literals.',
            ].join('\n');
        }
    }

    return [
        ...head,
        'Project source tree (use read_file / search to inspect contents on demand):',
        '```',
        snapshot ? snapshot.sourceTree : '',
        '```',
    ].filter((l) => l !== '').join('\n');
}

// agents/_navigation.md holds two variants of the code-navigation policy, each under a
// `<!-- variant: name -->` marker: `orvix` (the code index is active) and `basic` (it is not)
let navigationCache = null;
function loadNavigation() {
    if (navigationCache) return navigationCache;
    let text = '';
    try { text = fs.readFileSync(path.join(AGENTS_DIR, '_navigation.md'), 'utf8'); } catch (e) { text = ''; }
    const variant = (name) => {
        const m = new RegExp(`<!-- variant: ${name} -->([\\s\\S]*?)(?=<!-- variant: |$)`).exec(text);
        return m ? m[1].trim() : '';
    };
    navigationCache = { orvix: variant('orvix'), basic: variant('basic') };
    return navigationCache;
}

// agents/modes/<mode>.md: the instructions of one interaction mode ('' when the file is missing)
const modePromptCache = {};
function loadModePrompt(mode) {
    if (modePromptCache[mode] === undefined) {
        let text = '';
        try { text = fs.readFileSync(path.join(MODES_DIR, `${mode}.md`), 'utf8').trim(); } catch (e) { text = ''; }
        modePromptCache[mode] = text;
    }
    return modePromptCache[mode];
}

// The `# Mode: $mode` section of a loop's system prompt. The orchestrator gets the instructions of the
// mode; a sub-agent of a read-only mode gets a one-line reminder instead (its tools are already read-only,
// and the orchestrator's instructions, write_plan and ask_user among them, are not its business).
function modeSection(mode, depth) {
    if (depth === 0) {
        const body = loadModePrompt(mode);
        return body ? `# Mode: ${mode}\n${body}` : '';
    }
    if (mode === 'ask' || mode === 'plan') {
        return `# Mode: ${mode}\nThis session is read-only: you cannot change files or run commands. Report what you find, and never claim to have changed anything.`;
    }
    return '';
}

// -----------------------------------------------------------------------------
// tool-event rendering
// -----------------------------------------------------------------------------
function toolLabel(depth, part) {
    const indent = depth > 0 ? '  '.repeat(depth) + '↳ ' : '';
    const inp = part.input || {};
    switch (part.toolName) {
        case 'read_file': return `${indent}read ${inp.path || ''}${inp.offset || inp.limit ? ` (lines ${inp.offset || 1}${inp.limit ? '+' + inp.limit : '…'})` : ''}`;
        case 'code_map': return `${indent}code map${inp.path ? ' ' + inp.path : ''}`;
        case 'find_symbol': return `${indent}find symbol "${String(inp.query || '').slice(0, 40)}"`;
        case 'show_symbol': return `${indent}show symbol ${String(inp.id || '').slice(0, 40)}`;
        case 'who_calls': return `${indent}who calls ${String(inp.id || '').slice(0, 40)}`;
        case 'calls': return `${indent}calls of ${String(inp.id || '').slice(0, 40)}`;
        case 'write_file': return `${indent}write ${inp.path || ''}`;
        case 'edit_file': return `${indent}edit ${inp.path || ''}`;
        case 'run_bash': return `${indent}run: ${String(inp.command || '').split('\n')[0].slice(0, 60)}`;
        case 'search': return `${indent}search "${String(inp.query || '').slice(0, 40)}"`;
        case 'read_rule': return `${indent}read rule ${inp.name || ''}`;
        case 'list_files': return `${indent}list files`;
        case 'list_skills': return `${indent}list skills`;
        case 'use_skill': return `${indent}use skill ${inp.name || ''}`;
        case 'ask_user': return `${indent}ask user`;
        case 'remember': return `${indent}remember`;
        case 'write_plan': return `${indent}write plan${inp.title ? ` "${String(inp.title).slice(0, 50)}"` : ''}`;
        case 'plan_todo': return `${indent}plan todo ${String(inp.id || '').slice(0, 40)}${inp.status ? ` → ${inp.status}` : ''}`;
        case 'delegate': return `${indent}delegate → ${inp.agent || ''}`;
        default: return `${indent}${part.toolName}`;
    }
}

function resultSummary(part) {
    const out = part.output;
    if (out && typeof out === 'object' && out.error) return 'error';
    if (part.toolName === 'delegate') return 'done';
    if (part.toolName === 'write_plan' && out && typeof out.path === 'string') return out.path;
    if (part.toolName === 'plan_todo' && out && Array.isArray(out.todos)) return `${out.todos.filter((t) => t.status === 'completed').length}/${out.todos.length} completed`;
    // the code-index tools answer with symbol lists, one symbol, or the candidates of an ambiguous reference
    if (Array.isArray(out)) return `${out.length} ${out.length === 1 ? 'symbol' : 'symbols'}`;
    if (out && typeof out === 'object') {
        if (out.ambiguous && Array.isArray(out.candidates)) return `${out.candidates.length} candidates`;
        if (typeof out.total === 'number') return `${out.total} symbols`;
        if (Array.isArray(out.symbols)) return out.symbols.length ? `${out.symbols.length} symbols` : 'none found';
        if (typeof out.source === 'string' && out.file) return `${out.file}:${out.startLine}-${out.endLine}`;
    }
    if (typeof out === 'string') {
        const lines = out.split('\n').length;
        return lines > 1 ? `${lines} lines` : (out.length > 40 ? out.slice(0, 40) + '…' : out);
    }
    return 'done';
}

// Inject a pre-selected skill so the orchestrator follows it directly (instead of
// having to discover + load it via the use_skill tool first).
function skillSection(skill) {
    const files = (skill.files && skill.files.length)
        ? ('\n\nBundled skill files (read them with read_file / run them as instructed):\n' + skill.files.map((f) => `- ${f}`).join('\n'))
        : '';
    return [
        `# Active skill: ${skill.name}`,
        `Fulfill the user's request by following this skill's instructions step by step, using your tools (read files, run commands, write files). The skill's files live under: ${skill.dir}`,
        '',
        '## Skill instructions',
        truncate(skill.body || ''),
        files,
    ].join('\n');
}

// -----------------------------------------------------------------------------
// run an agent (one loop, possibly spawning sub-agents via delegate)
// -----------------------------------------------------------------------------
async function runAgent({ engine, agentName, agents, task, ctx, ui, history = [], depth = 0, streamAnswer = true, skill = null, mode = 'agent' }) {
    const agent = agents[agentName] || agents.main;
    if (!agent) throw new Error(`agent '${agentName}' not found`);
    // the interaction mode decides the tools (ask and plan are read-only) and adds its instructions to the
    // prompt; sub-agents run in their parent's mode
    const loopAs = loopMode(mode);

    // project memory is re-read for every run (AGENTS.md / rules may change while a session is open);
    // the rules whose text is already in the prompt are not repeated on tool results
    const projectMemory = readProjectMemory(ctx.userDirectory, { activeFile: ctx.editor && ctx.editor.activeFile });
    memory.markInjected(memory.turnState(ctx), projectMemory.injected);
    const runtime = { engine, ctx, ui, agents, depth, cwd: ctx.userDirectory, rules: projectMemory.rules, mode: loopAs };
    // the code index: anything may have changed since the last turn (the user's own edits, git, other
    // tools), so every turn of the orchestrator starts a background refresh; the first query waits for it
    const orvix = ctx.orvix && ctx.orvix.enabled ? ctx.orvix : null;
    if (orvix && depth === 0) {
        try { orvix.markDirty(); orvix.indexNow(); } catch (e) { /* the index is best-effort */ }
    }
    const brief = await projectBrief(runtime);
    // the navigation policy comes after the project memory on purpose: it takes precedence over any
    // orvix shell instructions AGENTS.md carries (the agent has no `orvix` command to run)
    const navigation = loadNavigation();
    const system = [
        agent.body,
        brief,
        projectMemory.text ? ('# Project memory\n' + projectMemory.text) : '',
        orvix ? navigation.orvix : navigation.basic,
        skill ? skillSection(skill) : '',
        modeSection(loopAs, depth),
        ctx.personality ? ('# Voice / tone\n' + ctx.personality) : '',
    ].filter(Boolean).join('\n\n');

    const tools = buildTools(runtime, agent.tools);
    const messages = [...(history || []), { role: 'user', content: task }];

    const pending = new Map();
    const onEvent = (part) => {
        try {
            if (part.type === 'tool-call') {
                if (streamAnswer && ui.isStreaming && ui.isStreaming()) ui.streamEnd();
                const step = ui.step(toolLabel(depth, part));
                pending.set(part.toolCallId, step);
            } else if (part.type === 'tool-result') {
                const step = pending.get(part.toolCallId); pending.delete(part.toolCallId);
                if (step) step.done(resultSummary(part));
            } else if (part.type === 'tool-error') {
                const step = pending.get(part.toolCallId); pending.delete(part.toolCallId);
                if (step) step.fail(toolLabel(depth, part) + ' failed');
            }
        } catch (e) { /* rendering is best-effort */ }
    };
    const onText = streamAnswer ? (t) => { try { ui.streamChunk(t); } catch (e) { } } : null;

    if (streamAnswer) ui.status(depth === 0 ? `${loopAs} · thinking …` : 'sub-agent · thinking …');
    const res = await engine.runAgentLoop({
        messages, system, tools,
        maxSteps: depth === 0 ? 20 : 10,
        onText, onEvent,
    });
    // close any dangling steps (e.g. loop hit the step cap mid-tool)
    for (const step of pending.values()) { try { step.done(); } catch (e) { } }
    if (streamAnswer) { try { ui.streamEnd(); } catch (e) { } ui.statusStop(); }
    return res.text;
}

module.exports = { loadAgents, buildTools, runAgent, readProjectMemory, projectBrief, loadNavigation, MAX_DEPTH, MODES, MODE_TOOLS };
