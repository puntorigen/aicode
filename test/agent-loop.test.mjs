// Offline verification for multi-step agent loops (no network, mock model).
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { tool } from 'ai';
import { z } from 'zod';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Code2Prompt = require('../lib/engine');
const models = require('../lib/models');
const agents = require('../lib/agents');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };

// --- scripted mock model -----------------------------------------------------
function scriptedModel(steps) {
    let i = 0;
    return new MockLanguageModelV3({
        doStream: async () => {
            const parts = steps[Math.min(i, steps.length - 1)];
            i++;
            return { stream: convertArrayToReadableStream(parts) };
        },
    });
}
const finish = (reason, u = { inputTokens: 5, outputTokens: 3, totalTokens: 8 }) => ({ type: 'finish', finishReason: reason, usage: u });

// override provider plumbing so the engine uses our mock (pick the first remaining
// preference so provider-fallback can't loop forever if something throws)
let MOCK = null;
models.resolveProvider = (prefs) => (prefs && prefs.length ? prefs[0] : null);
models.createModel = () => MOCK;
models.callOptions = () => ({});
models.modelId = () => 'mock-model';
models.estimateCost = () => 0;
models.estimateTokens = () => 10;

function makeEngine() {
    return new Code2Prompt({ template: path.join(ROOT, 'actions', 'default.md'), OPENAI_KEY: 'test' });
}

// =============================================================================
// Part A — runAgentLoop executes tools, streams text, records per-step usage
// =============================================================================
async function testLoop() {
    console.log('\n[A] runAgentLoop with a scripted tool call');
    const engine = makeEngine();
    Code2Prompt.resetUsage();
    let echoed = null;
    const tools = {
        echo: tool({
            description: 'echo', inputSchema: z.object({ msg: z.string() }),
            execute: async ({ msg }) => { echoed = msg; return { echoed: msg }; },
        }),
    };
    MOCK = scriptedModel([
        [
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'a', modelId: 'mock' },
            { type: 'tool-input-start', id: 'c1', toolName: 'echo' },
            { type: 'tool-input-delta', id: 'c1', delta: '{"msg":"hello"}' },
            { type: 'tool-input-end', id: 'c1' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'echo', input: '{"msg":"hello"}' },
            finish('tool-calls'),
        ],
        [
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'b', modelId: 'mock' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'All ' },
            { type: 'text-delta', id: 't1', delta: 'done.' },
            { type: 'text-end', id: 't1' },
            finish('stop'),
        ],
    ]);
    const events = [];
    let streamed = '';
    const res = await engine.runAgentLoop({
        messages: [{ role: 'user', content: 'say hello' }],
        system: 'you are a test agent',
        tools,
        onText: (t) => { streamed += t; },
        onEvent: (p) => events.push(p),
    });
    ok('tool was executed with parsed input', echoed === 'hello');
    ok('final text returned', res.text === 'All done.');
    ok('text streamed via onText', streamed === 'All done.');
    ok('tool-call event emitted', events.some((e) => e.type === 'tool-call' && e.toolName === 'echo'));
    ok('tool-result event emitted', events.some((e) => e.type === 'tool-result' && e.toolName === 'echo'));
    ok('per-step usage recorded (2 steps)', Code2Prompt.getUsage().calls === 2);
}

