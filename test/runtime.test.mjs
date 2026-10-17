// Offline checks for lib/runtime.js: the per-session pipeline extracted from
// index.js. A scripted mock model plays the router (generateObject) and the
// answer/agent loop (streamText); nothing touches the network or the real HOME.
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);

// isolate HOME (keys.json, caches, global skills) before anything resolves it
const REAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-rt-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// a project directory with a couple of files for the context scan
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-rt-project-'));
fs.writeFileSync(path.join(PROJECT, 'hello.js'), 'console.log("hello");\n');
fs.writeFileSync(path.join(PROJECT, 'notes.md'), '# notes\n');
const SKILL_DIR = path.join(PROJECT, '.agents', 'skills', 'demo-skill');
fs.mkdirSync(SKILL_DIR, { recursive: true });
fs.writeFileSync(path.join(SKILL_DIR, 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill used by the runtime test\n---\nStep 1: do SKILL_STEP_ABC.\n');

const Code2Prompt = require('../lib/engine');
const models = require('../lib/models');
const { createRuntime, FLAG_DEFAULTS } = require('../lib/runtime');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };

// --- provider plumbing -> mock model -----------------------------------------
let MOCK = null;
models.resolveProvider = (prefs) => (prefs && prefs.length ? prefs[0] : null);
models.createModel = () => MOCK;
models.callOptions = () => ({});
models.modelId = () => 'mock-model';
models.estimateCost = () => 0;
models.estimateTokens = () => 10;

const STOP = { unified: 'stop', raw: 'stop' };
const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const ANALYSIS = {
    type_of: 'question',
    english: 'say hello',
    language: 'English',
    action_file: '',
    action_reason: 'n/a',
    personality_file: '',
    personality_reason: 'n/a',
    needs_agent: false,
    skill_name: '',
};

// router calls (generateObject) are told apart from template calls by their prompt
function makeMock({ analysis = {}, answer = 'Hello from the mock.', templateAnswer = 'TEMPLATE_ANSWER', failRouter = false } = {}) {
    const counts = { generate: 0, stream: 0, router: 0, template: 0 };
    const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
            counts.generate++;
            const prompt = JSON.stringify(options.prompt);
            if (prompt.includes('Analyze the following user input text')) {
                counts.router++;
                if (failRouter) throw new Error('router exploded');
                return { content: [{ type: 'text', text: JSON.stringify({ schema: { ...ANALYSIS, ...analysis } }) }], finishReason: STOP, usage: USAGE, warnings: [] };
            }
            counts.template++;
            return { content: [{ type: 'text', text: JSON.stringify({ schema: { answer: templateAnswer } }) }], finishReason: STOP, usage: USAGE, warnings: [] };
        },
        doStream: async () => {
            counts.stream++;
            return {
                stream: convertArrayToReadableStream([
                    { type: 'stream-start', warnings: [] },
                    { type: 'response-metadata', id: 'r', modelId: 'mock' },
                    { type: 'text-start', id: 't' },
                    { type: 'text-delta', id: 't', delta: answer },
                    { type: 'text-end', id: 't' },
                    { type: 'finish', finishReason: STOP, usage: USAGE },
                ]),
            };
        },
    });
    return { model, counts };
}

// a UI object recording everything the pipeline tells it
function makeUI({ confirmAnswer = true } = {}) {
    const events = [];
    let streaming = false;
    let streamed = '';
    return {
        events,
        get streamed() { return streamed; },
        step: (label) => {
            events.push(['step', label]);
            return {
                update: () => { },
                done: (extra) => events.push(['step.done', label, extra]),
                fail: (text) => events.push(['step.fail', label, text]),
            };
        },
        status: (t) => events.push(['status', t]),
        statusStart: () => { },
        statusStop: () => { },
        streamChunk: (c) => { streaming = true; streamed += c; },
        streamEnd: () => { streaming = false; events.push(['streamEnd']); },
        isStreaming: () => streaming,
        note: (m) => events.push(['note', String(m)]),
        error: (e) => events.push(['error', String((e && e.message) || e)]),
        debug: () => { },
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
    };
}
const has = (ui, kind, pred = () => true) => ui.events.some((e) => e[0] === kind && pred(e));
const names = (ui) => ui.events.map((e) => e[0]);

