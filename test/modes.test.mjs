// Offline checks for the interaction modes (auto / agent / plan / ask) and the plan -> implement
// flow: lib/plans.js (the plan file format), the mode toolsets and prompts (lib/agents.js), the
// routing of a turn (lib/runtime.js) with a scripted mock model, and the CLI around them.
// Nothing touches the network or the real HOME.
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { createRequire } from 'module';
import { spawn, spawnSync } from 'child_process';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// isolate HOME (keys.json, caches, global skills) before anything resolves it
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-modes-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `aicode-modes-${label}-`));
// a project directory with a couple of files for the context scan
const PROJECT = tempDir('project');
fs.writeFileSync(path.join(PROJECT, 'hello.js'), 'console.log("hello");\n');
fs.writeFileSync(path.join(PROJECT, 'notes.md'), '# notes\n');
fs.writeFileSync(path.join(PROJECT, 'AGENTS.md'), 'Always use CONVENTION_X here.\n');
const SKILL_DIR = path.join(PROJECT, '.agents', 'skills', 'demo-skill');
fs.mkdirSync(SKILL_DIR, { recursive: true });
fs.writeFileSync(path.join(SKILL_DIR, 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill used by the modes test\n---\nStep 1: do SKILL_STEP_ABC.\n');

const Code2Prompt = require('../lib/engine');
const models = require('../lib/models');
const agents = require('../lib/agents');
const plans = require('../lib/plans');
const modesLib = require('../lib/modes');
const sessionsLib = require('../lib/server/sessions');
const uiLib = require('../lib/ui');
const { createRuntime } = require('../lib/runtime');
const { makeTuiAdapter } = await import('../lib/tui/index.mjs');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortedNames = (tools) => Object.keys(tools).sort();
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// --- provider plumbing -> mock model -----------------------------------------
let MOCK = null;
models.resolveProvider = (prefs) => (prefs && prefs.length ? prefs[0] : null);
models.createModel = () => MOCK;
models.callOptions = () => ({});
models.modelId = () => 'mock-model';
models.estimateCost = () => 0;
models.estimateTokens = () => 10;

const STOP = { unified: 'stop', raw: 'stop' };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool-calls' };
const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const ANALYSIS = {
    type_of: 'question', english: 'say hello', language: 'English', action_file: '', action_reason: 'n/a',
    personality_file: '', personality_reason: 'n/a', needs_agent: false, skill_name: '',
};

// what one streamed model call can say: a text answer, or one tool call
const start = [{ type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: 'r', modelId: 'mock' }];
const say = (text) => [...start, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: STOP, usage: USAGE }];
const callTool = (name, input, id = 'c1') => [
    ...start,
    { type: 'tool-input-start', id, toolName: name },
    { type: 'tool-input-delta', id, delta: JSON.stringify(input) },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
    { type: 'finish', finishReason: TOOL_CALLS, usage: USAGE },
];

// router calls (generateObject) are told apart from template calls by their prompt; `streams` are the
// successive answers of the agent loop (the last one repeats)
function makeMock({ analysis = {}, streams = null, answer = 'Hello from the mock.' } = {}) {
    const counts = { router: 0, template: 0, stream: 0 };
    const prompts = [];
    const tools = [];
    const routerPrompts = [];
    const scripted = streams || [say(answer)];
    const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
            const prompt = JSON.stringify(options.prompt);
            if (prompt.includes('Analyze the following user input text')) {
                counts.router++;
                routerPrompts.push(options.prompt.filter((m) => m.role === 'user').map((m) => m.content.map((p) => p.text || '').join('')).join('\n'));
                return { content: [{ type: 'text', text: JSON.stringify({ schema: { ...ANALYSIS, ...analysis } }) }], finishReason: STOP, usage: USAGE, warnings: [] };
            }
            counts.template++;
            return { content: [{ type: 'text', text: JSON.stringify({ schema: { answer: 'TEMPLATE_ANSWER' } }) }], finishReason: STOP, usage: USAGE, warnings: [] };
        },
        doStream: async (options) => {
            const parts = scripted[Math.min(counts.stream, scripted.length - 1)];
            counts.stream++;
            prompts.push(options.prompt);
            tools.push((options.tools || []).map((t) => t.name).sort());
            return { stream: convertArrayToReadableStream(parts) };
        },
    });
    return { model, counts, prompts, tools, routerPrompts };
}
function systemOf(prompt) { return prompt.filter((m) => m.role === 'system').map((m) => m.content).join('\n'); }
const lastUserText = (prompt) => {
    const user = prompt.filter((m) => m.role === 'user').pop();
    return user ? user.content.map((part) => part.text || '').join('') : '';
};

// a UI recording everything the pipeline tells it
function makeUI({ confirmAnswer = true } = {}) {
    const events = [];
    let streamed = '';
    return {
        events,
        get streamed() { return streamed; },
        step: (label) => {
            events.push(['step', label]);
            return { update() { }, done: (extra) => events.push(['step.done', label, extra]), fail: (text) => events.push(['step.fail', label, text]) };
        },
        status: (t) => events.push(['status', t]),
        statusStart() { }, statusStop() { },
        streamChunk: (c) => { streamed += c; },
        streamEnd: () => events.push(['streamEnd']),
        isStreaming: () => false,
        note: (m) => events.push(['note', String(m)]),
        error: (e) => events.push(['error', String((e && e.message) || e)]),
        debug() { },
        footer: (s) => events.push(['footer', s]),
        answer: (t) => events.push(['answer', t]),
        raw: (t) => events.push(['raw', t]),
        renderMarkdown: (t) => t,
        progressShim: () => ({ text() { }, start() { }, stop() { } }),
        confirm: async (q) => { events.push(['confirm', q]); return confirmAnswer; },
        ask: async () => '',
        select: async () => null,
        diff: (file) => events.push(['diff', file]),
        fileWritten: (file, o) => events.push(['fileWritten', file, o]),
        planCreated: (p) => events.push(['plan', p]),
    };
}
const has = (ui, kind, pred = () => true) => ui.events.some((e) => e[0] === kind && pred(e));

// a plan file as `write_plan` writes it
const PLAN_ARGS = {
    title: 'Add a /health endpoint',
    overview: 'Expose GET /health so a probe can tell the server is up.',
    markdown: '# Add a /health endpoint\n\nRoute in `server.js` › `routes`.\n\n## Verification\n\n- `npm test`\n',
    todos: [{ id: 'route', content: 'Add the route to server.js' }, { id: 'test', content: 'Cover it with a test' }],
};
const PLAN_PATH = '.aicode/plans/add-a-health-endpoint.plan.md';
const withStatus = (todos) => todos.map((t) => ({ ...t, status: 'pending' }));

// =============================================================================
// [A] the modes and the command-line alias
// =============================================================================
console.log('\n[A] modes');
{
    ok('the modes are auto, agent, plan and ask', same(modesLib.MODES, ['auto', 'agent', 'plan', 'ask']));
    ok('the agent stack and the server share that one list', agents.MODES === modesLib.MODES && sessionsLib.MODES === modesLib.MODES);
    ok('--agent alone means --mode agent', modesLib.cliMode({ agent: true, mode: 'auto' }) === 'agent');
    ok('--agent never overrides an explicit --mode', modesLib.cliMode({ agent: true, mode: 'ask' }) === 'ask' && modesLib.cliMode({ agent: true, mode: 'plan' }) === 'plan');
    ok('without --agent the mode is the one given', modesLib.cliMode({ agent: false, mode: 'auto' }) === 'auto' && modesLib.cliMode({ agent: false, mode: 'plan' }) === 'plan' && modesLib.cliMode({ agent: true, mode: 'agent' }) === 'agent');

    ok('MODE_TOOLS.ask is the read-only list of the spec', same(agents.MODE_TOOLS.ask, [
        'list_files', 'read_file', 'grep', 'glob', 'search', 'code_map', 'find_symbol', 'show_symbol', 'who_calls', 'calls',
        'read_rule', 'list_skills', 'use_skill', 'list_conversations', 'read_conversation', 'get_diagnostics', 'ask_user', 'delegate',
    ]));
    ok('MODE_TOOLS.plan adds write_plan and nothing else', same(agents.MODE_TOOLS.plan, [...agents.MODE_TOOLS.ask, 'write_plan']));
    ok('MODE_TOOLS.agent is unrestricted', agents.MODE_TOOLS.agent === null && !('auto' in agents.MODE_TOOLS));
    const writers = ['write_file', 'edit_file', 'run_bash', 'remember', 'write_plan', 'plan_todo'];
    ok('no read-only toolset names a tool that changes anything but write_plan', writers.filter((w) => agents.MODE_TOOLS.ask.includes(w)).length === 0 && writers.filter((w) => agents.MODE_TOOLS.plan.includes(w)).join() === 'write_plan');
}

