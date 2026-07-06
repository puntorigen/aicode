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
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { z } = require('zod');
const { glob } = require('glob');
const codeblocks = require('code-blocks');
const skills = require('./skills');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const MAX_DEPTH = 2;                 // orchestrator (0) -> sub-agent (1) -> (2)
const MAX_OUTPUT_CHARS = 12000;      // cap tool outputs fed back to the model
const MEMORY_FILE = path.join('.aicode', 'memory.md');

// default tool sets when an agent .md omits a ```tools``` block
const READONLY_TOOLS = ['list_files', 'read_file', 'search', 'list_skills'];

// -----------------------------------------------------------------------------
// agent definitions
// -----------------------------------------------------------------------------
async function loadAgents() {
    const out = {};
    let files = [];
    try { files = await glob('*.md', { cwd: AGENTS_DIR, absolute: true }); } catch (e) { files = []; }
    for (const file of files) {
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
// project memory
// -----------------------------------------------------------------------------
function readProjectMemory(cwd) {
    const chunks = [];
    for (const rel of ['AGENTS.md', MEMORY_FILE]) {
        try {
            const abs = path.join(cwd, rel);
            const txt = fs.readFileSync(abs, 'utf8').trim();
            if (txt) chunks.push(`## ${rel}\n${txt}`);
        } catch (e) { /* file absent */ }
    }
    return chunks.join('\n\n');
}

// -----------------------------------------------------------------------------
// tool registry (wraps the confirm-gated sandbox helpers from runPrompt)
// -----------------------------------------------------------------------------
function truncate(str, max = MAX_OUTPUT_CHARS) {
    const s = String(str == null ? '' : str);
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

const { tool } = require('ai');

function buildTools(runtime, allowed) {
    const { engine, ctx, cwd } = runtime;
    const registry = {};

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
        description: 'Read the full contents of a file, relative to the project root.',
        inputSchema: z.object({ path: z.string().describe('file path relative to the project root') }),
        execute: async ({ path: p }) => {
            try { return truncate(await ctx.readFile(p)); }
            catch (e) { return { error: `cannot read ${p}: ${e.message}` }; }
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

    registry.write_file = tool({
        description: 'Create or overwrite a file with the given contents (shows a diff and asks for confirmation when --confirm is set).',
        inputSchema: z.object({
            path: z.string().describe('file path relative to the project root'),
            content: z.string().describe('the full contents to write'),
        }),
        execute: async ({ path: p, content }) => {
            try {
                const ok = await ctx.writeFile(p, content);
                return ok ? `wrote ${p} (${String(content).split('\n').length} lines)` : { error: 'write cancelled or failed' };
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
                if (res && res.ok) return `edited ${p} (${res.applied} change(s))`;
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
                if (res && typeof res === 'object') {
                    return truncate([res.output || '', res.error ? '[stderr] ' + res.error : ''].filter(Boolean).join('\n') || '(no output)');
                }
                return truncate(String(res));
            } catch (e) { return { error: truncate(e.message, 2000) }; }
        },
    });

    registry.list_skills = tool({
        description: 'List installed Agent Skills (skills.sh / SKILL.md) available in this project.',
        inputSchema: z.object({}),
        execute: async () => {
            try {
                const list = skills.discoverSkills(cwd);
                return list.length ? list.map((s) => `${s.name}: ${s.description}`).join('\n') : 'no skills installed';
            } catch (e) { return { error: e.message }; }
        },
    });

    registry.use_skill = tool({
        description: 'Load an installed skill by name to get its full instructions and bundled file paths, then follow them using the other tools.',
        inputSchema: z.object({ name: z.string().describe('the exact skill name') }),
        execute: async ({ name }) => {
            try {
                const list = skills.discoverSkills(cwd);
                const wanted = String(name).toLowerCase();
                const match = list.find((s) => s.name.toLowerCase() === wanted)
                    || list.find((s) => s.name.toLowerCase().includes(wanted));
                if (!match) return { error: `skill '${name}' not found. Available: ${list.map((s) => s.name).join(', ') || '(none)'}` };
                const loaded = skills.loadSkill(match);
                return { name: match.name, dir: match.dir, files: loaded.files, instructions: truncate(loaded.body) };
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

    registry.delegate = tool({
        description: 'Delegate a self-contained sub-task to a specialized sub-agent and get back its report. Available sub-agents: explorer (read-only research), coder (implementation), reviewer (read-only critique).',
        inputSchema: z.object({
            agent: z.string().describe('which sub-agent: explorer | coder | reviewer'),
            task: z.string().describe('a clear, self-contained task description with all context the sub-agent needs'),
        }),
        execute: async ({ agent, task }) => {
            if (runtime.depth >= MAX_DEPTH) return { error: 'maximum delegation depth reached; do the work directly with your own tools' };
            const sub = runtime.agents[agent];
            if (!sub || agent === 'main') {
                return { error: `unknown sub-agent '${agent}'. Available: ${Object.keys(runtime.agents).filter((a) => a !== 'main').join(', ')}` };
            }
            try {
                const text = await runAgent({
                    engine: runtime.engine, agentName: agent, agents: runtime.agents,
                    task, ctx: runtime.ctx, ui: runtime.ui, depth: runtime.depth + 1, streamAnswer: false,
                });
                return { agent, report: truncate(text) };
            } catch (e) { return { error: e.message }; }
        },
    });

    // filter to the allowed set (unknown names ignored)
    const names = (allowed && allowed.length) ? allowed : READONLY_TOOLS;
    const picked = {};
    for (const n of names) if (registry[n]) picked[n] = registry[n];
    return picked;
}

// -----------------------------------------------------------------------------
// system prompt composition
// -----------------------------------------------------------------------------
async function projectBrief(runtime) {
    const { engine, ctx } = runtime;
    let tree = '';
    try { const t = await engine.traverseDirectory(ctx.userDirectory); tree = t.sourceTree; } catch (e) { tree = ''; }
    return [
        '# Project context',
        `Working directory: ${ctx.userDirectory}`,
        `Operating system: ${os.platform()}`,
        ctx.language ? `Write your final answer to the user in: ${ctx.language}` : '',
        '',
        'Project source tree (use read_file / search to inspect contents on demand):',
        '```',
        tree,
        '```',
    ].filter((l) => l !== '').join('\n');
}

// -----------------------------------------------------------------------------
// tool-event rendering
// -----------------------------------------------------------------------------
function toolLabel(depth, part) {
    const indent = depth > 0 ? '  '.repeat(depth) + '↳ ' : '';
    const inp = part.input || {};
    switch (part.toolName) {
        case 'read_file': return `${indent}read ${inp.path || ''}`;
        case 'write_file': return `${indent}write ${inp.path || ''}`;
        case 'edit_file': return `${indent}edit ${inp.path || ''}`;
        case 'run_bash': return `${indent}run: ${String(inp.command || '').split('\n')[0].slice(0, 60)}`;
        case 'search': return `${indent}search "${String(inp.query || '').slice(0, 40)}"`;
        case 'list_files': return `${indent}list files`;
        case 'list_skills': return `${indent}list skills`;
        case 'use_skill': return `${indent}use skill ${inp.name || ''}`;
        case 'ask_user': return `${indent}ask user`;
        case 'remember': return `${indent}remember`;
        case 'delegate': return `${indent}delegate → ${inp.agent || ''}`;
        default: return `${indent}${part.toolName}`;
    }
}

function resultSummary(part) {
    const out = part.output;
    if (out && typeof out === 'object' && out.error) return 'error';
    if (part.toolName === 'delegate') return 'done';
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
async function runAgent({ engine, agentName, agents, task, ctx, ui, history = [], depth = 0, streamAnswer = true, skill = null }) {
    const agent = agents[agentName] || agents.main;
    if (!agent) throw new Error(`agent '${agentName}' not found`);

    const runtime = { engine, ctx, ui, agents, depth, cwd: ctx.userDirectory };
    const brief = await projectBrief(runtime);
    const memory = readProjectMemory(ctx.userDirectory);
    const system = [
        agent.body,
        brief,
        memory ? ('# Project memory\n' + memory) : '',
        skill ? skillSection(skill) : '',
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

    if (streamAnswer) ui.status(depth === 0 ? 'agent · thinking …' : 'sub-agent · thinking …');
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

module.exports = { loadAgents, buildTools, runAgent, readProjectMemory, projectBrief, MAX_DEPTH };