// =============================================================================
// [A] createRuntime: flags, provider chip, action list
// =============================================================================
console.log('\n[A] createRuntime basics');
{
    const flags = { confirm: true, mode: 'agent' };
    const keys = { OPENAI_KEY: 'sk-test' };
    const rt = createRuntime({ cwd: PROJECT, keysData: keys, flags });
    ok('flags object is kept by reference', rt.flags === flags);
    ok('keysData object is kept by reference', rt.keysData === keys);
    ok('cwd is exposed', rt.cwd === PROJECT);
    ok('caller-provided flags win over defaults', flags.confirm === true && flags.mode === 'agent');
    ok('missing flags are filled with defaults', flags.local === false && flags.quiet === false && flags.debug === false && flags.language === null && flags.modelPreferences === null);
    ok('FLAG_DEFAULTS documents the mode default', FLAG_DEFAULTS.mode === 'auto');

    const bare = createRuntime({ cwd: PROJECT });
    ok('createRuntime works with no flags or keys', bare.flags.mode === 'auto' && typeof bare.runPrompt === 'function');

    ok('describeProvider reports the first provider with credentials', JSON.stringify(rt.describeProvider()) === JSON.stringify({ provider: 'openai', model: 'mock-model' }));
    keys.OPENAI_KEY = '';
    keys.ANTHROPIC_KEY = 'sk-ant';
    ok('describeProvider follows key changes live (shared keysData)', rt.describeProvider().provider === 'anthropic');
    keys.ANTHROPIC_KEY = '';
    ok('describeProvider is empty with no credentials', JSON.stringify(rt.describeProvider()) === JSON.stringify({ provider: '', model: '' }));
    keys.LOCAL_MODEL = 'llama-test';
    ok('describeProvider falls back to the local model', JSON.stringify(rt.describeProvider()) === JSON.stringify({ provider: 'local', model: 'llama-test' }));
    keys.OPENAI_KEY = 'sk-test';
    ok('cloud wins over local without --local', rt.describeProvider().provider === 'openai');
    flags.local = true;
    ok('flags.local flips the chip live', JSON.stringify(rt.describeProvider()) === JSON.stringify({ provider: 'local', model: 'llama-test' }));

    const actions = rt.listActions();
    ok('listActions returns template basenames', actions.includes('default') && actions.includes('answer-user-question') && !actions.some((a) => a.endsWith('.md')));
    ok('listActions is sorted', JSON.stringify(actions) === JSON.stringify([...actions].sort()));
    ok('usage() is null before the first turn', rt.usage() === null);
}

// =============================================================================
// [B] runPrompt: agent mode forced by flags.mode
// =============================================================================
console.log('\n[B] runPrompt in agent mode');
{
    const { model, counts } = makeMock();
    MOCK = model;
    Code2Prompt.resetUsage();
    const flags = { mode: 'agent' };
    const rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'sk-test' }, flags });
    const ui = makeUI();
    const usage = await rt.runPrompt('say hello', ui);
    ok('router ran once (fast-tier classification)', counts.router === 1);
    ok('agent loop streamed once', counts.stream === 1);
    ok('analyzing step opened and closed', has(ui, 'step', (e) => e[1] === 'analyzing request') && has(ui, 'step.done', (e) => e[1] === 'analyzing request'));
    ok('the unresolved router choices fall back to the default template and personality', has(ui, 'step.done', (e) => e[2] === 'answer-user-question · default'));
    ok('agent status shown', has(ui, 'status', (e) => /agent/.test(e[1])));
    ok('the template path was not used', !has(ui, 'status', (e) => /generating answer/.test(e[1])));
    ok('answer streamed to the UI', ui.streamed === 'Hello from the mock.');
    ok('footer emitted last', names(ui)[names(ui).length - 1] === 'footer');
    const footer = ui.events.find((e) => e[0] === 'footer')[1];
    ok('footer carries the turn usage and elapsed time', footer.calls === 2 && typeof footer.elapsedMs === 'number' && footer.elapsedMs >= 0);
    ok('runPrompt resolves with the usage summary', usage.calls === 2 && usage.model === 'mock-model');
    ok('rt.usage() returns the last summary', rt.usage() && rt.usage().calls === 2);
    ok('the per-turn ledger leaves the static ledger untouched', Code2Prompt.getUsage().calls === 0);
    ok('no error was reported', !has(ui, 'error'));
}