// =============================================================================
// [B] plan files: names, rendering, parsing
// =============================================================================
console.log('\n[B] plan files');
{
    ok('a title becomes a kebab-case file name', plans.kebab('Add a /health endpoint') === 'add-a-health-endpoint' && plans.kebab('  Fix: the  bug!! ') === 'fix-the-bug');
    ok('accents are dropped, digits kept', plans.kebab('Añadir énfasis a v2.0') === 'anadir-enfasis-a-v2-0');
    ok('a title with nothing to keep is named "plan"', plans.kebab('') === 'plan' && plans.kebab('!!!') === 'plan' && plans.kebab('日本語') === 'plan' && plans.kebab(null) === 'plan' && plans.kebab(undefined) === 'plan');
    const long = plans.kebab('word '.repeat(40));
    ok('a long title is cut at 60 characters, never ending in a dash', long.length <= 60 && !long.endsWith('-') && long.startsWith('word-word-'));
    ok('...also when the cut falls on a separator', plans.kebab(`${'a'.repeat(59)} b`) === 'a'.repeat(59));
    ok('a name never starts with a dash', !plans.kebab('--x--').startsWith('-') && plans.kebab('--x--') === 'x');
    ok('a path is shown relative to the project, and absolute when it is not inside it (the parent counts as outside)', plans.displayPath('/a/b', '/a/b/c/d.md') === 'c/d.md' && plans.displayPath('/a/b', '/a/x.md') === '/a/x.md' && plans.displayPath('/a/b', '/a') === '/a' && plans.displayPath('/a/b', '/a/b/..odd.md') === '..odd.md');

    const text = plans.renderPlan({ ...PLAN_ARGS, todos: withStatus(PLAN_ARGS.todos) });
    ok('the documented frontmatter, then the plan', text === [
        '---',
        'name: "Add a /health endpoint"',
        'overview: "Expose GET /health so a probe can tell the server is up."',
        'todos:',
        '  - id: "route"',
        '    content: "Add the route to server.js"',
        '    status: pending',
        '  - id: "test"',
        '    content: "Cover it with a test"',
        '    status: pending',
        'isProject: false',
        '---',
        '# Add a /health endpoint',
        '',
        'Route in `server.js` › `routes`.',
        '',
        '## Verification',
        '',
        '- `npm test`',
        '',
    ].join('\n'));
    ok('a body without a final newline gets one, a body with one keeps just one', plans.renderPlan({ title: 't', markdown: 'x' }).endsWith('---\nx\n') && plans.renderPlan({ title: 't', markdown: 'x\n' }).endsWith('---\nx\n') && !plans.renderPlan({ title: 't', markdown: 'x\n\n' }).endsWith('x\n\n\n'));
    ok('a plan with no todos says so', plans.renderPlan({ title: 't', overview: 'o', markdown: 'm' }).includes('\ntodos: []\nisProject: false\n'));
    ok('an unknown or missing todo status is written as pending', plans.renderPlan({ title: 't', todos: [{ id: 'a', content: 'x', status: 'bogus' }, { id: 'b', content: 'y' }] }).split('status: pending').length === 3);
    ok('a status that is valid is kept', plans.renderPlan({ title: 't', todos: [{ id: 'a', content: 'x', status: 'completed' }] }).includes('status: completed'));

    // everything a plan holds as a string survives the quoting
    const nasty = [
        'He said "hi": it\'s a \\ backslash', '#1 priority: ship it', '  leading and trailing  ', 'line one\nline two\n---\nline three',
        '日本語 ✓ 🚀', 'tab\there', 'key: value', '- [ ] not a list', '', '>-', '|', '"', "'quoted'", 'a: b\r\nc: d',
    ];
    let roundTrips = true;
    for (const s of nasty) {
        const parsed = plans.parsePlan(plans.renderPlan({ title: s, overview: s, markdown: 'BODY\n', todos: [{ id: s || 'x', content: s, status: 'pending' }] }));
        if (!parsed || parsed.name !== s || parsed.overview !== s || parsed.todos.length !== 1 || parsed.todos[0].content !== s || parsed.todos[0].id !== (s || 'x') || parsed.body !== 'BODY\n') {
            roundTrips = false;
            console.log('    round trip failed for', JSON.stringify(s), JSON.stringify(parsed));
        }
    }
    ok('titles, overviews, ids and todos with quotes, newlines, "---" and unicode round-trip', roundTrips);
    const parsedPlan = plans.parsePlan(text);
    ok('parsePlan reads what renderPlan wrote', parsedPlan.name === PLAN_ARGS.title && parsedPlan.overview === PLAN_ARGS.overview && same(parsedPlan.todos, withStatus(PLAN_ARGS.todos)) && parsedPlan.body === PLAN_ARGS.markdown);

    // the format Cursor writes
    const cursor = [
        '---',
        'name: aicode IDE: VS Code embebido',
        'overview: "Darle a aicode una interfaz: `aicode ide` descarga y lanza."',
        'todos:',
        '  - id: git-branch',
        '    content: "Crear la rama feature/aicode-ide desde main"',
        '    status: completed',
        '  - id: runtime-extract',
        '    content: Extraer runPrompt de index.js a lib/runtime.js',
        '    status: in_progress',
        '  - id: pending-one',
        '    content: Something pending',
        '    status: pending',
        'isProject: false',
        '---',
        '',
        '# Body',
        '',
        '---',
        'a rule above, and todos: nothing here',
        '',
    ].join('\n');
    const c = plans.parsePlan(cursor);
    ok('a plan Cursor wrote: plain and quoted values, a colon inside a plain name', c.name === 'aicode IDE: VS Code embebido' && c.overview === 'Darle a aicode una interfaz: `aicode ide` descarga y lanza.');
    ok('...its todos with their statuses', same(c.todos, [
        { id: 'git-branch', content: 'Crear la rama feature/aicode-ide desde main', status: 'completed' },
        { id: 'runtime-extract', content: 'Extraer runPrompt de index.js a lib/runtime.js', status: 'in_progress' },
        { id: 'pending-one', content: 'Something pending', status: 'pending' },
    ]));
    ok('...and the body keeps its own horizontal rules', c.body === '\n# Body\n\n---\na rule above, and todos: nothing here\n');

    const folded = ['---', 'name: Folded', 'overview: >-', '  This overview is', '  folded over lines.', 'todos:', '  - id: a', '    content: >-', '      First line', '      second line', '    status: pending', '  - id: b', '    content: |', '      literal one', '      literal two', '    status: in_progress', 'isProject: false', '---', 'body', ''].join('\n');
    const f = plans.parsePlan(folded);
    ok('block scalars: folded joins with spaces, literal keeps lines, and the next key still parses', f.overview === 'This overview is folded over lines.' && f.todos[0].content === 'First line second line' && f.todos[0].status === 'pending' && f.todos[1].content === 'literal one\nliteral two' && f.todos[1].status === 'in_progress' && f.body === 'body\n');
    const flat = ['---', 'name: Flat', 'todos:', '- id: a', '  content: do a', '  status: pending', '- id: b', '  content: do b', '  status: completed', 'isProject: false', '---', 'body'].join('\n');
    ok('a list that is not indented', same(plans.parsePlan(flat).todos, [{ id: 'a', content: 'do a', status: 'pending' }, { id: 'b', content: 'do b', status: 'completed' }]));
    const shuffled = ['---', 'name: Shuffled', 'todos:', '  - content: Do it', '    status: completed', '    id: x', '  # a comment between items', '  - id: y', '    content: "Do \\"y\\""', '---', ''].join('\n');
    ok('fields in any order, a comment between items, a todo with no status is pending', same(plans.parsePlan(shuffled).todos, [{ id: 'x', content: 'Do it', status: 'completed' }, { id: 'y', content: 'Do "y"', status: 'pending' }]));
    ok('single-quoted values, with the doubled quote', plans.parsePlan("---\nname: 'It''s ok'\ntodos: []\n---\n").name === "It's ok");
    ok('a double-quoted value that is not valid JSON (a YAML escape) keeps its text, without the quotes', plans.parsePlan('---\nname: "a\\qb"\ntodos: []\n---\n').name === 'a\\qb' && plans.parsePlan('---\nname: "unterminated\ntodos: []\n---\n').name === 'unterminated');
    const blank = ['---', 'name: Blank', 'todos:', '  - id: a', '    content: |', '      one', '      two', '', '    status: completed', 'isProject: false', '---', 'body', ''].join('\n');
    ok('a block scalar loses the blank lines after it', same(plans.parsePlan(blank).todos, [{ id: 'a', content: 'one\ntwo', status: 'completed' }]));
    const commented = ['---', 'name: Cm', 'overview: >- # why this exists', '  Folded over', '  two lines.', 'todos: []', '---', ''].join('\n');
    ok('a comment after a block scalar marker is allowed', plans.parsePlan(commented).overview === 'Folded over two lines.');
    const comment = ['---', 'name: C', 'todos:', '  - id: a', '    content: A', '# a comment at column zero', '  - id: b', '    content: B', '---', ''].join('\n');
    ok('a comment at column zero does not end the list', same(plans.parsePlan(comment).todos.map((t) => t.id), ['a', 'b']));
    const spaced = ['---', 'name: W', 'todos:', '  -   content: |', '        body line', '      status: completed', '      id: a', '---', ''].join('\n');
    ok('a dash followed by several spaces puts the key further right, and a block scalar ends there', same(plans.parsePlan(spaced).todos, [{ id: 'a', content: 'body line', status: 'completed' }]));
    ok('trailing spaces after the opening and the closing "---" are fine', plans.parsePlan('--- \nname: x\ntodos: []\n---  \nbody\n').name === 'x' && plans.parsePlan('--- \nname: x\ntodos: []\n---  \nbody\n').body === 'body\n');
    ok('an unknown status in the file reads as pending', plans.parsePlan('---\nname: x\ntodos:\n  - id: a\n    content: c\n    status: done\n---\n').todos[0].status === 'pending');
    ok('"todos: []" and an absent list are no todos', plans.parsePlan('---\nname: x\ntodos: []\n---\n').todos.length === 0 && plans.parsePlan('---\nname: x\n---\n').todos.length === 0);
    ok('no frontmatter is no plan', plans.parsePlan('# just markdown\n') === null && plans.parsePlan('') === null && plans.parsePlan('---\nname: unclosed\n') === null);
    const crlf = plans.parsePlan(text.replace(/\n/g, '\r\n'));
    ok('CRLF line endings and a byte order mark do not matter', same(crlf.todos, parsedPlan.todos) && crlf.name === PLAN_ARGS.title && plans.parsePlan(`\uFEFF${text}`).name === PLAN_ARGS.title);
}