// =============================================================================
// Part B — runAgent composes system (agent body + memory) and prepends history
// =============================================================================
async function testMemoryAndHistory() {
    console.log('\n[B] runAgent system-prompt composition + session history');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-agent-'));
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'Always use CONVENTION_X here.');
    fs.mkdirSync(path.join(tmp, '.aicode'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.aicode', 'memory.md'), '- (2026-01-01) MEMO_Y is the test command');

    const engine = makeEngine();
    let captured = null;
    engine.runAgentLoop = async ({ system, messages }) => { captured = { system, messages }; return { text: 'ANSWER' }; };

    const ui = { step: () => ({ done() { }, fail() { }, update() { } }), streamChunk() { }, streamEnd() { }, status() { }, statusStop() { }, isStreaming: () => false };
    const ctx = {
        userDirectory: tmp, language: 'English', personality: 'friendly-and-concise',
        readFile: async (f) => fs.readFileSync(path.join(tmp, f), 'utf8'),
        writeFile: async () => true, editFile: async () => ({ ok: true, applied: 1 }),
        executeBash: async () => ({ output: 'ok' }), ask: async () => 'yes',
    };
    const defs = await agents.loadAgents();
    const text = await agents.runAgent({
        engine, agentName: 'main', agents: defs, task: 'do X',
        ctx, ui, depth: 0, streamAnswer: false,
        history: [{ role: 'user', content: 'prev Q' }, { role: 'assistant', content: 'prev A' }],
    });
    ok('returns loop answer', text === 'ANSWER');
    ok('system includes agent body', /orchestrator/i.test(captured.system));
    ok('system injects AGENTS.md', captured.system.includes('CONVENTION_X'));
    ok('system injects .aicode/memory.md', captured.system.includes('MEMO_Y'));
    ok('system includes personality tone', captured.system.includes('friendly-and-concise'));
    ok('history prepended to messages', captured.messages.length === 3 && captured.messages[0].content === 'prev Q');
    ok('task is the last message', captured.messages[2].content === 'do X');

    // a pre-selected skill is injected into the system prompt so the agent follows it
    captured = null;
    await agents.runAgent({
        engine, agentName: 'main', agents: defs, task: 'do X', ctx, ui, depth: 0, streamAnswer: false,
        skill: { name: 'demo-skill', dir: '/tmp/demo-skill', body: 'Step 1: do SKILL_STEP_ABC.', files: ['/tmp/demo-skill/scripts/run.sh'] },
    });
    ok('system injects active skill name', /Active skill: demo-skill/.test(captured.system));
    ok('system injects skill instructions', captured.system.includes('SKILL_STEP_ABC'));
    ok('system lists bundled skill files', captured.system.includes('/tmp/demo-skill/scripts/run.sh'));

    return tmp;
}

// =============================================================================
// Part C — tool whitelist filtering + delegate depth cap + remember append
// =============================================================================
async function testToolsAndDelegate(tmp) {
    console.log('\n[C] tool whitelisting, delegate depth cap, remember append');
    const engine = makeEngine();
    const defs = await agents.loadAgents();
    const ui = { step: () => ({ done() { }, fail() { } }) };
    const ctx = {
        userDirectory: tmp,
        readFile: async (f) => fs.readFileSync(path.join(tmp, f), 'utf8'),
        writeFile: async (f, content) => { fs.writeFileSync(path.join(tmp, f), content); return true; },
        executeBash: async () => ({ output: 'ok' }), ask: async () => 'y', editFile: async () => ({ ok: true, applied: 1 }),
    };

    const rt0 = { engine, ctx, ui, agents: defs, depth: 0, cwd: tmp };
    const mainTools = agents.buildTools(rt0, defs.main.tools);
    ok('main has delegate', !!mainTools.delegate);
    ok('main has remember', !!mainTools.remember);
    ok('main has write_file', !!mainTools.write_file);

    const expTools = agents.buildTools(rt0, defs.explorer.tools);
    ok('explorer has read_file', !!expTools.read_file);
    ok('explorer has NO write_file', !expTools.write_file);
    ok('explorer has NO delegate', !expTools.delegate);

    // delegate depth cap: at MAX_DEPTH the delegate tool refuses
    const rtDeep = { engine, ctx, ui, agents: defs, depth: agents.MAX_DEPTH, cwd: tmp };
    const deepTools = agents.buildTools(rtDeep, ['delegate']);
    const capRes = await deepTools.delegate.execute({ agent: 'coder', task: 'x' });
    ok('delegate blocked at max depth', capRes && capRes.error && /depth/i.test(capRes.error));

    // delegate to unknown agent is rejected
    const unknownRes = await mainTools.delegate.execute({ agent: 'nope', task: 'x' });
    ok('delegate rejects unknown agent', unknownRes && unknownRes.error && /unknown/i.test(unknownRes.error));

    // remember appends a dated bullet through the (test) confirm-gated writeFile
    const memTools = agents.buildTools(rt0, ['remember']);
    const remRes = await memTools.remember.execute({ note: 'run npm test to verify' });
    const mem = fs.readFileSync(path.join(tmp, '.aicode', 'memory.md'), 'utf8');
    ok('remember succeeded', remRes === 'remembered');
    ok('memory file contains the note', mem.includes('run npm test to verify'));
    ok('memory note is dated', /- \(\d{4}-\d{2}-\d{2}\)/.test(mem));
}

// =============================================================================
// Part D — a real sub-agent delegation round-trip (mock model, depth 0 -> 1)
// =============================================================================
async function testDelegationRoundTrip() {
    console.log('\n[D] orchestrator delegates to a sub-agent (mock round-trip)');
    const engine = makeEngine();
    Code2Prompt.resetUsage();
    const defs = await agents.loadAgents();
    const ui = { step: () => ({ done() { }, fail() { }, update() { } }), streamChunk() { }, streamEnd() { }, status() { }, statusStop() { }, isStreaming: () => false };
    const ctx = {
        userDirectory: ROOT, language: 'English', personality: '',
        readFile: async () => 'x', writeFile: async () => true, editFile: async () => ({ ok: true, applied: 1 }),
        executeBash: async () => ({ output: 'ok' }), ask: async () => 'y',
    };
    // Script: main step1 -> delegate(explorer); explorer step1 -> text; main step2 -> final text.
    // Loops share this model; the call sequence is deterministic because delegate
    // runs to completion (its own loop) before the orchestrator's next step.
    MOCK = scriptedModel([
        [ // main: call delegate
            { type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: 'm1', modelId: 'mock' },
            { type: 'tool-input-start', id: 'd1', toolName: 'delegate' },
            { type: 'tool-input-delta', id: 'd1', delta: '{"agent":"explorer","task":"find the entrypoint"}' },
            { type: 'tool-input-end', id: 'd1' },
            { type: 'tool-call', toolCallId: 'd1', toolName: 'delegate', input: '{"agent":"explorer","task":"find the entrypoint"}' },
            finish('tool-calls'),
        ],
        [ // explorer: answer directly
            { type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: 'e1', modelId: 'mock' },
            { type: 'text-start', id: 'x1' }, { type: 'text-delta', id: 'x1', delta: 'entrypoint is index.js' }, { type: 'text-end', id: 'x1' },
            finish('stop'),
        ],
        [ // main: final answer
            { type: 'stream-start', warnings: [] }, { type: 'response-metadata', id: 'm2', modelId: 'mock' },
            { type: 'text-start', id: 'f1' }, { type: 'text-delta', id: 'f1', delta: 'Done: the entrypoint is index.js.' }, { type: 'text-end', id: 'f1' },
            finish('stop'),
        ],
    ]);
    let streamed = '';
    const text = await agents.runAgent({
        engine, agentName: 'main', agents: defs, task: 'where does the app start?',
        ctx, ui: { ...ui, streamChunk: (t) => { streamed += t; } }, depth: 0, streamAnswer: true,
    });
    ok('orchestrator produced a final answer', /entrypoint is index\.js/.test(text));
    ok('final answer streamed', /entrypoint is index\.js/.test(streamed));
    ok('usage recorded across nested loops (>=3 steps)', Code2Prompt.getUsage().calls >= 3);
}

(async () => {
    try {
        await testLoop();
        const tmp = await testMemoryAndHistory();
        await testToolsAndDelegate(tmp);
        await testDelegationRoundTrip();
        console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
        process.exit(failures === 0 ? 0 : 1);
    } catch (e) {
        console.error('\nTEST ERROR:', e);
        process.exit(1);
    }
})();