// =============================================================================
// [C] concurrent sessions never mix their usage
// =============================================================================
console.log('\n[C] concurrent sessions');
{
    const { model } = makeMock();
    MOCK = model;
    Code2Prompt.resetUsage();
    const rt1 = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'agent' } });
    const rt2 = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'agent' } });
    const ui1 = makeUI(), ui2 = makeUI();
    const [u1, u2, u3] = await Promise.all([
        rt1.runPrompt('first', ui1),
        rt2.runPrompt('second', ui2),
        rt1.runPrompt('third (same runtime, overlapping)', makeUI()),
    ]);
    ok('session 1 sees only its own calls', u1.calls === 2);
    ok('session 2 sees only its own calls', u2.calls === 2);
    ok('overlapping turns of one runtime are isolated too', u3.calls === 2);
    ok('each UI got its own footer', has(ui1, 'footer', (e) => e[1].calls === 2) && has(ui2, 'footer', (e) => e[1].calls === 2));
    ok('static ledger still untouched', Code2Prompt.getUsage().calls === 0);
}

// =============================================================================
// [D] routing: auto / needs_agent / modeOverride / template path / skills
// =============================================================================
console.log('\n[D] routing');
{
    // auto + needs_agent -> agent loop
    let m = makeMock({ analysis: { needs_agent: true } });
    MOCK = m.model;
    let rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'auto' } });
    let ui = makeUI();
    await rt.runPrompt('refactor three files', ui);
    ok('needs_agent routes to the agent loop', has(ui, 'status', (e) => /agent/.test(e[1])) && m.counts.stream === 1);

    // auto + simple -> the action template (classic path)
    m = makeMock();
    MOCK = m.model;
    rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'auto' } });
    ui = makeUI();
    const usage = await rt.runPrompt('what is this project?', ui);
    ok('a simple question uses the template path', has(ui, 'status', (e) => /generating answer/.test(e[1])) && !has(ui, 'status', (e) => /agent/.test(e[1])));
    ok('the template answer reaches the UI through log()', has(ui, 'note', (e) => e[1].includes('TEMPLATE_ANSWER')));
    ok('router + template both counted in the turn ledger', usage.calls === 2 && m.counts.router === 1 && m.counts.template === 1);
    ok('template path leaves no error', !has(ui, 'error'));

    // opts.modeOverride beats flags.mode
    m = makeMock();
    MOCK = m.model;
    rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'auto' } });
    ui = makeUI();
    await rt.runPrompt('anything', ui, { modeOverride: 'agent' });
    ok('opts.modeOverride forces the agent loop', has(ui, 'status', (e) => /agent/.test(e[1])));

    // flags.mode is read live, so a TUI toggle between turns takes effect
    m = makeMock();
    MOCK = m.model;
    const live = { mode: 'auto' };
    rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: live });
    ui = makeUI();
    live.mode = 'agent';
    await rt.runPrompt('anything', ui);
    ok('flags.mode changes apply to the next turn', has(ui, 'status', (e) => /agent/.test(e[1])));

    // a router-selected installed skill defaults to the agent loop
    m = makeMock({ analysis: { skill_name: 'demo-skill' } });
    MOCK = m.model;
    rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'auto' } });
    ui = makeUI();
    await rt.runPrompt('use the demo skill', ui);
    ok('a selected skill is named in the analyzing step', has(ui, 'step.done', (e) => (e[2] || '').startsWith('skill:demo-skill')));
    ok('a selected skill runs the agent loop', has(ui, 'status', (e) => /agent/.test(e[1])));

    // ...but under --local the one-shot use-skill template path stays as the fallback
    m = makeMock({ analysis: { skill_name: 'demo-skill' } });
    MOCK = m.model;
    rt = createRuntime({ cwd: PROJECT, keysData: { LOCAL_BASE_URL: 'http://localhost:1/v1', LOCAL_MODEL: 'm' }, flags: { mode: 'auto', local: true } });
    ui = makeUI();
    await rt.runPrompt('use the demo skill', ui);
    ok('--local keeps skills on the template path', !has(ui, 'status', (e) => /agent/.test(e[1])));

    // flags.language wins over the detected language
    m = makeMock();
    MOCK = m.model;
    rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'agent', language: 'es' } });
    ui = makeUI();
    await rt.runPrompt('hola', ui);
    ok('a language flag does not break the turn', !has(ui, 'error') && has(ui, 'footer'));
}