// =============================================================================
// [C] moving a todo along
// =============================================================================
console.log('\n[C] setTodoStatus');
{
    const base = plans.renderPlan({ ...PLAN_ARGS, markdown: PLAN_ARGS.markdown + '\n```yaml\ntodos:\n  - id: "route"\n    status: pending\n```\n', todos: withStatus(PLAN_ARGS.todos) });
    const lineDiffs = (a, b, eol = '\n') => { const x = a.split(eol), y = b.split(eol); return x.length === y.length ? x.map((l, i) => (l === y[i] ? -1 : i)).filter((i) => i >= 0) : null; };

    const r = plans.setTodoStatus(base, 'route', 'in_progress');
    ok('the status of one todo changes', r.todos[0].status === 'in_progress' && r.todos[1].status === 'pending' && plans.parsePlan(r.text).todos[0].status === 'in_progress');
    const diffs = lineDiffs(base, r.text);
    ok('...and nothing else in the file does (one line differs)', diffs && diffs.length === 1 && r.text.split('\n')[diffs[0]] === '    status: in_progress');
    ok('...not even the same words in the plan body', r.text.endsWith('```yaml\ntodos:\n  - id: "route"\n    status: pending\n```\n') && plans.parsePlan(r.text).body === plans.parsePlan(base).body);
    const done = plans.setTodoStatus(r.text, 'route', 'completed');
    const second = plans.setTodoStatus(done.text, 'test', 'in_progress');
    ok('todos move independently, in any direction', done.todos[0].status === 'completed' && second.todos.map((t) => t.status).join() === 'completed,in_progress' && plans.setTodoStatus(second.text, 'route', 'pending').todos[0].status === 'pending');
    ok('the same status again changes nothing', plans.setTodoStatus(base, 'route', 'pending').text === base);
    ok('the returned list has ids, content and status', same(r.todos, [{ id: 'route', content: 'Add the route to server.js', status: 'in_progress' }, { id: 'test', content: 'Cover it with a test', status: 'pending' }]));

    const ids = '---\nname: x\ntodos:\n  - id: a\n    content: A\n    status: pending\n  - id: ab\n    content: AB\n    status: pending\n---\n';
    ok('an id matches whole, not as a prefix', same(plans.setTodoStatus(ids, 'a', 'completed').todos.map((t) => t.status), ['completed', 'pending']) && same(plans.setTodoStatus(ids, 'ab', 'completed').todos.map((t) => t.status), ['pending', 'completed']));
    ok('an unknown id names the ones there are', /todo 'zzz' not found in the plan\. Todos: a, ab/.test(throws(() => plans.setTodoStatus(ids, 'zzz', 'completed'))));
    ok('a plan with no todos says "(none)"', /Todos: \(none\)/.test(throws(() => plans.setTodoStatus('---\nname: x\ntodos: []\n---\n', 'a', 'completed'))));
    ok('an unknown status is refused', /status must be one of: pending, in_progress, completed/.test(throws(() => plans.setTodoStatus(ids, 'a', 'done'))));
    ok('a file with no frontmatter is not a plan', /not a plan file/.test(throws(() => plans.setTodoStatus('# hello\n', 'a', 'completed'))));

    const crlfText = base.replace(/\n/g, '\r\n');
    const crlf = plans.setTodoStatus(crlfText, 'test', 'completed');
    const crlfDiffs = lineDiffs(crlfText, crlf.text, '\r\n');
    ok('CRLF files keep their line endings, one line changes', crlfDiffs && crlfDiffs.length === 1 && !/[^\r]\n/.test(crlf.text) && crlf.text.split('\r\n')[crlfDiffs[0]] === '    status: completed');
    ok('a byte order mark is kept', plans.setTodoStatus(`\uFEFF${base}`, 'route', 'completed').text.startsWith('\uFEFF---\n'));

    const quoted = '---\nname: x\ntodos:\n  - id: "a"\n    content: "A"\n    status: "pending"\n---\n';
    ok('a quoted status is replaced', plans.setTodoStatus(quoted, 'a', 'completed').text.includes('    status: completed\n') && !plans.setTodoStatus(quoted, 'a', 'completed').text.includes('"pending"'));
    const first = '---\nname: x\ntodos:\n  - status: pending\n    id: a\n    content: A\n---\n';
    ok('a status on the line of the dash is replaced in place', plans.setTodoStatus(first, 'a', 'completed').text.includes('  - status: completed\n    id: a\n'));
    const missing = '---\nname: x\ntodos:\n  - id: a\n    content: A\n  - id: b\n    content: B\n    status: pending\nisProject: false\n---\nbody\n';
    ok('a todo with no status line gets one after its last line, indented like its fields', plans.setTodoStatus(missing, 'a', 'in_progress').text === '---\nname: x\ntodos:\n  - id: a\n    content: A\n    status: in_progress\n  - id: b\n    content: B\n    status: pending\nisProject: false\n---\nbody\n');
    ok('...also the last one, before the next key', plans.setTodoStatus('---\nname: x\ntodos:\n  - id: a\n    content: A\nisProject: false\n---\n', 'a', 'completed').text === '---\nname: x\ntodos:\n  - id: a\n    content: A\n    status: completed\nisProject: false\n---\n');
    ok('...with the line ending of the file', plans.setTodoStatus('---\r\nname: x\r\ntodos:\r\n  - id: a\r\n    content: A\r\n---\r\n', 'a', 'completed').text === '---\r\nname: x\r\ntodos:\r\n  - id: a\r\n    content: A\r\n    status: completed\r\n---\r\n');
    const tail = '---\nname: x\ntodos:\n  - id: a\n    content: >-\n      long\n      text\nisProject: false\n---\n';
    ok('a todo whose last key is a block scalar gets its status after the block, not inside it', plans.setTodoStatus(tail, 'a', 'completed').text === '---\nname: x\ntodos:\n  - id: a\n    content: >-\n      long\n      text\n    status: completed\nisProject: false\n---\n');
    const flatMissing = '---\nname: x\ntodos:\n- id: a\n  content: A\n- id: b\n  content: B\n---\n';
    ok('a status that is added follows the indentation of the item, in the middle of the list and at its end', plans.setTodoStatus(flatMissing, 'a', 'completed').text === '---\nname: x\ntodos:\n- id: a\n  content: A\n  status: completed\n- id: b\n  content: B\n---\n' && plans.setTodoStatus(flatMissing, 'b', 'completed').text === '---\nname: x\ntodos:\n- id: a\n  content: A\n- id: b\n  content: B\n  status: completed\n---\n');
    const wide = '---\nname: x\ntodos:\n-   id: a\n    content: A\n    status: pending\n---\n';
    ok('a dash followed by several spaces', plans.setTodoStatus(wide, 'a', 'completed').text.includes('    status: completed\n'));
    const block = '---\nname: x\ntodos:\n  - id: a\n    content: >-\n      long text\n      status: pending\n    status: pending\n---\n';
    ok('a block scalar that mentions a status is not mistaken for one', plans.setTodoStatus(block, 'a', 'completed').text === block.replace(/    status: pending\n---/, '    status: completed\n---'));
}

// =============================================================================
// [D] plan files on disk
// =============================================================================
console.log('\n[D] plans on disk');
{
    const dir = tempDir('plans');
    const outside = tempDir('outside');
    const put = (rel, content, mtime) => {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        if (mtime) fs.utimesSync(file, mtime, mtime);
        return file;
    };
    ok('no plans directory: nothing listed, no latest plan', same(plans.listPlans(dir), []) && plans.latestPlan(dir) === null);

    const first = plans.uniquePlanPath(dir, 'Add a /health endpoint');
    ok('the first plan of a name', first.rel === PLAN_PATH && first.abs === path.join(dir, PLAN_PATH));
    put(PLAN_PATH, plans.renderPlan({ title: 'Add a /health endpoint', overview: 'Probe it.', markdown: 'b', todos: [{ id: 'a', content: 'A', status: 'completed' }, { id: 'b', content: 'B', status: 'pending' }] }), new Date('2021-01-01'));
    ok('the next plan of the same name gets -2, then -3', plans.uniquePlanPath(dir, 'Add a /health endpoint').rel === '.aicode/plans/add-a-health-endpoint-2.plan.md' && (put('.aicode/plans/add-a-health-endpoint-2.plan.md', 'x'), plans.uniquePlanPath(dir, 'Add a /health endpoint').rel === '.aicode/plans/add-a-health-endpoint-3.plan.md'));
    fs.unlinkSync(path.join(dir, '.aicode/plans/add-a-health-endpoint-2.plan.md'));

    put('.aicode/plans/zeta.plan.md', plans.renderPlan({ title: 'Zeta refactor', overview: 'Rename things in the ENGINE.', markdown: 'b', todos: [] }), new Date('2022-06-01'));
    put('.aicode/plans/alpha.plan.md', plans.renderPlan({ title: 'Alpha cleanup', overview: 'Nothing.', markdown: 'b', todos: [{ id: 'x', content: 'X', status: 'in_progress' }] }), new Date('2020-01-01'));
    put('.aicode/plans/no-frontmatter.plan.md', '# Just a heading\n', new Date('2019-01-01'));
    put('.aicode/plans/notes.md', '# not a plan\n', new Date('2023-01-01'));
    fs.mkdirSync(path.join(dir, '.aicode/plans/folder.plan.md'));
    const list = plans.listPlans(dir);
    ok('plans are listed newest first, and only the .plan.md files', list.map((p) => p.path).join() === '.aicode/plans/zeta.plan.md,.aicode/plans/add-a-health-endpoint.plan.md,.aicode/plans/alpha.plan.md,.aicode/plans/no-frontmatter.plan.md');
    ok('each carries its title, overview, todos and modification time', list[0].title === 'Zeta refactor' && list[0].overview === 'Rename things in the ENGINE.' && same(list[0].todos, []) && list[1].todos.length === 2 && list[1].todos[0].status === 'completed' && list[0].updatedAt === '2022-06-01T00:00:00.000Z');
    ok('...and nothing more', same(Object.keys(list[0]).sort(), ['overview', 'path', 'title', 'todos', 'updatedAt']));
    ok('a plan with no frontmatter is listed under its file name', list[3].title === 'no-frontmatter' && list[3].overview === '' && same(list[3].todos, []));
    ok('the latest plan is the most recently modified one', plans.latestPlan(dir) === '.aicode/plans/zeta.plan.md');
    ok('a query keeps the plans that have every word (title, overview or path, any case)', same(plans.listPlans(dir, { query: 'ALPHA' }).map((p) => p.title), ['Alpha cleanup']) && same(plans.listPlans(dir, { query: 'engine rename' }).map((p) => p.title), ['Zeta refactor']) && same(plans.listPlans(dir, { query: 'health endpoint' }).length, 1) && plans.listPlans(dir, { query: 'alpha zeta' }).length === 0);
    ok('a blank query lists everything, a limit caps the list', plans.listPlans(dir, { query: '  ' }).length === 4 && plans.listPlans(dir, { limit: 2 }).length === 2);
    put('.aicode/plans/huge.plan.md', `---\nname: Huge\ntodos: []\n---\n${'x'.repeat(plans.MAX_PLAN_BYTES * 2)}`, new Date('2018-01-01'));
    ok('a huge plan is still listed (only its start is read)', plans.listPlans(dir).some((p) => p.title === 'Huge'));

    // equal modification times are listed by path; a query also looks at the path
    const tie = new Date('2017-05-05');
    put('.aicode/plans/tie-b.plan.md', 'x', tie);
    put('.aicode/plans/tie-a.plan.md', 'x', tie);
    ok('plans modified at the same time are listed by path', plans.listPlans(dir).map((p) => p.path).filter((p) => /tie-/.test(p)).join() === '.aicode/plans/tie-a.plan.md,.aicode/plans/tie-b.plan.md');
    put('.aicode/plans/quarterly-report.plan.md', plans.renderPlan({ title: 'Q3', overview: 'Numbers.', markdown: 'b', todos: [] }), new Date('2016-01-01'));
    ok('a query matches the path when neither title nor overview has the word', same(plans.listPlans(dir, { query: 'quarterly' }).map((p) => p.title), ['Q3']) && same(plans.listPlans(dir, { query: 'numbers' }).map((p) => p.title), ['Q3']) && same(plans.listPlans(dir, { query: 'Q3' }).map((p) => p.title), ['Q3']));
    fs.unlinkSync(path.join(dir, '.aicode/plans/tie-a.plan.md'));
    fs.unlinkSync(path.join(dir, '.aicode/plans/tie-b.plan.md'));
    fs.unlinkSync(path.join(dir, '.aicode/plans/quarterly-report.plan.md'));

    // a named pipe called x.plan.md must not hang the listing (opening it to read would block)
    if (process.platform !== 'win32') {
        const fifo = path.join(dir, '.aicode/plans/pipe.plan.md');
        if (spawnSync('mkfifo', [fifo]).status === 0) {
            const probe = spawnSync(process.execPath, ['-e', `const p = require(${JSON.stringify(path.join(ROOT, 'lib/plans.js'))}); console.log(p.listPlans(${JSON.stringify(dir)}).map((x) => x.path).includes('.aicode/plans/pipe.plan.md'))`], { encoding: 'utf8', timeout: 10000 });
            ok('a named pipe called x.plan.md is neither listed nor waited on', probe.status === 0 && probe.stdout.trim() === 'false');
            fs.unlinkSync(fifo);
        }
    }

    // the list is capped at 50, newest first
    const many = tempDir('many');
    fs.mkdirSync(path.join(many, '.aicode/plans'), { recursive: true });
    for (let i = 0; i < 53; i++) {
        const file = path.join(many, '.aicode/plans', `p${String(i).padStart(2, '0')}.plan.md`);
        fs.writeFileSync(file, plans.renderPlan({ title: `Plan ${i}`, markdown: 'b', todos: [] }));
        const when = new Date(Date.UTC(2020, 0, 1) + i * 1000);
        fs.utimesSync(file, when, when);
    }
    const capped = plans.listPlans(many);
    ok('at most 50 plans are listed, the newest ones', capped.length === 50 && capped[0].title === 'Plan 52' && capped[49].title === 'Plan 3' && plans.listPlans(many, { limit: 53 }).length === 53 && plans.listPlans(many, { limit: 3 }).map((p) => p.title).join() === 'Plan 52,Plan 51,Plan 50');
    fs.rmSync(many, { recursive: true, force: true });

    // reading a plan to implement it
    const read = plans.readPlanFile(dir, PLAN_PATH);
    ok('readPlanFile returns the path as shown and the text', read.rel === PLAN_PATH && read.abs === path.join(dir, PLAN_PATH) && read.text.startsWith('---\nname: "Add a /health endpoint"'));
    ok('...an absolute path inside the project is shown relative', plans.readPlanFile(dir, path.join(dir, PLAN_PATH)).rel === PLAN_PATH);
    const elsewhere = path.join(outside, 'x.plan.md');
    fs.writeFileSync(elsewhere, '---\nname: x\n---\nbody\n');
    ok('...a file outside the project is read as it is (the CLI user named it) and shown absolute', plans.readPlanFile(dir, elsewhere).rel === elsewhere);
    ok('...but not when a client named it (insideProject)', /must be inside the project/.test(throws(() => plans.readPlanFile(dir, elsewhere, { insideProject: true }))) && /must be inside the project/.test(throws(() => plans.readPlanFile(dir, '../' + path.basename(outside) + '/x.plan.md', { insideProject: true }))));
    fs.symlinkSync(elsewhere, path.join(dir, '.aicode/plans/link.plan.md'));
    fs.symlinkSync(path.join(dir, PLAN_PATH), path.join(dir, 'inside-link.plan.md'));
    ok('...a link that leaves the project is outside, one that stays inside is fine', /must be inside the project/.test(throws(() => plans.readPlanFile(dir, '.aicode/plans/link.plan.md', { insideProject: true }))) && plans.readPlanFile(dir, 'inside-link.plan.md', { insideProject: true }).text.includes('Add a /health endpoint'));
    ok('a missing file', throws(() => plans.readPlanFile(dir, 'nope.plan.md')) === 'plan not found: nope.plan.md');
    ok('a directory is not a plan', throws(() => plans.readPlanFile(dir, '.aicode/plans')) === 'not a file: .aicode/plans');
    ok('an empty path asks for one', /give the path of a plan file/.test(throws(() => plans.readPlanFile(dir, ''))) && /give the path/.test(throws(() => plans.readPlanFile(dir, '   '))) && /give the path/.test(throws(() => plans.readPlanFile(dir, undefined))));
    ok('a plan bigger than the limit is refused with its size', /too large to implement \(\d+ KB, the limit is 100 KB\)/.test(throws(() => plans.readPlanFile(dir, '.aicode/plans/huge.plan.md'))));
    put('exact.plan.md', 'x'.repeat(plans.MAX_PLAN_BYTES));
    put('over.plan.md', 'x'.repeat(plans.MAX_PLAN_BYTES + 1));
    ok('a plan of exactly the limit is accepted, one byte more is refused with its size rounded up', plans.readPlanFile(dir, 'exact.plan.md').text.length === plans.MAX_PLAN_BYTES && throws(() => plans.readPlanFile(dir, 'over.plan.md')) === 'the plan is too large to implement (101 KB, the limit is 100 KB): over.plan.md');

    // the input of an implement turn
    ok('implementText is the documented sentence, a blank line, then the file', plans.implementText(PLAN_PATH, 'FILE\n') === `Implement the plan at ${PLAN_PATH}. Work through its todos in order: call plan_todo to mark a todo in_progress when you start it and completed once it is done and verified. The plan follows.\n\nFILE\n`);
    ok('...extra instructions follow the plan', plans.implementText('p', 'FILE\n\n', 'also add docs') === `${plans.implementText('p', 'X').replace(/X$/, '')}FILE\n\nAdditional instructions: also add docs`);
    ok('...a blank extra is nothing', plans.implementText('p', 'FILE\n', '   ') === plans.implementText('p', 'FILE\n') && plans.implementText('p', 'FILE\n', '') === plans.implementText('p', 'FILE\n') && plans.implementText('p', 'FILE\n', undefined) === plans.implementText('p', 'FILE\n'));

    // plan_todo may only touch plan files under .aicode/plans
    const editable = (p) => throws(() => plans.editablePlanFile(dir, p));
    ok('plan_todo reaches a plan under .aicode/plans, relative or absolute', plans.editablePlanFile(dir, PLAN_PATH) === path.join(dir, PLAN_PATH) && plans.editablePlanFile(dir, path.join(dir, PLAN_PATH)) === path.join(dir, PLAN_PATH));
    ok('...also in a subdirectory of it', (put('.aicode/plans/sub/deep.plan.md', 'x'), plans.editablePlanFile(dir, '.aicode/plans/sub/deep.plan.md').endsWith('deep.plan.md')));
    ok('...a file whose name starts with two dots is not "outside"', (put('.aicode/plans/..odd.plan.md', 'x'), plans.editablePlanFile(dir, '.aicode/plans/..odd.plan.md').endsWith('..odd.plan.md')));
    put('package.json', '{}');
    put('.aicode/memory.md', 'x');
    put('.aicode/plans/wrong-suffix.md', 'x');
    put('outside.plan.md', 'x');
    const refusal = /plan_todo only edits plan files under \.aicode\/plans\//;
    ok('...but no other file', refusal.test(editable('package.json')) && refusal.test(editable('.aicode/memory.md')) && refusal.test(editable('.aicode/plans/wrong-suffix.md')) && refusal.test(editable('outside.plan.md')) && refusal.test(editable('../outside.plan.md')) && refusal.test(editable('.aicode/plans/../../package.json')) && refusal.test(editable(elsewhere)) && refusal.test(editable('')) && refusal.test(editable(undefined)));
    ok('...nor one that is a link out of the directory', refusal.test(editable('.aicode/plans/link.plan.md')));
    ok('a plan that is not there', /plan not found: \.aicode\/plans\/missing\.plan\.md/.test(editable('.aicode/plans/missing.plan.md')));

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
}

