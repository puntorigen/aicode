// Offline checks for lib/runtime.js: the per-session pipeline extracted from
// index.js. A scripted mock model plays the router (generateObject) and the
// answer/agent loop (streamText); nothing touches the network or the real HOME.
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
// what each model creation asked for: provider, tier and the model/effort the engine config carried
const CREATED = [];
models.resolveProvider = (prefs) => (prefs && prefs.length ? prefs[0] : null);
models.createModel = (provider, tier, config = {}) => {
    CREATED.push({ provider, tier, model: config[`${provider}_MODEL`], effort: config[`${provider}_EFFORT`] });
    return MOCK;
};
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

// =============================================================================
// [H] the model the user picked: chip, remembered default, engine routing
// =============================================================================
console.log('\n[H] model selection');
{
    const { applyModelSelection } = require('../lib/runtime');
    const config = require('../lib/config');
    const openrouter = require('../lib/openrouter');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const KIMI = { provider: 'OPENROUTER', model: 'moonshotai/kimi-k3', effort: 'max' };
    const GPT = { provider: 'OPENAI', model: 'gpt-5.5', effort: null };
    const template = path.join(ROOT, 'actions', 'default.md');
    const remember = (models_) => config.saveConfig({ models: { selected: null, recent: [], fallbackOnError: false, ...models_ } });
    remember({});

    // the catalog gives the picked model its display name
    const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'openrouter-models.json'), 'utf8'));
    fs.mkdirSync(path.dirname(openrouter.cacheFile()), { recursive: true });
    fs.writeFileSync(openrouter.cacheFile(), JSON.stringify({ fetchedAt: new Date().toISOString(), models: fixture.data.map(openrouter.normalizeModel).filter(Boolean) }));

    // --- the chip without a pick walks the default provider order
    const keys = { OPENROUTER_KEY: 'k', ANTHROPIC_KEY: 'k', OPENAI_KEY: 'k', GROQ_KEY: 'k' };
    const rt = createRuntime({ cwd: PROJECT, keysData: keys, flags: {} });
    ok('no pick: OpenRouter is the first provider with credentials', rt.describeProvider().provider === 'openrouter');
    keys.OPENROUTER_KEY = '';
    ok('...then Anthropic', rt.describeProvider().provider === 'anthropic');
    keys.ANTHROPIC_KEY = '';
    ok('...then OpenAI', rt.describeProvider().provider === 'openai');
    keys.OPENAI_KEY = '';
    ok('...then Groq', rt.describeProvider().provider === 'groq');
    keys.OPENROUTER_KEY = 'k'; keys.ANTHROPIC_KEY = 'k'; keys.OPENAI_KEY = 'k';

    // --- a pick shows its short name, MAX only for max
    rt.flags.model = KIMI;
    ok('a pick drives the chip: short name and MAX', same(rt.describeProvider(), { provider: 'openrouter', model: 'Kimi K3 MAX' }));
    rt.flags.model = { ...KIMI, effort: 'high' };
    ok('...MAX only for the max effort', rt.describeProvider().model === 'Kimi K3');
    rt.flags.model = GPT;
    ok('...and a built-in model shows its id', same(rt.describeProvider(), { provider: 'openai', model: 'gpt-5.5' }));
    rt.flags.model = KIMI;
    keys.LOCAL_BASE_URL = 'http://localhost:1/v1'; keys.LOCAL_MODEL = 'llama-test';
    rt.flags.local = true;
    ok('--local beats the pick in the chip', same(rt.describeProvider(), { provider: 'local', model: 'llama-test' }));
    rt.flags.local = false;
    rt.flags.model = null;
    ok('clearing the pick returns to the default order', rt.describeProvider().provider === 'openrouter');
    delete keys.LOCAL_BASE_URL; delete keys.LOCAL_MODEL;

    // --- the remembered default seeds new runtimes
    remember({ selected: KIMI });
    const seeded = createRuntime({ cwd: PROJECT, keysData: { OPENROUTER_KEY: 'k' }, flags: {} });
    ok('the remembered selection seeds flags.model', same(seeded.flags.model, KIMI) && same(seeded.describeProvider(), { provider: 'openrouter', model: 'Kimi K3 MAX' }));
    ok('...only while its provider still has credentials', createRuntime({ cwd: PROJECT, keysData: { OPENAI_KEY: 'k' }, flags: {} }).flags.model === null);
    const explicit = { model: GPT };
    ok('...and never over a pick the caller made', createRuntime({ cwd: PROJECT, keysData: { OPENROUTER_KEY: 'k', OPENAI_KEY: 'k' }, flags: explicit }).flags.model === GPT);
    ok('...a flags.model that is already null is seeded too', same(createRuntime({ cwd: PROJECT, keysData: { OPENROUTER_KEY: 'k' }, flags: { model: null } }).flags.model, KIMI));
    remember({ selected: null });
    ok('without a remembered selection nothing is seeded', createRuntime({ cwd: PROJECT, keysData: { OPENROUTER_KEY: 'k' }, flags: {} }).flags.model === null);
    remember({ selected: { provider: 'NOPE', model: 'x', effort: null } });
    ok('a damaged remembered selection is ignored', createRuntime({ cwd: PROJECT, keysData: { OPENROUTER_KEY: 'k' }, flags: {} }).flags.model === null);
    remember({ selected: null });

    // --- applyModelSelection routes an engine to the pick
    const engine = () => rt.codePrompt(template);
    let e = engine();
    ok('an engine starts on the default order', same(e.modelPreferences, models.DEFAULT_PROVIDER_ORDER));
    applyModelSelection(e, KIMI, keys);
    ok('the pick leaves exactly one provider (no silent fallback)', same(e.modelPreferences, ['OPENROUTER']));
    ok('...with its model and effort in the engine config', e.config.OPENROUTER_MODEL === 'moonshotai/kimi-k3' && e.config.OPENROUTER_EFFORT === 'max');
    e = engine();
    applyModelSelection(e, { ...KIMI, effort: null }, keys);
    ok('a null effort resets the effort override too', e.config.OPENROUTER_EFFORT === null);
    e = engine();
    applyModelSelection(e, GPT, keys);
    ok('a built-in provider gets its model override', same(e.modelPreferences, ['OPENAI']) && e.config.OPENAI_MODEL === 'gpt-5.5');
    e = engine();
    keys.LOCAL_BASE_URL = 'http://localhost:1/v1'; keys.LOCAL_MODEL = 'llama-test'; keys.LOCAL_FAST_MODEL = 'llama-fast';
    const localEngine = rt.codePrompt(template);
    applyModelSelection(localEngine, { provider: 'LOCAL', model: 'llama-big', effort: 'high' }, keys);
    ok('LOCAL swaps the model and keeps the fast model as configured', localEngine.config.LOCAL_MODEL === 'llama-big' && localEngine.config.LOCAL_EFFORT === 'high' && localEngine.config.LOCAL_FAST_MODEL === 'llama-fast');
    delete keys.LOCAL_BASE_URL; delete keys.LOCAL_MODEL; delete keys.LOCAL_FAST_MODEL;
    const refused = (() => { try { applyModelSelection(engine(), { provider: 'GROQ', model: 'x', effort: null }, { OPENROUTER_KEY: 'k' }); return null; } catch (err) { return err; } })();
    ok('a provider without credentials is refused', refused instanceof Error && refused.message === 'no credentials for GROQ');
    remember({ fallbackOnError: true });
    e = engine();
    applyModelSelection(e, GPT, keys);
    ok('fallbackOnError keeps the rest of the default order behind the pick', same(e.modelPreferences, ['OPENAI', 'OPENROUTER', 'ANTHROPIC', 'GROQ', 'LOCAL']));
    remember({ fallbackOnError: false });

    // --- a whole turn runs on the pick
    const run = async (flags, runKeys, opts, input = 'say hello') => {
        CREATED.length = 0;
        MOCK = makeMock().model;
        const turn = createRuntime({ cwd: PROJECT, keysData: runKeys, flags: { mode: 'agent', ...flags } });
        const ui = makeUI();
        await turn.runPrompt(input, ui, opts);
        return { ui, created: CREATED.slice() };
    };
    let turn = await run({ model: KIMI }, { OPENROUTER_KEY: 'k', OPENAI_KEY: 'k' });
    ok('every call of the turn goes to the picked provider', turn.created.length >= 2 && turn.created.every((c) => c.provider === 'OPENROUTER'));
    ok('...the answer runs on the picked model and effort', turn.created.filter((c) => c.tier === 'smart').every((c) => c.model === 'moonshotai/kimi-k3' && c.effort === 'max') && turn.created.some((c) => c.tier === 'smart'));
    ok('...and the quick analysis uses the fast tier of that provider', turn.created.some((c) => c.tier === 'fast'));
    ok('...without errors', !has(turn.ui, 'error') && has(turn.ui, 'footer') && turn.ui.streamed === 'Hello from the mock.');
    turn = await run({ model: KIMI }, { OPENROUTER_KEY: 'k', OPENAI_KEY: 'k' }, { model: GPT });
    ok('opts.model beats flags.model for one turn', turn.created.length >= 2 && turn.created.every((c) => c.provider === 'OPENAI') && turn.created.filter((c) => c.tier === 'smart').every((c) => c.model === 'gpt-5.5'));
    turn = await run({ model: KIMI, local: true }, { LOCAL_BASE_URL: 'http://localhost:1/v1', LOCAL_MODEL: 'llama-test', OPENROUTER_KEY: 'k' });
    ok('--local ignores the pick', turn.created.length >= 2 && turn.created.every((c) => c.provider === 'LOCAL'));
    turn = await run({ model: KIMI, modelPreferences: ['OPENAI'] }, { OPENROUTER_KEY: 'k', OPENAI_KEY: 'k' });
    ok('a modelPreferences flag does not override the pick', turn.created.every((c) => c.provider === 'OPENROUTER'));
    turn = await run({ model: null, modelPreferences: ['OPENAI'] }, { OPENROUTER_KEY: 'k', OPENAI_KEY: 'k' });
    ok('...but it still applies without a pick', turn.created.length >= 2 && turn.created.every((c) => c.provider === 'OPENAI'));
    turn = await run({ model: { provider: 'GROQ', model: 'x', effort: null } }, { OPENROUTER_KEY: 'k' });
    ok('a pick whose key is gone ends the turn with an error instead of throwing', has(turn.ui, 'error', (e_) => e_[1] === 'no credentials for GROQ') && has(turn.ui, 'footer') && turn.created.length === 0);
}