// =============================================================================
// [E] pre-flight failure still reports and returns usage
// =============================================================================
console.log('\n[E] router failure');
{
    const m = makeMock({ failRouter: true });
    MOCK = m.model;
    const rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'agent' } });
    const ui = makeUI();
    const usage = await rt.runPrompt('this will fail', ui);
    ok('the analyzing step is marked failed', has(ui, 'step.fail', (e) => e[1] === 'analyzing request'));
    ok('the error is reported to the UI', has(ui, 'error', (e) => /router exploded/.test(e[1])));
    ok('a footer is still printed', has(ui, 'footer'));
    ok('usage is returned (no successful calls)', usage && usage.calls === 0);
    ok('the agent loop never started', m.counts.stream === 0);
}

// =============================================================================
// [F] cancelled turn: an aborted signal is reported as a cancellation
// =============================================================================
console.log('\n[F] cancellation');
{
    const m = makeMock({ failRouter: true });
    MOCK = m.model;
    const rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: { mode: 'agent' } });
    const ui = makeUI();
    const controller = new AbortController();
    controller.abort();
    await rt.runPrompt('cancel me', ui, { signal: controller.signal });
    ok('an aborted turn says "run cancelled" instead of an error', has(ui, 'note', (e) => /run cancelled/.test(e[1])) && !has(ui, 'error'));
}