// =============================================================================
// shared fixtures for the agent tests: a real engine with the loop stubbed out
// =============================================================================
const defs = await agents.loadAgents();
const engineFor = () => new Code2Prompt({ template: path.join(ROOT, 'actions', 'default.md'), OPENAI_KEY: 'test' });
function makeCtx(dir, { writeResult = true, orvix = null } = {}) {
    const calls = { write: [], edit: [], bash: [], ask: [] };
    const ctx = {
        userDirectory: dir, language: 'English', personality: 'friendly-and-concise',
        readFile: async (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
        // like the runtime's helper: it does not create directories
        writeFile: async (f, content) => { calls.write.push(f); if (!writeResult) return false; fs.writeFileSync(path.join(dir, f), content); return true; },
        editFile: async (f) => { calls.edit.push(f); return { ok: true, applied: 1 }; },
        executeBash: async (c) => { calls.bash.push(c); return { output: 'ok' }; },
        ask: async (q) => { calls.ask.push(q); return 'yes'; },
        ...(orvix ? { orvix } : {}),
    };
    return { ctx, calls };
}
function makeStubUI() {
    const statuses = [];
    const plansCreated = [];
    return {
        statuses, plansCreated,
        step: () => ({ done() { }, fail() { }, update() { } }),
        streamChunk() { }, streamEnd() { }, statusStop() { }, isStreaming: () => false,
        status: (t) => statuses.push(t),
        planCreated: (p) => plansCreated.push(p),
    };
}
const FAKE_ORVIX = { enabled: true, mapBudget: 2000 };
const toolsOf = (dir, mode, agentName = 'main', extra = {}) => {
    const { ctx } = makeCtx(dir, extra);
    return agents.buildTools({ engine: engineFor(), ctx, ui: makeStubUI(), agents: defs, depth: 0, cwd: dir, mode }, defs[agentName].tools);
};

// =============================================================================
// [E] the toolset of each mode
// =============================================================================
console.log('\n[E] toolsets');
{
    const AGENT_TOOLS = ['ask_user', 'delegate', 'edit_file', 'list_files', 'list_skills', 'plan_todo', 'read_file', 'read_rule', 'remember', 'run_bash', 'search', 'use_skill', 'write_file', 'write_plan'];
    const ASK_TOOLS = ['ask_user', 'delegate', 'list_files', 'list_skills', 'read_file', 'read_rule', 'search', 'use_skill'];
    ok('agent mode: every tool of the orchestrator', same(sortedNames(toolsOf(PROJECT, 'agent')), AGENT_TOOLS));
    ok('ask mode: read-only tools, no write_file, edit_file, run_bash, remember, write_plan or plan_todo', same(sortedNames(toolsOf(PROJECT, 'ask')), ASK_TOOLS));
    ok('plan mode: the same plus write_plan, still no writes and no plan_todo', same(sortedNames(toolsOf(PROJECT, 'plan')), [...ASK_TOOLS, 'write_plan'].sort()));
    ok('auto (and anything that is not a mode) runs as agent', same(sortedNames(toolsOf(PROJECT, 'auto')), AGENT_TOOLS) && same(sortedNames(toolsOf(PROJECT, undefined)), AGENT_TOOLS) && same(sortedNames(toolsOf(PROJECT, 'bogus')), AGENT_TOOLS));
    const NAV = ['calls', 'code_map', 'find_symbol', 'show_symbol', 'who_calls'];
    ok('the code-index tools are read-only: present in every mode when the index is active', ['ask', 'plan', 'agent'].every((m) => NAV.every((n) => n in toolsOf(PROJECT, m, 'main', { orvix: FAKE_ORVIX }))));
    ok('...and absent in every mode without it', ['ask', 'plan', 'agent'].every((m) => NAV.every((n) => !(n in toolsOf(PROJECT, m)))));

    // sub-agents run in their parent's mode
    ok('an explorer reads the same in every mode', ['ask', 'plan', 'agent'].every((m) => same(sortedNames(toolsOf(PROJECT, m, 'explorer')), ['list_files', 'read_file', 'read_rule', 'search'])));
    ok('a coder in agent mode writes, edits and runs commands', same(sortedNames(toolsOf(PROJECT, 'agent', 'coder')), ['edit_file', 'list_files', 'read_file', 'run_bash', 'search', 'write_file']));
    ok('...in ask and plan mode it can only read', same(sortedNames(toolsOf(PROJECT, 'ask', 'coder')), ['list_files', 'read_file', 'search']) && same(sortedNames(toolsOf(PROJECT, 'plan', 'coder')), ['list_files', 'read_file', 'search']));
    ok('a reviewer has run_bash in agent mode and not in ask or plan mode', 'run_bash' in toolsOf(PROJECT, 'agent', 'reviewer') && !('run_bash' in toolsOf(PROJECT, 'ask', 'reviewer')) && !('run_bash' in toolsOf(PROJECT, 'plan', 'reviewer')));
    const build = (mode, allowed) => agents.buildTools({ engine: engineFor(), ctx: makeCtx(PROJECT).ctx, ui: makeStubUI(), agents: defs, depth: 0, cwd: PROJECT, mode }, allowed);
    ok('an agent with no tools block gets the read-only defaults, in every mode', ['ask', 'plan', 'agent'].every((m) => same(Object.keys(build(m, null)), ['list_files', 'read_file', 'search', 'read_rule', 'list_skills'])));
    ok('a whitelist naming a forbidden tool does not get it', same(Object.keys(build('ask', ['read_file', 'write_file', 'run_bash'])), ['read_file']) && same(Object.keys(build('plan', ['read_file', 'write_file', 'write_plan', 'plan_todo'])), ['read_file', 'write_plan']));
    ok('...and a tool the whitelist leaves out does not appear in agent mode', same(Object.keys(build('agent', ['read_file'])), ['read_file']));
}

// =============================================================================
// [F] write_plan and plan_todo
// =============================================================================
console.log('\n[F] write_plan and plan_todo');
{
    const dir = tempDir('tools');
    const make = (opts = {}, uiOverride = null, mode = 'plan') => {
        const { ctx, calls } = makeCtx(dir, opts);
        const ui = uiOverride || makeStubUI();
        const tools = agents.buildTools({ engine: engineFor(), ctx, ui, agents: defs, depth: 0, cwd: dir, mode: opts.mode || mode }, defs.main.tools);
        return { tools, calls, ui };
    };
    const run = (tool, input) => tool.execute(input, { toolCallId: 'x', messages: [] });

    const { tools, calls, ui } = make();
    const result = await run(tools.write_plan, PLAN_ARGS);
    ok('write_plan answers with the path of the file it wrote', same(result, { path: PLAN_PATH }));
    const written = fs.readFileSync(path.join(dir, PLAN_PATH), 'utf8');
    ok('...which has the documented frontmatter and the plan as its body', written === plans.renderPlan({ ...PLAN_ARGS, todos: withStatus(PLAN_ARGS.todos) }) && written.startsWith('---\nname: "Add a /health endpoint"\noverview: "Expose GET /health so a probe can tell the server is up."\ntodos:\n  - id: "route"'));
    ok('...written through the confirm-gated writeFile, with a path relative to the project', same(calls.write, [PLAN_PATH]));
    ok('...and shown: the UI is told the path, title, overview and todos', same(ui.plansCreated, [{ path: PLAN_PATH, title: PLAN_ARGS.title, overview: PLAN_ARGS.overview, todos: [{ id: 'route', content: 'Add the route to server.js', status: 'pending' }, { id: 'test', content: 'Cover it with a test', status: 'pending' }] }]));
    ok('the same title again is a second file, -2', same(await run(tools.write_plan, PLAN_ARGS), { path: '.aicode/plans/add-a-health-endpoint-2.plan.md' }) && same(await run(tools.write_plan, PLAN_ARGS), { path: '.aicode/plans/add-a-health-endpoint-3.plan.md' }) && fs.existsSync(path.join(dir, PLAN_PATH)));
    ok('white space in the title, overview and todos is collapsed to single spaces', same(await run(tools.write_plan, { title: '  Tidy\n  up\t ', overview: 'two\n\nlines', markdown: 'm', todos: [{ id: ' a ', content: 'do\n  it' }] }), { path: '.aicode/plans/tidy-up.plan.md' }) && same(plans.parsePlan(fs.readFileSync(path.join(dir, '.aicode/plans/tidy-up.plan.md'), 'utf8')), { name: 'Tidy up', overview: 'two lines', todos: [{ id: 'a', content: 'do it', status: 'pending' }], body: 'm\n' }));
    ok('a plan with no todos is fine', same(await run(tools.write_plan, { title: 'Bare', overview: 'o', markdown: 'm', todos: [] }), { path: '.aicode/plans/bare.plan.md' }));
    ok('write_plan takes the four documented inputs', same(Object.keys(tools.write_plan.inputSchema.shape).sort(), ['markdown', 'overview', 'title', 'todos']) && tools.write_plan.inputSchema.safeParse(PLAN_ARGS).success && !tools.write_plan.inputSchema.safeParse({ title: 'x' }).success);

    const before = fs.readdirSync(path.join(dir, '.aicode/plans')).length;
    const wrote = calls.write.length;
    ok('a plan with no title is refused', (await run(tools.write_plan, { ...PLAN_ARGS, title: '  ' })).error === 'the plan needs a title');
    ok('a todo with no id or no content is refused', (await run(tools.write_plan, { ...PLAN_ARGS, todos: [{ id: '', content: 'x' }] })).error === 'every todo needs an id and a content' && (await run(tools.write_plan, { ...PLAN_ARGS, todos: [{ id: 'a', content: '  ' }] })).error === 'every todo needs an id and a content');
    ok('two todos with the same id are refused', /duplicate todo id 'a'/.test((await run(tools.write_plan, { ...PLAN_ARGS, todos: [{ id: 'a', content: 'x' }, { id: 'a', content: 'y' }] })).error));
    const tooLong = await run(tools.write_plan, { ...PLAN_ARGS, markdown: 'x'.repeat(plans.MAX_PLAN_BYTES) });
    ok('a plan longer than the implement flow can read is refused with its size', /the plan is too long \(\d+ KB, the limit is 100 KB\)/.test(tooLong.error));
    ok('...and nothing is written for any of them', fs.readdirSync(path.join(dir, '.aicode/plans')).length === before && calls.write.length === wrote);

    const declined = make({ writeResult: false });
    ok('a write the user declines is an error, and the UI is not told of a plan', (await run(declined.tools.write_plan, PLAN_ARGS)).error === 'write cancelled or failed' && declined.ui.plansCreated.length === 0);
    const noPlanUI = make({}, { step: () => ({ done() { } }), status() { }, statusStop() { }, streamEnd() { }, isStreaming: () => false });
    ok('a UI without planCreated (the terminal one) is fine', same(await run(noPlanUI.tools.write_plan, { ...PLAN_ARGS, title: 'No card' }), { path: '.aicode/plans/no-card.plan.md' }));
    const throwingUI = make({}, { ...makeStubUI(), planCreated: () => { throw new Error('boom'); } });
    ok('...and one whose planCreated throws does not lose the plan', same(await run(throwingUI.tools.write_plan, { ...PLAN_ARGS, title: 'Throwing card' }), { path: '.aicode/plans/throwing-card.plan.md' }) && fs.existsSync(path.join(dir, '.aicode/plans/throwing-card.plan.md')));

    // plan_todo, in agent mode
    const agent = make({}, null, 'agent');
    const wroteBefore = agent.calls.write.length;
    const moved = await run(agent.tools.plan_todo, { path: PLAN_PATH, id: 'route', status: 'in_progress' });
    ok('plan_todo answers with the path and the updated todo list', moved.path === PLAN_PATH && same(moved.todos.map((t) => [t.id, t.status]), [['route', 'in_progress'], ['test', 'pending']]));
    ok('...and the file on disk has the new status, nothing else changed', fs.readFileSync(path.join(dir, PLAN_PATH), 'utf8') === written.replace('    status: pending', '    status: in_progress'));
    ok('...it is not confirm-gated: it never goes through writeFile', agent.calls.write.length === wroteBefore);
    const finished = await run(agent.tools.plan_todo, { path: PLAN_PATH, id: 'route', status: 'completed' });
    ok('a todo is completed with the next call', finished.todos[0].status === 'completed' && plans.parsePlan(fs.readFileSync(path.join(dir, PLAN_PATH), 'utf8')).todos[0].status === 'completed');
    ok('an unknown todo id says which ones there are', /todo 'nope' not found in the plan\. Todos: route, test/.test((await run(agent.tools.plan_todo, { path: PLAN_PATH, id: 'nope', status: 'completed' })).error));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    ok('plan_todo refuses any file that is not a plan under .aicode/plans', /only edits plan files/.test((await run(agent.tools.plan_todo, { path: 'package.json', id: 'route', status: 'completed' })).error) && /only edits plan files/.test((await run(agent.tools.plan_todo, { path: '../x.plan.md', id: 'route', status: 'completed' })).error) && fs.readFileSync(path.join(dir, 'package.json'), 'utf8') === '{"name":"x"}');
    ok('a plan that does not exist is reported', /plan not found/.test((await run(agent.tools.plan_todo, { path: '.aicode/plans/gone.plan.md', id: 'a', status: 'completed' })).error));
    ok('the status must be one of the three', agent.tools.plan_todo.inputSchema.safeParse({ path: 'p', id: 'a', status: 'in_progress' }).success && !agent.tools.plan_todo.inputSchema.safeParse({ path: 'p', id: 'a', status: 'done' }).success && !agent.tools.plan_todo.inputSchema.safeParse({ path: 'p', id: 'a' }).success);

    fs.rmSync(dir, { recursive: true, force: true });
}

// =============================================================================
// [G] delegation in the read-only modes
// =============================================================================
console.log('\n[G] delegate');
{
    const dir = tempDir('delegate');
    const runs = [];
    const delegateIn = (mode) => {
        const engine = engineFor();
        engine.runAgentLoop = async ({ system, tools, messages }) => { runs.push({ system, tools: Object.keys(tools).sort(), task: messages[messages.length - 1].content }); return { text: 'REPORT' }; };
        const { ctx } = makeCtx(dir);
        const tools = agents.buildTools({ engine, ctx, ui: makeStubUI(), agents: defs, depth: 0, cwd: dir, mode }, defs.main.tools);
        return tools.delegate;
    };
    const call = (delegate, agent, task = 'do it') => delegate.execute({ agent, task }, { toolCallId: 'x', messages: [] });

    for (const mode of ['ask', 'plan']) {
        const delegate = delegateIn(mode);
        runs.length = 0;
        const refused = await call(delegate, 'coder');
        ok(`${mode}: delegating to the coder is refused, naming the mode and the agents left`, /sub-agent 'coder' is not available in .* mode, which is read-only\. Available: explorer, reviewer/.test(refused.error) && refused.error.includes(`in ${mode} mode`) && runs.length === 0);
        ok(`${mode}: an unknown agent lists only the read-only ones`, (await call(delegate, 'wizard')).error === "unknown sub-agent 'wizard'. Available: explorer, reviewer" && (await call(delegate, 'main')).error === "unknown sub-agent 'main'. Available: explorer, reviewer");
        const explored = await call(delegate, 'explorer', 'where is X?');
        ok(`${mode}: the explorer runs, its report comes back`, same(explored, { agent: 'explorer', report: 'REPORT' }) && runs.length === 1 && runs[0].task === 'where is X?');
        const reviewed = await call(delegate, 'reviewer');
        ok(`${mode}: the reviewer runs without run_bash`, reviewed.report === 'REPORT' && !runs[1].tools.includes('run_bash') && same(runs[1].tools, ['list_files', 'read_file', 'search']));
        ok(`${mode}: a sub-agent is told the session is read-only, and does not get the orchestrator's instructions`, runs[0].system.includes(`# Mode: ${mode}\nThis session is read-only`) && !runs[0].system.includes('write_plan') && !runs[0].system.includes('Plan mode:'));
        ok(`${mode}: the tool describes the two agents it offers`, /explorer \(research\) and reviewer \(critique\)/.test(delegate.description) && !/coder/.test(delegate.description) && !/coder/.test(JSON.stringify(delegate.inputSchema.shape.agent.description)));
    }

    const open = delegateIn('agent');
    runs.length = 0;
    const coded = await call(open, 'coder', 'write it');
    ok('agent mode: the coder is available and writes', coded.report === 'REPORT' && runs[0].tools.includes('write_file') && runs[0].tools.includes('run_bash'));
    ok('...the reviewer keeps run_bash', (await call(open, 'reviewer')).report === 'REPORT' && runs[1].tools.includes('run_bash'));
    ok('...and a sub-agent gets no mode section', !runs[0].system.includes('# Mode:'));
    ok('...an unknown agent lists all of them but the orchestrator', (await call(open, 'wizard')).error === "unknown sub-agent 'wizard'. Available: coder, explorer, reviewer");
    ok('...the description offers all three', /coder \(implementation\)/.test(open.description) && /explorer \| coder \| reviewer/.test(open.inputSchema.shape.agent.description));

    // the depth cap is untouched
    const engine = engineFor();
    const { ctx } = makeCtx(dir);
    const deep = agents.buildTools({ engine, ctx, ui: makeStubUI(), agents: defs, depth: agents.MAX_DEPTH, cwd: dir, mode: 'ask' }, defs.main.tools).delegate;
    ok('delegation at the maximum depth is still refused first', /maximum delegation depth/.test((await call(deep, 'explorer')).error));
    fs.rmSync(dir, { recursive: true, force: true });
}

// =============================================================================
// [H] the system prompt of a loop
// =============================================================================
console.log('\n[H] mode prompts');
{
    const read = (name) => fs.readFileSync(path.join(ROOT, 'agents', 'modes', `${name}.md`), 'utf8');
    ok('the mode prompts are plain markdown, no fenced metadata', ['ask', 'plan', 'agent'].every((m) => read(m).trim().length > 100 && !read(m).includes('```')));
    ok('ask: read-only, cites path:line, suggests Agent mode for a change', /read-only/.test(read('ask')) && /path:line/.test(read('ask')) && /Agent mode/.test(read('ask')) && /never claim to have changed/.test(read('ask')));
    ok('plan: write_plan once, at most two questions, concrete files and functions, verification, small ordered todos', /write_plan/.test(read('plan')) && /at most two clarifying questions/.test(read('plan')) && /concrete files and functions/.test(read('plan')) && /verification steps/.test(read('plan')) && /small and ordered/.test(read('plan')) && /once/.test(read('plan')));
    ok('agent: verify the work, plan_todo, a summary at the end', /Verify your work/.test(read('agent')) && /plan_todo/.test(read('agent')) && /summary/.test(read('agent')));
    ok('the mode prompts are not agents', !('modes' in defs) && !('ask' in defs) && !('plan' in defs) && !defs.agent && same(Object.keys(defs).sort(), ['coder', 'explorer', 'main', 'reviewer']));

    async function systemFor(mode, { depth = 0, agentName = 'main', skill = null } = {}) {
        const engine = engineFor();
        let captured = null;
        engine.runAgentLoop = async (params) => { captured = { ...params, tools: Object.keys(params.tools).sort() }; return { text: 'ANSWER' }; };
        const ui = makeStubUI();
        const { ctx } = makeCtx(PROJECT);
        const args = { engine, agentName, agents: defs, task: 'do X', ctx, ui, depth, streamAnswer: true, skill };
        if (mode !== undefined) args.mode = mode;
        await agents.runAgent(args);
        return { ...captured, ui };
    }
    const count = (text, needle) => text.split(needle).length - 1;
    const ask = await systemFor('ask');
    ok('ask: the prompt carries "# Mode: ask" and the ask instructions, once', count(ask.system, '# Mode:') === 1 && ask.system.includes(`# Mode: ask\n${read('ask').trim()}`));
    ok('...after the navigation policy and the project memory, before the voice', ask.system.indexOf('CONVENTION_X') < ask.system.indexOf('# Code navigation') && ask.system.indexOf('# Code navigation') < ask.system.indexOf('# Mode: ask') && ask.system.indexOf('# Mode: ask') < ask.system.indexOf('# Voice / tone'));
    ok('...the instructions are trimmed: one blank line between them and the next section', ask.system.includes(`${read('ask').trim()}\n\n# Voice / tone`));
    ok('...and the loop is offered the read-only tools', same(ask.tools, ['ask_user', 'delegate', 'list_files', 'list_skills', 'read_file', 'read_rule', 'search', 'use_skill']));
    ok('...the status line names the mode', ask.ui.statuses[0] === 'ask · thinking …');
    const plan = await systemFor('plan');
    ok('plan: "# Mode: plan" with the plan instructions and write_plan offered', plan.system.includes(`# Mode: plan\n${read('plan').trim()}`) && plan.tools.includes('write_plan') && !plan.tools.includes('write_file') && plan.ui.statuses[0] === 'plan · thinking …');
    const agent = await systemFor('agent');
    ok('agent: "# Mode: agent" with the reminder, every tool offered', agent.system.includes(`# Mode: agent\n${read('agent').trim()}`) && agent.tools.length === 14 && agent.ui.statuses[0] === 'agent · thinking …');
    const dflt = await systemFor(undefined);
    ok('no mode given is agent mode', dflt.system.includes('# Mode: agent') && dflt.tools.length === 14);
    const auto = await systemFor('auto');
    ok('auto never reaches the loop as such: it runs as agent', auto.system.includes('# Mode: agent') && !auto.system.includes('# Mode: auto') && auto.tools.length === 14 && auto.ui.statuses[0] === 'agent · thinking …');
    ok('an unknown mode runs as agent too', (await systemFor('bogus')).system.includes('# Mode: agent'));
    const sub = await systemFor('ask', { depth: 1, agentName: 'explorer' });
    ok('a sub-agent of ask mode gets the one-line reminder only', sub.system.includes('# Mode: ask\nThis session is read-only: you cannot change files or run commands.') && !sub.system.includes(read('ask').trim()) && count(sub.system, '# Mode:') === 1);
    const subPlan = await systemFor('plan', { depth: 1, agentName: 'reviewer' });
    ok('...also in plan mode, and it has no run_bash', subPlan.system.includes('# Mode: plan\nThis session is read-only') && !subPlan.tools.includes('run_bash'));
    const subAgent = await systemFor('agent', { depth: 1, agentName: 'coder' });
    ok('a sub-agent of agent mode gets no mode section', !subAgent.system.includes('# Mode:') && subAgent.tools.includes('write_file'));
    const withSkill = await systemFor('ask', { skill: { name: 'demo-skill', dir: '/tmp/demo-skill', body: 'Step 1: do SKILL_STEP_ABC.', files: [] } });
    ok('a skill is followed in ask mode, and the mode section comes after it', withSkill.system.indexOf('SKILL_STEP_ABC') < withSkill.system.indexOf('# Mode: ask') && !withSkill.tools.includes('write_file'));
}

// =============================================================================
// [I] how a turn is routed by mode (the runtime, with a scripted model)
// =============================================================================
console.log('\n[I] routing by mode');
{
    const AGENT_COUNT = 14;
    async function turn({ flags = {}, analysis = {}, streams = null, input = 'say hello', opts = {}, project = PROJECT, keys = { OPENAI_KEY: 'k' } } = {}) {
        const mock = makeMock({ analysis, streams });
        MOCK = mock.model;
        const rt = createRuntime({ cwd: project, keysData: keys, flags: { ...flags } });
        const ui = makeUI();
        await rt.runPrompt(input, ui, opts);
        return { ui, mock, rt };
    }

    let r = await turn({ flags: { mode: 'ask' } });
    ok('ask forces the agent loop (needs_agent is false), after the router ran', r.mock.counts.router === 1 && r.mock.counts.stream === 1 && r.mock.counts.template === 0 && has(r.ui, 'status', (e) => e[1] === 'ask · thinking …'));
    ok('...with the read-only tools and the ask instructions', same(r.mock.tools[0], ['ask_user', 'delegate', 'list_files', 'list_skills', 'read_file', 'read_rule', 'search', 'use_skill']) && systemOf(r.mock.prompts[0]).includes('# Mode: ask'));
    ok('...the answer streams and the footer closes the turn', r.ui.streamed === 'Hello from the mock.' && r.ui.events[r.ui.events.length - 1][0] === 'footer' && !has(r.ui, 'error'));
    r = await turn({ flags: { mode: 'plan' } });
    ok('plan forces the agent loop with write_plan and no writes', r.mock.counts.stream === 1 && r.mock.tools[0].includes('write_plan') && !r.mock.tools[0].includes('write_file') && !r.mock.tools[0].includes('plan_todo') && systemOf(r.mock.prompts[0]).includes('# Mode: plan') && has(r.ui, 'status', (e) => e[1] === 'plan · thinking …'));
    r = await turn({ flags: { mode: 'agent' } });
    ok('agent forces the agent loop with every tool', r.mock.counts.stream === 1 && r.mock.tools[0].length === AGENT_COUNT && r.mock.tools[0].includes('plan_todo') && systemOf(r.mock.prompts[0]).includes('# Mode: agent'));
    r = await turn({ flags: { mode: 'auto' } });
    ok('auto, simple question: the action template, no agent loop', r.mock.counts.stream === 0 && r.mock.counts.template === 1 && has(r.ui, 'status', (e) => /generating answer/.test(e[1])) && !has(r.ui, 'status', (e) => /thinking/.test(e[1])));
    r = await turn({ flags: { mode: 'auto' }, analysis: { needs_agent: true } });
    ok('auto, needs_agent: the agent loop, as agent', r.mock.counts.stream === 1 && r.mock.tools[0].length === AGENT_COUNT && systemOf(r.mock.prompts[0]).includes('# Mode: agent') && !systemOf(r.mock.prompts[0]).includes('# Mode: auto'));
    r = await turn({ flags: { mode: 'auto' }, analysis: { skill_name: 'demo-skill' } });
    ok('auto, a skill matched: the agent loop, as agent, following the skill', r.mock.counts.stream === 1 && r.mock.tools[0].length === AGENT_COUNT && systemOf(r.mock.prompts[0]).includes('SKILL_STEP_ABC'));
    r = await turn({ flags: { mode: 'ask' }, analysis: { skill_name: 'demo-skill' } });
    ok('ask with a matched skill: the skill is followed with the read-only tools only', systemOf(r.mock.prompts[0]).includes('SKILL_STEP_ABC') && !r.mock.tools[0].includes('write_file') && !r.mock.tools[0].includes('run_bash'));
    r = await turn({ flags: { mode: 'bogus' } });
    ok('a mode that does not exist is auto', r.mock.counts.stream === 0 && r.mock.counts.template === 1);
    r = await turn({ flags: {} });
    ok('no mode at all is auto', r.mock.counts.stream === 0 && r.mock.counts.template === 1);

    r = await turn({ flags: { mode: 'ask' }, opts: { modeOverride: 'agent' } });
    ok('opts.modeOverride beats flags.mode (ask -> agent)', r.mock.tools[0].length === AGENT_COUNT && systemOf(r.mock.prompts[0]).includes('# Mode: agent'));
    r = await turn({ flags: { mode: 'agent' }, opts: { modeOverride: 'ask' } });
    ok('...and the other way (agent -> ask)', !r.mock.tools[0].includes('write_file') && systemOf(r.mock.prompts[0]).includes('# Mode: ask'));
    r = await turn({ flags: { mode: 'ask' }, opts: { modeOverride: 'auto' } });
    ok('...an override of auto hands the choice back to the router', r.mock.counts.stream === 0 && r.mock.counts.template === 1);

    // flags.mode is read live: a /mode between turns applies to the next one
    const live = { mode: 'auto' };
    MOCK = makeMock().model;
    const rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: live });
    const seen = [];
    for (const mode of ['ask', 'plan', 'agent', 'ask']) {
        const mock = makeMock();
        MOCK = mock.model;
        live.mode = mode;
        await rt.runPrompt('hi', makeUI());
        seen.push(mock.tools[0].includes('write_plan') + ':' + mock.tools[0].includes('write_file'));
    }
    ok('flags.mode changes apply to the next turn, one runtime', same(seen, ['false:false', 'true:false', 'true:true', 'false:false']));
    ok('ask mode with --local still runs the loop (the user asked for it)', (await turn({ flags: { mode: 'ask', local: true }, keys: { LOCAL_BASE_URL: 'http://localhost:1/v1', LOCAL_MODEL: 'm' } })).mock.counts.stream === 1);

    // the router's English version of the input is what the agent works on ...
    const long = `${'H'.repeat(2000)}${'M'.repeat(7000)}${'T'.repeat(1000)}`;
    r = await turn({ flags: { mode: 'agent' }, input: long, analysis: { english: 'REWRITTEN BY THE ROUTER' } });
    ok('by default the agent gets the router\'s English version of the input', lastUserText(r.mock.prompts[0]) === 'REWRITTEN BY THE ROUTER');
    ok('...and the router is given the whole input and asked for that version', r.mock.routerPrompts[0].includes(long) && r.mock.routerPrompts[0].includes('provide an english version of it (without translating filenames)') && !r.mock.routerPrompts[0].includes('omitted'));
    const wholeRouterPrompt = r.mock.routerPrompts[0];
    // ... unless the input is verbatim (a plan file to implement): exactly as written, and the router never copies it
    r = await turn({ flags: { mode: 'agent' }, input: long, opts: { verbatim: true }, analysis: { english: 'REWRITTEN BY THE ROUTER' } });
    ok('verbatim: the agent gets the input exactly, whatever the router answered', lastUserText(r.mock.prompts[0]) === long);
    ok('...the router sees the first 2000 and the last 1000 characters, with the size of the gap', r.mock.routerPrompts[0].includes(`${'H'.repeat(2000)}\n[... 7000 characters omitted ...]\n${'T'.repeat(1000)}`) && !r.mock.routerPrompts[0].includes('MMMMMMMMMM') && wholeRouterPrompt.length - r.mock.routerPrompts[0].length > 6000);
    ok('...and is told to leave the English version empty, not to write one', r.mock.routerPrompts[0].includes('The text is used exactly as written, so set english to an empty string.') && !r.mock.routerPrompts[0].includes('provide an english version'));
    r = await turn({ flags: { mode: 'agent' }, input: long, opts: { verbatim: true }, analysis: { english: '' } });
    ok('...an empty English version, as it was asked for, changes nothing', lastUserText(r.mock.prompts[0]) === long && r.mock.counts.router === 1 && r.mock.counts.stream === 1);
    const at = (n) => 'x'.repeat(n);
    r = await turn({ flags: { mode: 'agent' }, input: at(3000), opts: { verbatim: true } });
    ok('...an input of 3000 characters is shown to the router whole', r.mock.routerPrompts[0].includes(at(3000)) && !r.mock.routerPrompts[0].includes('omitted'));
    r = await turn({ flags: { mode: 'agent' }, input: `${at(2000)}\u2603${at(1000)}`, opts: { verbatim: true } });
    ok('...one of 3001 loses its middle character and says so', r.mock.routerPrompts[0].includes(`${at(2000)}\n[... 1 characters omitted ...]\n${at(1000)}`) && !r.mock.routerPrompts[0].includes('\u2603') && lastUserText(r.mock.prompts[0]) === `${at(2000)}\u2603${at(1000)}`);
    r = await turn({ flags: { mode: 'ask' }, input: 'short plan text', opts: { verbatim: true }, analysis: { english: 'REWRITTEN BY THE ROUTER' } });
    ok('...a short input is verbatim too, in any mode that reaches the loop', lastUserText(r.mock.prompts[0]) === 'short plan text' && r.mock.routerPrompts[0].includes('short plan text'));
}