// =============================================================================
// [I] what a template's setModelPreferences does
// =============================================================================
console.log('\n[I] template model preferences');
{
    const { applyTemplatePreferences } = require('../lib/runtime');
    const keysLib = require('../lib/keys');
    const EncryptedJsonDB = require('../helpers/db');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const template = path.join(ROOT, 'actions', 'default.md');
    const ORDER = ['OPENAI', 'ANTHROPIC', 'GROQ'];
    const rig = (keysData = {}, { answer = '', canAsk = true, canAskSecrets } = {}) => {
        const asked = [];
        const ui = canAsk ? { ask: async (q) => { asked.push(q); return answer; } } : {};
        if (canAskSecrets !== undefined) ui.canAskSecrets = canAskSecrets;
        const engine = new Code2Prompt({ template, ...keysData });
        return { engine, ui, asked, keysData };
    };
    const apply = (r, extra = {}) => applyTemplatePreferences(r.engine, ORDER, { keysData: r.keysData, ui: r.ui, ...extra });

    let r = rig({ OPENROUTER_KEY: 'k' });
    ok('the template order goes first, credentialed providers it did not name follow', (await apply(r)) === true && same(r.engine.modelPreferences, ['OPENAI', 'ANTHROPIC', 'GROQ', 'OPENROUTER']) && r.asked.length === 0);
    r = rig({ OPENROUTER_KEY: 'k' });
    await apply(r, { local: true });
    ok('--local ignores the template order', same(r.engine.modelPreferences, models.DEFAULT_PROVIDER_ORDER) && r.asked.length === 0);
    r = rig({ OPENROUTER_KEY: 'k' });
    await apply(r, { selection: { provider: 'OPENROUTER', model: 'x/y', effort: null } });
    ok('a picked model wins over the template order', same(r.engine.modelPreferences, models.DEFAULT_PROVIDER_ORDER) && r.asked.length === 0);

    r = rig({});
    ok('nothing can serve the request: the first named provider without a key is asked for', (await apply(r)) === true && r.asked.length === 1 && r.asked[0] === 'Enter your *OPENAI API key* (or empty if none):');
    r = rig({}, { answer: '  sk-brand-new-key-123456  ' });
    await apply(r);
    const stored = new EncryptedJsonDB('keys.json').load();
    ok('an answer is trimmed, stored for later runs and handed to the engine', r.keysData.OPENAI_KEY === 'sk-brand-new-key-123456' && stored.OPENAI_KEY === 'sk-brand-new-key-123456' && r.engine.config.OPENAI_KEY === 'sk-brand-new-key-123456' && r.asked.length === 1);
    keysLib.removeKey('openai', r.keysData);
    r = rig({}, { answer: '   ' });
    await apply(r);
    ok('an empty answer stores nothing', r.keysData.OPENAI_KEY === undefined && (new EncryptedJsonDB('keys.json').load().OPENAI_KEY === undefined) && r.asked.length === 1);
    r = rig({ GROQ_KEY: 'k' });
    await apply(r);
    ok('a key for any listed provider is enough: no question', r.asked.length === 0);
    r = rig({}, { canAsk: false });
    ok('a client without ask is never asked', (await apply(r)) === true && r.asked.length === 0);
    r = rig({}, { canAskSecrets: false });
    ok('a client that cannot take secrets is never asked', (await apply(r)) === true && r.asked.length === 0);
    r = rig({});
    await applyTemplatePreferences(r.engine, ['ANTHROPIC'], { keysData: r.keysData, ui: r.ui });
    ok('only the providers the template names are asked for', r.asked.length === 1 && r.asked[0].includes('ANTHROPIC'));
    r = rig({});
    await applyTemplatePreferences(r.engine, ['OPENROUTER'], { keysData: r.keysData, ui: r.ui });
    ok('OpenRouter is never asked for here (it has its own flow)', r.asked.length === 0);
    keysLib.removeKey('anthropic', r.keysData);
}

// cleanup
process.env.HOME = REAL_HOME;
fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