// =============================================================================
// [G] file helpers: the diff is shown before the confirmation
// =============================================================================
console.log('\n[G] makeFileHelpers');
{
    const rt = createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-rt-files-'));
    const target = path.join(dir, 'a.txt');
    fs.writeFileSync(target, 'one\ntwo\n');

    let answer = false;
    const ui = makeUI();
    const order = [];
    const confirmAction = async (what) => { order.push('confirm'); ui.events.push(['confirm', what]); return answer; };
    const origDiff = ui.diff;
    ui.diff = (file, a, b) => { order.push('diff'); origDiff(file, a, b); };
    const helpers = rt.makeFileHelpers(dir, ui, confirmAction, {});

    // existing file, denied
    let res = await helpers.writeFile('a.txt', 'one\nTWO\n');
    ok('the diff is shown before the confirmation', order[0] === 'diff' && order[1] === 'confirm');
    ok('a denied write returns false', res === false);
    ok('a denied write leaves the file untouched', fs.readFileSync(target, 'utf8') === 'one\ntwo\n');
    ok('a denied write never reports fileWritten', !has(ui, 'fileWritten'));
    ok('the confirm prompt names the relative file', has(ui, 'confirm', (e) => e[1].includes('a.txt') && !e[1].includes(dir)));

    // existing file, accepted
    answer = true;
    order.length = 0;
    res = await helpers.writeFile('a.txt', 'one\nTWO\n');
    ok('an accepted write returns true and writes', res === true && fs.readFileSync(target, 'utf8') === 'one\nTWO\n');
    ok('fileWritten reports an update', has(ui, 'fileWritten', (e) => e[2].created === false && e[2].lines === 3));

    // unchanged content: no diff noise
    order.length = 0;
    await helpers.writeFile('a.txt', 'one\nTWO\n');
    ok('identical content shows no diff', !order.includes('diff'));

    // new file: no diff, reported as created
    ui.events.length = 0;
    order.length = 0;
    res = await helpers.writeFile('b.txt', 'brand new\n');
    ok('a new file shows no diff', !order.includes('diff') && res === true);
    ok('a new file is reported as created', has(ui, 'fileWritten', (e) => e[1] === 'b.txt' && e[2].created === true));

    // absolute path inside baseDir works and is displayed relative
    ui.events.length = 0;
    await helpers.writeFile(path.join(dir, 'c.txt'), 'abs\n');
    ok('absolute paths are accepted and shown relative', fs.existsSync(path.join(dir, 'c.txt')) && has(ui, 'fileWritten', (e) => e[1] === 'c.txt'));

    // readFile is bound to baseDir
    ok('readFile resolves against the base directory', (await helpers.readFile('a.txt')) === 'one\nTWO\n');

    // editFile: search/replace blocks from the (stubbed) engine, diff then confirm
    const engine = { queryLLM: async () => ({ data: [{ search: 'one', replace: 'ONE' }, { search: 'nope', replace: 'x' }] }) };
    const edit = rt.makeFileHelpers(dir, ui, confirmAction, { engine });
    ui.events.length = 0;
    order.length = 0;
    res = await edit.editFile('a.txt', 'uppercase one');
    ok('editFile applies the matching edits', res.ok === true && res.applied === 1 && res.failed.length === 1 && fs.readFileSync(target, 'utf8') === 'ONE\nTWO\n');
    ok('editFile shows the diff before confirming', order[0] === 'diff' && order[1] === 'confirm');
    fs.writeFileSync(target, 'one\nTWO\n'); // back to a state the stubbed edit can match
    answer = false;
    res = await edit.editFile('a.txt', 'again');
    ok('a denied edit reports a cancellation', res.ok === false && /cancelled/.test(res.error));
    ok('a denied edit changes nothing', fs.readFileSync(target, 'utf8') === 'one\nTWO\n');
    answer = true;
    fs.writeFileSync(target, 'zzz\n'); // none of the stubbed search texts match
    res = await edit.editFile('a.txt', 'no match');
    ok('edits that match nothing are reported, not applied', res.ok === false && /no edits could be applied/.test(res.error) && fs.readFileSync(target, 'utf8') === 'zzz\n');

    // executeBash: confirm-gated, runs through the engine with the base directory
    let ranWith = null;
    const bashEngine = { executeBash: async (ctx, code) => { ranWith = { ctx, code }; return { output: 'ok' }; } };
    const bash = rt.makeFileHelpers(dir, ui, confirmAction, { engine: bashEngine, getContext: () => ({ marker: 1, userDirectory: '/elsewhere' }) });
    answer = false;
    const denied = await bash.executeBash('echo hi');
    ok('a denied bash command is not executed', denied === false && ranWith === null);
    answer = true;
    const allowed = await bash.executeBash('echo hi');
    ok('an accepted bash command runs through the engine', allowed && allowed.output === 'ok' && ranWith.code === 'echo hi');
    ok('bash runs in the helpers\' base directory with the turn context', ranWith.ctx.userDirectory === dir && ranWith.ctx.marker === 1);

    fs.rmSync(dir, { recursive: true, force: true });
}

// cleanup
process.env.HOME = REAL_HOME;
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