// =============================================================================
// [J] whole turns: a plan is written, an ask cannot write, a plan is implemented
// =============================================================================
console.log('\n[J] plan -> implement');
{
    async function turn({ flags = {}, streams, input = 'go', opts = {}, project, confirm = true, analysis = {} }) {
        const mock = makeMock({ streams, analysis });
        MOCK = mock.model;
        const rt = createRuntime({ cwd: project, keysData: { OPENAI_KEY: 'k' }, flags: { ...flags } });
        const ui = makeUI({ confirmAnswer: confirm });
        await rt.runPrompt(input, ui, opts);
        return { ui, mock };
    }
    const project = tempDir('flow');
    fs.writeFileSync(path.join(project, 'server.js'), 'module.exports = {};\n');

    // Plan mode ends in a plan file
    let r = await turn({ project, flags: { mode: 'plan' }, input: 'add a /health endpoint', streams: [callTool('write_plan', PLAN_ARGS), say('The plan is written.')] });
    const planFile = path.join(project, PLAN_PATH);
    ok('a plan turn writes .aicode/plans/<title>.plan.md', fs.existsSync(planFile) && fs.readFileSync(planFile, 'utf8') === plans.renderPlan({ ...PLAN_ARGS, todos: withStatus(PLAN_ARGS.todos) }));
    ok('...the UI shows the file written, then the plan card', has(r.ui, 'fileWritten', (e) => e[1] === PLAN_PATH && e[2].created === true) && has(r.ui, 'plan', (e) => e[1].path === PLAN_PATH && e[1].title === PLAN_ARGS.title && e[1].todos.length === 2));
    ok('...the step reads "write plan" and ends with the path', has(r.ui, 'step', (e) => e[1] === 'write plan "Add a /health endpoint"') && has(r.ui, 'step.done', (e) => e[1] === 'write plan "Add a /health endpoint"' && e[2] === PLAN_PATH));
    ok('...and the model finishes with its summary', r.ui.streamed.includes('The plan is written.') && !has(r.ui, 'error'));
    ok('nothing else was written', same(fs.readdirSync(project).sort(), ['.aicode', 'server.js']));

    // --confirm: a declined write leaves no plan
    const other = tempDir('flow-declined');
    r = await turn({ project: other, flags: { mode: 'plan', confirm: true }, confirm: false, streams: [callTool('write_plan', PLAN_ARGS), say('Not written.')] });
    ok('with --confirm the plan write asks first, and a no leaves no file and no card', has(r.ui, 'confirm', (e) => e[1].includes(`write file #${PLAN_PATH}#`)) && !fs.existsSync(path.join(other, PLAN_PATH)) && !has(r.ui, 'plan') && has(r.ui, 'step.done', (e) => e[2] === 'error'));

    // Ask mode: a model that tries to write anyway cannot
    r = await turn({ project, flags: { mode: 'ask' }, streams: [callTool('write_file', { path: 'hacked.txt', content: 'x' }), callTool('run_bash', { command: 'touch hacked2.txt' }, 'c2'), say('I cannot change files here.')] });
    ok('in ask mode a write_file or run_bash call does nothing', !fs.existsSync(path.join(project, 'hacked.txt')) && !fs.existsSync(path.join(project, 'hacked2.txt')) && !has(r.ui, 'fileWritten'));
    ok('...the failed calls show as failed steps and the turn goes on to its answer', has(r.ui, 'step.fail') && r.ui.streamed.includes('I cannot change files here.'));
    r = await turn({ project, flags: { mode: 'plan' }, streams: [callTool('write_file', { path: 'hacked3.txt', content: 'x' }), say('Planning only.')] });
    ok('...and in plan mode too', !fs.existsSync(path.join(project, 'hacked3.txt')) && has(r.ui, 'step.fail'));
    r = await turn({ project, flags: { mode: 'ask' }, streams: [callTool('write_plan', PLAN_ARGS), say('no')] });
    ok('write_plan is not available in ask mode', fs.readdirSync(path.join(project, '.aicode/plans')).length === 1 && has(r.ui, 'step.fail'));
    r = await turn({ project, flags: { mode: 'plan' }, streams: [callTool('plan_todo', { path: PLAN_PATH, id: 'route', status: 'completed' }), say('no')] });
    ok('plan_todo is not available in plan mode', plans.parsePlan(fs.readFileSync(planFile, 'utf8')).todos[0].status === 'pending' && has(r.ui, 'step.fail'));

    // Implement: the plan file is the input, exactly as written, and the turn runs as agent
    const read = plans.readPlanFile(project, PLAN_PATH);
    const text = plans.implementText(read.rel, read.text);
    r = await turn({
        project, flags: { mode: 'ask' }, opts: { modeOverride: 'agent', verbatim: true }, input: text,
        analysis: { english: 'A PARAPHRASE OF THE PLAN' },
        streams: [
            callTool('plan_todo', { path: PLAN_PATH, id: 'route', status: 'in_progress' }, 'a'),
            callTool('write_file', { path: 'server.js', content: 'module.exports = { health: true };\n' }, 'b'),
            callTool('plan_todo', { path: PLAN_PATH, id: 'route', status: 'completed' }, 'c'),
            callTool('plan_todo', { path: PLAN_PATH, id: 'test', status: 'completed' }, 'd'),
            say('Implemented.'),
        ],
    });
    ok('the implement turn sends the plan as its input, exactly (not the router\'s version of it)', lastUserText(r.mock.prompts[0]) === text && text.startsWith(`Implement the plan at ${PLAN_PATH}. Work through its todos in order`) && text.endsWith(read.text));
    ok('...runs as agent whatever the session mode is', r.mock.tools[0].length === 14 && systemOf(r.mock.prompts[0]).includes('# Mode: agent'));
    const after = plans.parsePlan(fs.readFileSync(planFile, 'utf8'));
    ok('...plan_todo moved the todos in the file', after.todos.map((t) => t.status).join() === 'completed,completed' && after.body === PLAN_ARGS.markdown);
    ok('...and the work was done', fs.readFileSync(path.join(project, 'server.js'), 'utf8') === 'module.exports = { health: true };\n');
    ok('...the steps read "plan todo <id> → <status>" with a progress summary', has(r.ui, 'step', (e) => e[1] === 'plan todo route → in_progress') && has(r.ui, 'step.done', (e) => e[1] === 'plan todo route → in_progress' && e[2] === '0/2 completed') && has(r.ui, 'step.done', (e) => e[1] === 'plan todo test → completed' && e[2] === '2/2 completed'));
    ok('...a plan_todo is not asked about, even with --confirm', (await turn({ project, flags: { mode: 'agent', confirm: true }, confirm: false, streams: [callTool('plan_todo', { path: PLAN_PATH, id: 'route', status: 'pending' }), say('ok')] })).ui.events.filter((e) => e[0] === 'confirm').length === 0 && plans.parsePlan(fs.readFileSync(planFile, 'utf8')).todos[0].status === 'pending');

    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
}

// =============================================================================
// [K] the terminal surfaces
// =============================================================================
console.log('\n[K] terminal surfaces');
{
    const lines = [];
    const stream = { write: (t) => lines.push(t), isTTY: false, columns: 100 };
    const ui = uiLib.createUI({ stream, plain: true });
    ui.planCreated({ path: PLAN_PATH, title: 't', overview: 'o', todos: [] });
    ok('the transcript UI notes where the plan was written, and how to implement it', lines.join('').trim() === `plan written to ${PLAN_PATH}\nimplement it with: aicode --plan ${PLAN_PATH}`);
    const quiet = [];
    uiLib.createUI({ stream: { write: (t) => quiet.push(t), isTTY: false }, plain: true, quiet: true }).planCreated({ path: PLAN_PATH });
    ok('...and says nothing under --quiet', quiet.length === 0);
    ok('...it copes with no argument', (() => { try { ui.planCreated(); return true; } catch (e) { return false; } })());

    const items = [];
    const colors = uiLib.makeColors(false);
    const adapter = makeTuiAdapter({ addItem: (t) => items.push(t), setLive() { }, setStreamText() { }, prompt: async () => null }, {
        colors, renderMarkdown: (t) => t, colorize: (s) => s, formatStep: uiLib.formatStep, formatFooter: uiLib.formatFooter,
        formatFileWritten: uiLib.formatFileWritten, formatNote: uiLib.formatNote, formatError: uiLib.formatError,
        formatDiff: uiLib.formatDiff, formatData: uiLib.formatData, debug: false,
    });
    adapter.planCreated({ path: PLAN_PATH, title: 't', todos: [] });
    ok('the TUI adapter notes it too, pointing at /plan build', items.length === 1 && items[0] === `plan written to ${PLAN_PATH}\nimplement it with /plan build`);
}

// =============================================================================
// [L] the command line: --mode and --plan (child processes, no model needed)
// =============================================================================
console.log('\n[L] command line');
{
    const dir = tempDir('cli');
    fs.mkdirSync(path.join(dir, '.aicode', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(dir, PLAN_PATH), plans.renderPlan(PLAN_ARGS));
    const env = { ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, NO_COLOR: '1', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', AICODE_NO_ORVIX: '1' };
    for (const key of ['OPENAI_KEY', 'ANTHROPIC_KEY', 'GROQ_KEY', 'OPENROUTER_KEY', 'OPENROUTER_API_KEY']) delete env[key];
    const aicode = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'index.js'), ...args], { cwd: dir, env, encoding: 'utf8', timeout: 30000, input: '' });
    const all = (res) => `${res.stdout}${res.stderr}`;

    let res = aicode('--mode', 'bogus', 'hi');
    ok('--mode takes auto, agent, plan or ask only', res.status === 1 && /mode/.test(all(res)) && /auto/.test(all(res)) && /plan/.test(all(res)));
    res = aicode('--help');
    // (the help is in the language of the machine, so only what is the same in every language is checked)
    ok('--help lists --mode with its choices, and --plan', /--mode[\s\S]*"auto", "agent", "plan", "ask"/.test(res.stdout) && /--plan/.test(res.stdout));
    const locale = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${name}.json`), 'utf8'));
    const ENGLISH = ['Interaction mode: auto, agent, plan or ask', 'Implement a plan file in agent mode'];
    ok('both texts are in the English locale as themselves and have a Spanish one', ENGLISH.every((key) => locale('en')[key] === key && typeof locale('es')[key] === 'string' && locale('es')[key] !== '' && locale('es')[key] !== key));
    res = aicode('--plan', 'missing.plan.md');
    ok('--plan with a file that is not there fails at once, before any key prompt', res.status === 1 && /plan not found: missing\.plan\.md/.test(all(res)) && !/API key/.test(all(res)));
    res = aicode('--plan', '.aicode');
    ok('--plan with a directory fails', res.status === 1 && /not a file: \.aicode/.test(all(res)));
    res = aicode('--plan', '');
    ok('--plan without a path asks for one', res.status === 1 && /give the path of a plan file/.test(all(res)));
    for (const mode of ['ask', 'plan']) {
        res = aicode('--plan', PLAN_PATH, '--mode', mode);
        ok(`--plan with --mode ${mode} is refused: implementing is agent work`, res.status === 1 && all(res).includes(`--plan implements a plan in agent mode: it cannot be combined with --mode ${mode}`));
    }
    res = aicode('--plan', PLAN_PATH, '--mode', 'ask', '--agent');
    ok('...--agent does not change that', res.status === 1 && /cannot be combined with --mode ask/.test(all(res)));
    fs.rmSync(dir, { recursive: true, force: true });
}

// =============================================================================
// [M] the command line end to end: real index.js, real runtime, a local http stub as the model
// =============================================================================
console.log('\n[M] aicode --plan / --mode against a stub model');
{
    const dir = tempDir('e2e');
    fs.writeFileSync(path.join(dir, 'server.js'), 'module.exports = {};\n');
    // a plan long enough that the router only sees an excerpt of it
    const bigPlan = plans.renderPlan({ ...PLAN_ARGS, markdown: `${PLAN_ARGS.markdown}\n${'Background paragraph about the health endpoint. '.repeat(120)}\nEND-OF-PLAN\n` });
    const planFile = path.join(dir, PLAN_PATH);
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, bigPlan);

    const requests = [];
    const stub = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(body); } catch (e) { /* not json */ }
            const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
            const json = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
            if (req.url !== '/chat/completions' || !parsed) return json(404, {});
            const messages = parsed.messages || [];
            const textOf = (role) => messages.filter((m) => m.role === role).map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join(''))).join('\n');
            const userText = textOf('user');
            const isRouter = userText.includes('Analyze the following user input text');
            requests.push({ router: isRouter, stream: parsed.stream === true, userText, system: textOf('system'), tools: (parsed.tools || []).map((t) => t.function.name).sort() });
            if (!parsed.stream) {
                const content = JSON.stringify({ schema: isRouter ? { ...ANALYSIS, english: '' } : { answer: 'TEMPLATE_ANSWER' } });
                return json(200, { id: 'g', object: 'chat.completion', created: 1, model: parsed.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const chunk = (extra) => `data: ${JSON.stringify({ id: 'g', object: 'chat.completion.chunk', created: 1, model: parsed.model, ...extra })}\n\n`;
            res.write(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'STUB ' }, finish_reason: null }] }));
            res.write(chunk({ choices: [{ index: 0, delta: { content: 'ANSWER' }, finish_reason: null }] }));
            res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.write(chunk({ choices: [], usage }));
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const env = {
        ...process.env, HOME: TMP_HOME, USERPROFILE: TMP_HOME, NO_COLOR: '1', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', AICODE_NO_ORVIX: '1',
        OPENROUTER_KEY: 'sk-or-e2e', OPENAI_KEY: 'unused', GROQ_KEY: 'unused', ANTHROPIC_KEY: 'unused', REPLICATE_API_TOKEN: 'unused',
        AICODE_OPENROUTER_API: `http://127.0.0.1:${stub.address().port}`,
    };
    // async: the stub lives in this process, so the child cannot be waited for synchronously
    const aicode = (...args) => new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(ROOT, 'index.js'), ...args], { cwd: dir, env });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
        child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
        child.stdin.end();
    });
    const agentRequests = () => requests.filter((q) => q.stream);
    const reset = () => { requests.length = 0; };

    let res = await aicode('--plan', PLAN_PATH);
    const routerReq = requests.find((q) => q.router);
    const agentReq = agentRequests()[0];
    ok('aicode --plan runs the plan through the router and the agent loop', res.status === 0 && /STUB ANSWER/.test(res.stdout) && routerReq && agentReq && !/error|failed/i.test(res.stderr));
    const expected = plans.implementText(PLAN_PATH, bigPlan);
    ok('...the agent gets the plan file exactly as written, under the implement sentence', agentReq.userText === expected && expected.length > 3000);
    const count = (text, word) => text.split(word).length - 1;
    ok('...the router only sees an excerpt of it (its start and its end) and is not asked to copy it', routerReq.userText.includes('characters omitted') && routerReq.userText.includes('Implement the plan at') && routerReq.userText.includes('END-OF-PLAN') && count(routerReq.userText, 'Background paragraph') > 0 && count(routerReq.userText, 'Background paragraph') < count(expected, 'Background paragraph') && routerReq.userText.includes('The text is used exactly as written'));
    ok('...in agent mode: every tool, plan_todo and write_file among them', agentReq.tools.includes('plan_todo') && agentReq.tools.includes('write_file') && agentReq.tools.includes('run_bash') && /# Mode: agent/.test(agentReq.system));

    reset();
    res = await aicode('--plan', PLAN_PATH, 'and also document it');
    ok('a positional input is appended as additional instructions', res.status === 0 && agentRequests()[0].userText === plans.implementText(PLAN_PATH, bigPlan, 'and also document it') && agentRequests()[0].userText.endsWith('\n\nAdditional instructions: and also document it'));

    reset();
    res = await aicode('--mode', 'ask', 'what does server.js export?');
    ok('aicode --mode ask answers with the read-only tools and the ask prompt', res.status === 0 && /STUB ANSWER/.test(res.stdout) && agentRequests().length === 1
        && !agentRequests()[0].tools.includes('write_file') && !agentRequests()[0].tools.includes('run_bash') && !agentRequests()[0].tools.includes('write_plan') && agentRequests()[0].tools.includes('read_file') && /# Mode: ask/.test(agentRequests()[0].system));
    ok('...and the router was asked for the English version as usual', requests.find((q) => q.router).userText.includes('what does server.js export?') && !requests.find((q) => q.router).userText.includes('characters omitted'));

    reset();
    res = await aicode('--mode', 'plan', 'add a /health endpoint');
    ok('aicode --mode plan offers write_plan and no write tools', res.status === 0 && agentRequests()[0].tools.includes('write_plan') && !agentRequests()[0].tools.includes('write_file') && !agentRequests()[0].tools.includes('plan_todo') && /# Mode: plan/.test(agentRequests()[0].system));

    reset();
    res = await aicode('--mode', 'agent', 'tidy server.js');
    ok('aicode --mode agent runs the loop with every tool', res.status === 0 && agentRequests().length === 1 && agentRequests()[0].tools.includes('write_file') && agentRequests()[0].tools.includes('plan_todo') && /# Mode: agent/.test(agentRequests()[0].system));

    reset();
    res = await aicode('--agent', 'tidy server.js');
    ok('--agent is still --mode agent', res.status === 0 && agentRequests().length === 1 && /# Mode: agent/.test(agentRequests()[0].system));

    reset();
    res = await aicode('hello there');
    ok('no mode: the router decides, and a simple question takes the action template', res.status === 0 && requests.filter((q) => q.router).length === 1 && agentRequests().length === 0);

    await new Promise((resolve) => stub.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
}

fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
