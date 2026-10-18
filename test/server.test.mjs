// Offline checks for the Agent Server (lib/server/*): handshake and transport
// security, the protocol, the UI adapter, sessions (turns, prompts, cancel,
// persistence, resume) and the IDE bridge. Most scenarios use a scripted stub
// runtime; the last section drives the real runtime with a mock model. Nothing
// touches the network or the real HOME.
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';

const require = createRequire(import.meta.url);

// isolate HOME (keys.json, config.json, ~/.aicode/projects) before anything resolves it
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-srv-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-srv-project-'));
fs.writeFileSync(path.join(PROJECT, 'hello.js'), 'console.log("hello");\n');

const WebSocket = require('ws');
const config = require('../lib/config');
const { startAgentServer } = require('../lib/server');
const { makeWsAdapter, makeRedactor, toWire } = require('../lib/server/adapter');
const { projectSlug } = require('../lib/conversations');
const pkg = require('../package.json');

let failures = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ok  ' : ' FAIL '}${name}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN = 'test-token-0123456789abcdef';
const SECRET = 'sk-test-secret-value-12345';
const USAGE = { model: 'stub', models: { stub: 1 }, inputTokens: 1, outputTokens: 2, cost: 0, calls: 1 };

// -----------------------------------------------------------------------------
// client helper: a ws connection with an ordered inbox and promise-based waits
// -----------------------------------------------------------------------------
function connect(url, wsOptions = {}) {
    const ws = new WebSocket(url, wsOptions);
    const inbox = [];
    const waiters = new Set();
    let cursor = 0;
    ws.on('message', (data) => { inbox.push(JSON.parse(data.toString())); for (const check of [...waiters]) check(); });
    const closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    const opened = new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
    const client = {
        ws, inbox, opened, closed,
        send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
        // the next message at or after the cursor that satisfies `pred`
        next: (pred = () => true, ms = 5000) => new Promise((resolve, reject) => {
            let timer = null;
            const check = () => {
                for (let i = cursor; i < inbox.length; i++) {
                    if (pred(inbox[i])) { cursor = i + 1; waiters.delete(check); clearTimeout(timer); resolve(inbox[i]); return true; }
                }
                return false;
            };
            timer = setTimeout(() => {
                waiters.delete(check);
                reject(new Error(`timed out waiting for a message; pending inbox: [${inbox.slice(cursor).map((m) => m.type).join(', ')}]`));
            }, ms);
            if (!check()) waiters.add(check);
        }),
        // every message from the cursor through the first one satisfying `pred`
        until: async (pred, ms) => {
            const start = cursor;
            await client.next(pred, ms);
            return inbox.slice(start, cursor);
        },
        // messages that arrived so far and have not been consumed yet
        pending: () => inbox.slice(cursor),
        close: () => { try { ws.close(); } catch (e) { /* closed */ } return closed; },
    };
    return client;
}
const type = (t) => (m) => m.type === t;
const types = (list) => list.map((m) => m.type);

// -----------------------------------------------------------------------------
// stub runtime: scripted per scenario through `behavior.run`
// -----------------------------------------------------------------------------
const runtimes = [];
const stub = { provider: { provider: 'stub', model: 'stub-1' } };
const behavior = { run: null, orvix: null };
const echo = async (input, ui) => {
    const step = ui.step('thinking');
    step.update('still thinking');
    step.done('ok');
    ui.streamStart(); ui.streamChunk('Echo: '); ui.streamChunk(input); ui.streamEnd();
    ui.footer({ inputTokens: 1, outputTokens: 2, cost: 0, elapsedMs: 5 });
    return USAGE;
};
const factory = (cwd, flags, extras) => {
    const rt = {
        cwd, flags, extras, calls: [],
        ...(behavior.orvix ? { orvix: behavior.orvix } : {}),
        keysData: { OPENAI_KEY: SECRET, LOCAL_BASE_URL: '', LOCAL_MODEL: '' },
        describeProvider: () => stub.provider,
        usage: () => null,
        runPrompt: async (input, ui, opts) => {
            rt.calls.push({ input, opts });
            return await (behavior.run || echo)(input, ui, opts, rt);
        },
    };
    runtimes.push(rt);
    return rt;
};
const start = (extra = {}) => startAgentServer({ token: TOKEN, runtimeFactory: factory, ...extra });
async function login(server, client = 'test') {
    const c = connect(server.url);
    await c.opened;
    c.send({ type: 'hello', token: TOKEN, client, version: 'test' });
    await c.next(type('hello.ok'));
    return c;
}
async function newSession(c, flags, cwd = PROJECT) {
    c.send({ type: 'session.create', cwd, ...(flags ? { flags } : {}) });
    return await c.next((m) => m.type === 'session.created' || m.type === 'error');
}
// send an input and collect everything up to the turn's end (session.done / session.error)
async function turn(c, sessionId, text, extra = {}) {
    c.send({ type: 'session.input', sessionId, text, ...extra });
    return await c.until((m) => m.type === 'session.done' || (m.type === 'session.error' && m.sessionId === sessionId));
}
const lastRuntime = () => runtimes[runtimes.length - 1];
const sessionFile = (id, cwd = PROJECT) => path.join(TMP_HOME, '.aicode', 'projects', projectSlug(cwd), 'sessions', `${id}.jsonl`);
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// =============================================================================
// [A] the UI adapter on its own
// =============================================================================
console.log('\n[A] adapter: UI interface -> protocol messages');
{
    const sent = [];
    let debugOn = false;
    const pending = new Map();
    const ui = makeWsAdapter((m) => sent.push(m), 'sess-1', { isDebug: () => debugOn, pendingPrompts: pending });
    const take = () => sent.splice(0, sent.length);

    ok('every UI interface method exists', ['header', 'footer', 'step', 'status', 'statusStart', 'statusStop', 'streamStart', 'streamChunk', 'streamEnd', 'isStreaming', 'answer', 'markdown', 'raw', 'note', 'debug', 'diff', 'fileWritten', 'error', 'confirm', 'select', 'ask', 'progressShim', 'dispose', 'colorize', 'renderMarkdown', 'planCreated', 'getLastAnswer', 'resetAnswer'].every((k) => typeof ui[k] === 'function'));
    ok('colorize and renderMarkdown pass text through', ui.colorize('*x*') === '*x*' && ui.renderMarkdown('# t') === '# t');

    ui.header({ name: 'aicode' }); ui.footer({ inputTokens: 3 });
    let [header, footer] = take();
    ok('header/footer carry the session id', header.type === 'ui.header' && header.sessionId === 'sess-1' && header.info.name === 'aicode' && footer.type === 'ui.footer' && footer.usage.inputTokens === 3);

    const step = ui.step('doing *work*');
    step.update('still working'); step.done('3 files'); step.done('again'); step.fail('late');
    let msgs = take();
    ok('a step emits start, update and exactly one end', JSON.stringify(types(msgs)) === JSON.stringify(['ui.step.start', 'ui.step.update', 'ui.step.end']));
    ok('step ids are s$n and every message carries sessionId', msgs[0].stepId === 's1' && msgs.every((m) => m.sessionId === 'sess-1') && msgs[1].stepId === 's1' && msgs[2].stepId === 's1');
    ok('step.end: ok, label, elapsed (seconds with one decimal), extra', msgs[2].ok === true && msgs[2].label === 'doing *work*' && /^\d+\.\d$/.test(msgs[2].elapsed) && msgs[2].extra === '3 files');
    ok('update carries the new label', msgs[1].label === 'still working');
    const failing = ui.step('second'); failing.fail('boom');
    msgs = take();
    ok('fail ends with ok:false and the failure text as label; ids increment', msgs[0].stepId === 's2' && msgs[1].ok === false && msgs[1].label === 'boom');
    const withMeta = ui.step('meta step', 'default extra'); withMeta.done();
    msgs = take();
    ok('done() falls back to the step meta as extra', msgs[1].extra === 'default extra');

    ui.status('a'); ui.statusStart('b'); ui.statusStop();
    msgs = take();
    ok('status/statusStart -> ui.status, statusStop -> ui.status.stop', msgs[0].text === 'a' && msgs[1].type === 'ui.status' && msgs[1].text === 'b' && msgs[2].type === 'ui.status.stop');
    const shim = ui.progressShim(); shim.text('t'); shim.start(); shim.stop();
    msgs = take();
    ok('progressShim is wired to status*', JSON.stringify(types(msgs)) === JSON.stringify(['ui.status', 'ui.status', 'ui.status.stop']) && msgs[0].text === 't');

    ok('not streaming before a stream starts', ui.isStreaming() === false);
    ui.streamStart();
    ok('isStreaming is true while a stream is open', ui.isStreaming() === true);
    ui.streamChunk('Hel'); ui.streamChunk('lo'); ui.streamChunk('');
    ui.streamEnd();
    msgs = take();
    ok('streamStart/chunk/end emit in order; empty chunks are dropped', JSON.stringify(types(msgs)) === JSON.stringify(['ui.stream.start', 'ui.stream.chunk', 'ui.stream.chunk', 'ui.stream.end']));
    ok('ui.stream.end carries the accumulated text', msgs[3].text === 'Hello' && ui.getLastAnswer() === 'Hello' && ui.isStreaming() === false);
    ui.streamStart(); ui.streamEnd();
    ui.streamChunk('  \n'); ui.streamEnd();
    ok('an empty or blank stream emits no ui.stream.end and keeps the last answer', !types(take()).includes('ui.stream.end') && ui.getLastAnswer() === 'Hello');
    ui.streamChunk('auto-started'); 
    ok('a chunk without streamStart opens the stream', types(take()).join() === 'ui.stream.start,ui.stream.chunk' && ui.isStreaming());
    ui.streamEnd(); take();

    ui.resetAnswer();
    ok('resetAnswer clears the last answer', ui.getLastAnswer() === '');
    ui.answer('plain', { markdown: false }); ui.answer('  ');
    ok('answer() records non-blank text and flags markdown', ui.getLastAnswer() === 'plain');
    msgs = take();
    ok('ui.answer carries text and the markdown flag', msgs[0].type === 'ui.answer' && msgs[0].text === 'plain' && msgs[0].markdown === false);
    ui.markdown('# md'); msgs = take();
    ok('markdown() records the answer and emits ui.markdown', ui.getLastAnswer() === '# md' && msgs[0].type === 'ui.markdown' && msgs[0].text === '# md');
    ui.answer('x', { markdown: true }); ok('answer markdown flag true', take()[0].markdown === true);

    ui.raw('line'); ui.note('hi', { a: 1 }, 'green'); ui.note('default color');
    msgs = take();
    ok('raw and note messages', msgs[0].type === 'ui.raw' && msgs[0].text === 'line' && msgs[1].message === 'hi' && msgs[1].data.a === 1 && msgs[1].color === 'green' && msgs[2].color === 'cyan');
    ui.debug('hidden', { x: 1 });
    ok('debug is silent unless the session flag is on', take().length === 0);
    debugOn = true;
    ui.debug('shown', { x: 1 }); msgs = take();
    ok('debug is emitted when enabled', msgs.length === 1 && msgs[0].type === 'ui.debug' && msgs[0].message === 'shown' && msgs[0].data.x === 1);

    ui.diff('a.txt', 'old', 'new');
    msgs = take();
    ok('diff -> ui.diff with a d$n id', msgs[0].type === 'ui.diff' && msgs[0].diffId === 'd1' && msgs[0].file === 'a.txt' && msgs[0].oldText === 'old' && msgs[0].newText === 'new' && ui.lastDiffId === 'd1');
    ui.fileWritten('a.txt', { created: true, lines: 4 });
    msgs = take();
    ok('fileWritten -> ui.fileWritten and clears lastDiffId', msgs[0].type === 'ui.fileWritten' && msgs[0].created === true && msgs[0].lines === 4 && ui.lastDiffId === null);
    ui.fileWritten('b.txt'); msgs = take();
    ok('fileWritten defaults', msgs[0].created === false && msgs[0].lines === null);
    ui.diff('c.txt', '', 'x'); const s3 = ui.step('after diff'); s3.done(); take();
    ok('a finished step clears lastDiffId', ui.lastDiffId === null);
    ui.diff('c.txt', '', 'x'); ok('diff ids increment', take()[0].diffId === 'd3');
    ui.fileWritten('c.txt'); take();

    const err = new Error('kaput'); ui.error(err); msgs = take();
    ok('error -> ui.error with message and stack', msgs[0].type === 'ui.error' && msgs[0].message === 'kaput' && /Error: kaput/.test(msgs[0].stack));
    ui.error('plain string'); ok('error accepts non-Error values', take()[0].message === 'plain string');
    ui.planCreated({ path: '.aicode/plans/x.plan.md', title: 'X', todos: [{ id: 'a', content: 'do a' }] }); msgs = take();
    ok('planCreated -> plan.created', msgs[0].type === 'plan.created' && msgs[0].path === '.aicode/plans/x.plan.md' && msgs[0].todos.length === 1);

    // prompts resolve through answerPrompt / cancelPrompts
    const pConfirm = ui.confirm('ok?', { initial: false });
    const pSelect = ui.select('pick', [{ title: 'A', value: 'a', description: 'first' }, { value: 'b' }], { initial: 1 });
    const pAsk = ui.ask('name?', { placeholder: 'you' });
    msgs = take();
    ok('prompt requests carry kind, message, ids', JSON.stringify(msgs.map((m) => m.kind)) === JSON.stringify(['confirm', 'select', 'ask']) && msgs.every((m) => m.type === 'prompt.request' && /^p\d+$/.test(m.id)));
    ok('confirm/select/ask extras', msgs[0].initial === false && msgs[1].initial === 1 && msgs[2].placeholder === 'you');
    ok('select choices are normalized to {title,value,description?}', JSON.stringify(msgs[1].choices) === JSON.stringify([{ title: 'A', value: 'a', description: 'first' }, { title: 'b', value: 'b' }]));
    ok('prompt ids are unique', new Set(msgs.map((m) => m.id)).size === 3);
    ok('three prompts are pending', ui.pendingPromptCount() === 3);
    ok('answering an unknown prompt is reported', ui.answerPrompt('nope', true) === false);
    ui.answerPrompt(msgs[0].id, 'yes'); ui.answerPrompt(msgs[1].id, 'zzz'); ui.answerPrompt(msgs[2].id, 'Pablo');
    ok('confirm only accepts a strict true', (await pConfirm) === false);
    ok('select with a value outside the choices resolves null', (await pSelect) === null);
    ok('ask resolves the string', (await pAsk) === 'Pablo');
    ok('answering emits prompt.resolved {cancelled:false}', take().filter((m) => m.type === 'prompt.resolved').every((m) => m.cancelled === false));
    const p1 = ui.confirm('c'); const p2 = ui.select('s', [{ title: 'A', value: 'a' }]); const p3 = ui.ask('a');
    const ids = take().map((m) => m.id);
    ui.answerPrompt(ids[0], true); ui.answerPrompt(ids[1], 'a');
    ok('valid answers resolve true / the chosen value', (await p1) === true && (await p2) === 'a');
    ui.cancelPrompts();
    ok('cancelPrompts resolves the remaining ask with null', (await p3) === null);
    const q1 = ui.confirm('c'); const q2 = ui.select('s', []); const q3 = ui.ask('a'); take();
    ui.cancelPrompts();
    ok('cancelPrompts: confirm -> false, select/ask -> null', (await q1) === false && (await q2) === null && (await q3) === null);
    msgs = take();
    ok('cancelling emits prompt.resolved {cancelled:true} for each', msgs.length === 3 && msgs.every((m) => m.type === 'prompt.resolved' && m.cancelled === true));

    // a diff attaches to the next confirm
    ui.diff('f.js', 'a', 'b'); const dId = ui.lastDiffId;
    const withDiff = ui.confirm('write?'); const req = take().find((m) => m.type === 'prompt.request');
    ok('confirm after a diff carries its diffId', req.diffId === dId);
    ui.answerPrompt(req.id, true); await withDiff; take();
    const noDiff = ui.select('s', [{ title: 'A', value: 'a' }]); const req2 = take().find((m) => m.type === 'prompt.request');
    ok('only confirm prompts carry a diffId', req2.diffId === undefined);
    ui.cancelPrompts(); await noDiff; take();

    // turn output fallback
    ui.resetAnswer();
    ui.note('answer from a template', '', 'cyan'); ui.note('careful', '', 'yellow'); ui.raw('raw line');
    ok('getOutputText joins notes and raw lines but not warnings', ui.getOutputText() === 'answer from a template\n\nraw line');
    ui.resetAnswer();
    ok('resetAnswer also clears the collected output', ui.getOutputText() === '');
    ui.streamStart(); ui.diff('z', '', ''); ui.endTurn(); take();
    ok('endTurn drops a dangling stream and diff', ui.isStreaming() === false && ui.lastDiffId === null);

    // closed sockets never break a turn
    const broken = makeWsAdapter(() => { throw new Error('socket closed'); }, 's');
    let threw = false;
    try { broken.note('x'); broken.step('s').done(); broken.streamChunk('c'); broken.streamEnd(); } catch (e) { threw = true; }
    ok('a throwing send never propagates into the pipeline', !threw);

    // JSON safety + redaction
    const circular = { name: 'c' }; circular.self = circular;
    const wire = toWire({ err: new Error('inner'), circular, buf: Buffer.from('abcd'), fn() { }, big: 10n, nested: { a: { b: { c: { d: { e: { f: 1 } } } } } }, long: 'x'.repeat(9000), when: new Date(0) });
    ok('toWire survives errors, cycles, buffers, functions, bigints and deep nesting', (() => { try { JSON.stringify(wire); } catch (e) { return false; } return wire.circular.self === '[Circular]' && wire.err.message === 'inner' && /Buffer 4 bytes/.test(wire.buf) && wire.big === '10' && wire.long.length < 9000 && wire.when === '1970-01-01T00:00:00.000Z'; })());
    const redactor = makeRedactor(() => ({ OPENAI_KEY: SECRET, SHORT_KEY: 'abc', NOT_SENSITIVE: 'visible-value-123456' }));
    ok('redactor masks key values (length >= 8) in text and nested values', redactor.maskText(`Bearer ${SECRET}!`) === 'Bearer ***!' && redactor.mask({ a: [`x ${SECRET}`], n: 1 }).a[0] === 'x ***' && redactor.maskText('abc stays') === 'abc stays' && redactor.maskText('visible-value-123456') === 'visible-value-123456');
    process.env.AICODE_TEST_SECRET_TOKEN = 'env-secret-abcdefghijkl';
    ok('redactor also masks secrets held in the environment', redactor.maskText('x env-secret-abcdefghijkl y') === 'x *** y');
    delete process.env.AICODE_TEST_SECRET_TOKEN;
}

// =============================================================================
// [B] project slug (names the per-project session directory)
// =============================================================================
console.log('\n[B] projectSlug');
{
    ok('projectSlug: the aicode repo path', projectSlug('/Users/pabloschaffner/Documents/code/aicode') === 'Users-pabloschaffner-Documents-code-aicode');
    ok('projectSlug: every non-alphanumeric becomes a dash', projectSlug('/var/folders/jh/6b23zyrn3nl_8y7x5hyxtpdr0000gn/T/x.y') === 'var-folders-jh-6b23zyrn3nl-8y7x5hyxtpdr0000gn-T-x-y');
}

// =============================================================================
// [C] connection security and transport
// =============================================================================
console.log('\n[C] handshake and transport security');
{
    const server = await start({ helloTimeoutMs: 250 });
    ok('binds loopback and reports its address', /^ws:\/\/127\.0\.0\.1:\d+$/.test(server.url) && server.port > 0 && server.host === '127.0.0.1' && server.url.endsWith(`:${server.port}`));
    ok('returns the token it was given', server.token === TOKEN);
    ok('close is a function', typeof server.close === 'function');

    const silent = connect(server.url); await silent.opened;
    ok('no hello within the timeout closes with 4401', (await silent.closed).code === 4401);

    const wrong = connect(server.url); await wrong.opened;
    wrong.send({ type: 'hello', token: 'not-the-token', client: 'test', version: '1' });
    ok('a wrong token closes with 4401', (await wrong.closed).code === 4401);

    const notHello = connect(server.url); await notHello.opened;
    notHello.send({ type: 'session.list', cwd: PROJECT });
    ok('a first message other than hello closes with 4401', (await notHello.closed).code === 4401);

    const garbage = connect(server.url); await garbage.opened;
    garbage.send('{{ not json');
    ok('an unparsable first message closes with 4401', (await garbage.closed).code === 4401);

    const noToken = connect(server.url); await noToken.opened;
    noToken.send({ type: 'hello', client: 'test', version: '1' });
    ok('hello without a token closes with 4401', (await noToken.closed).code === 4401);

    const good = connect(server.url); await good.opened;
    good.send({ type: 'hello', id: 'h1', token: TOKEN, client: 'test', version: '9.9' });
    const helloOk = await good.next(type('hello.ok'));
    ok('hello -> hello.ok with serverVersion and host', helloOk.serverVersion === pkg.version && helloOk.host === '127.0.0.1');
    ok('hello.ok echoes the request id', helloOk.id === 'h1');
    good.send({ type: 'hello', token: 'anything', client: 'test', version: '1' });
    ok('a second hello on an authenticated connection is answered again', (await good.next(type('hello.ok'))).type === 'hello.ok');
    await sleep(350); // longer than the hello timeout: an authenticated connection stays open
    ok('an authenticated connection survives the hello timeout', good.ws.readyState === WebSocket.OPEN);

    // protocol errors never close the connection
    good.send('{ definitely not json');
    ok('invalid JSON -> error bad_json', (await good.next(type('error'))).code === 'bad_json');
    good.send('[1,2]');
    ok('a non-object message -> error bad_message', (await good.next(type('error'))).code === 'bad_message');
    good.send({ nope: true });
    ok('a message without a type -> error bad_message', (await good.next(type('error'))).code === 'bad_message');
    good.send({ type: 'no.such.message', id: 'u1' });
    const unknown = await good.next(type('error'));
    ok('an unknown type -> error unknown_type (id echoed)', unknown.code === 'unknown_type' && unknown.id === 'u1' && /no\.such\.message/.test(unknown.message));
    good.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    ok('binary frames -> error bad_message', (await good.next(type('error'))).code === 'bad_message');
    ok('still open after all those errors', good.ws.readyState === WebSocket.OPEN);

    // browsers: foreign Origin / Host (DNS rebinding) are refused at the upgrade
    const refused = async (opts) => { const c = connect(server.url, opts); try { await c.opened; c.ws.terminate(); return null; } catch (e) { return e.message; } };
    ok('an upgrade from a foreign Origin is refused (403)', /403/.test(await refused({ origin: 'https://evil.example' }) || ''));
    ok('an upgrade with a foreign Host header is refused (403)', /403/.test(await refused({ headers: { Host: 'evil.example' } }) || ''));
    ok('an opaque Origin is refused', /403/.test(await refused({ origin: 'null' }) || ''));
    const sameOrigin = connect(server.url, { origin: `http://127.0.0.1:${server.port}` });
    ok('a loopback Origin is allowed', await sameOrigin.opened.then(() => true, () => false));
    sameOrigin.ws.terminate();
    const localhostUrl = server.url.replace('127.0.0.1', 'localhost');
    const viaName = connect(localhostUrl);
    ok('connecting through the name localhost is allowed', await viaName.opened.then(() => true, () => false));
    viaName.ws.terminate();

    const httpStatus = await new Promise((resolve) => { http.get(`http://127.0.0.1:${server.port}/`, (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve(0)); });
    ok('a plain HTTP request gets 426 Upgrade Required', httpStatus === 426);

    // construction errors
    let nonLoopback = null; try { await start({ host: '0.0.0.0' }); } catch (e) { nonLoopback = e; }
    ok('binding a non-loopback address is refused', nonLoopback && /loopback/.test(nonLoopback.message));
    let noFactory = null; try { await startAgentServer({ token: TOKEN }); } catch (e) { noFactory = e; }
    ok('runtimeFactory is required', noFactory instanceof TypeError);
    let inUse = null; try { await start({ port: server.port }); } catch (e) { inUse = e; }
    ok('a busy port reports EADDRINUSE', inUse && inUse.code === 'EADDRINUSE' && /already in use/.test(inUse.message));
    let badPort = null; try { await start({ port: 70000 }); } catch (e) { badPort = e; }
    ok('an out-of-range port is rejected', badPort instanceof RangeError);

    const anonymous = await startAgentServer({ runtimeFactory: factory });
    ok('a token is generated when none is given', typeof anonymous.token === 'string' && anonymous.token.length >= 32);
    const anon = connect(anonymous.url); await anon.opened;
    anon.send({ type: 'hello', token: anonymous.token, client: 'cli', version: '1' });
    ok('the generated token authenticates', (await anon.next(type('hello.ok'))).type === 'hello.ok');
    anon.ws.terminate();
    await anonymous.close();

    await good.close();
    await server.close();
    ok('close() is idempotent', (await server.close()) === undefined);
    const afterClose = connect(server.url);
    ok('a closed server refuses connections', await afterClose.opened.then(() => false, () => true));
}

// =============================================================================
// [D] sessions: create, flags, input validation
// =============================================================================
console.log('\n[D] sessions: create / flags / validation');
{
    // the server-level credentials: only OpenAI is configured
    const server = await start({ keysData: { OPENAI_KEY: SECRET } });
    const c = await login(server);

    c.send({ type: 'session.create', id: 'c1', cwd: PROJECT });
    const created = await c.next(type('session.created'));
    ok('session.create -> session.created (id echoed)', created.id === 'c1' && typeof created.sessionId === 'string' && created.cwd === PROJECT);
    ok('the session id is a UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(created.sessionId));
    ok('defaults for a non-IDE client', JSON.stringify(created.flags) === JSON.stringify({ confirm: false, local: false, mode: 'auto', language: null, quiet: false, debug: false, modelPreferences: null, model: null }));
    ok('provider/model chip comes from describeProvider', created.provider === 'stub' && created.model === 'stub-1');
    ok('orvix status is reported', created.orvix && created.orvix.enabled === false && created.orvix.symbols === 0 && created.orvix.indexing === false);
    ok('the runtime got the cwd and shares the session flags object', lastRuntime().cwd === PROJECT && lastRuntime().flags.mode === 'auto');
    ok('non-IDE sessions get no IDE bridge', lastRuntime().extras.ide === null && typeof lastRuntime().extras.debug === 'function');

    const custom = await newSession(c, { mode: 'agent', confirm: true, language: 'Spanish', modelPreferences: ['anthropic', 'openai'] });
    ok('flags override the defaults and are echoed', custom.flags.mode === 'agent' && custom.flags.confirm === true && custom.flags.language === 'Spanish' && JSON.stringify(custom.flags.modelPreferences) === JSON.stringify(['ANTHROPIC', 'OPENAI']) && custom.flags.local === false);
    ok('the runtime sees the same flags', lastRuntime().flags.mode === 'agent' && lastRuntime().flags.confirm === true);

    // the IDE client: confirm defaults to config.ide.confirm
    const ide = await login(server, 'ide');
    const ideSession = await newSession(ide);
    ok('IDE sessions confirm by default (config.ide.confirm)', ideSession.flags.confirm === true);
    ok('IDE sessions get an IdeBridge', lastRuntime().extras.ide && typeof lastRuntime().extras.ide.call === 'function');
    config.saveConfig({ ide: { confirm: false } });
    ok('config.ide.confirm=false is honored for IDE sessions', (await newSession(ide)).flags.confirm === false);
    ok('an explicit flag wins over the config default', (await newSession(ide, { confirm: true })).flags.confirm === true);
    config.saveConfig({ ide: { confirm: true } });
    await ide.close();

    // invalid creates
    const bad = async (msg) => { c.send({ type: 'session.create', ...msg }); return await c.next(type('error')); };
    ok('a missing cwd -> error bad_cwd', (await bad({})).code === 'bad_cwd');
    ok('a relative cwd -> error bad_cwd', (await bad({ cwd: 'relative/dir' })).code === 'bad_cwd');
    ok('a nonexistent cwd -> error bad_cwd', (await bad({ cwd: path.join(PROJECT, 'missing') })).code === 'bad_cwd');
    ok('a file as cwd -> error bad_cwd', (await bad({ cwd: path.join(PROJECT, 'hello.js') })).code === 'bad_cwd');
    ok('unknown flags -> error bad_flags', (await bad({ cwd: PROJECT, flags: { nope: true } })).code === 'bad_flags');
    ok('a wrongly typed flag -> error bad_flags', (await bad({ cwd: PROJECT, flags: { confirm: 'yes' } })).code === 'bad_flags');
    ok('an invalid mode -> error bad_flags', (await bad({ cwd: PROJECT, flags: { mode: 'chaos' } })).code === 'bad_flags');
    ok('an unknown provider in modelPreferences -> error bad_flags', (await bad({ cwd: PROJECT, flags: { modelPreferences: ['NOPE'] } })).code === 'bad_flags');
    ok('flags must be an object', (await bad({ cwd: PROJECT, flags: [1] })).code === 'bad_flags');
    const withModel = (model) => ({ cwd: PROJECT, flags: { model } });
    ok('a model selection must be an object', (await bad(withModel('gpt'))).code === 'unknown_model');
    ok('a selection of an unknown provider -> error unknown_model', (await bad(withModel({ provider: 'NOPE', model: 'x', effort: null }))).code === 'unknown_model');
    ok('a selection without a model id -> error unknown_model', (await bad(withModel({ provider: 'OPENAI', model: '  ', effort: null }))).code === 'unknown_model');
    ok('a selection with an unknown effort -> error unknown_model', (await bad(withModel({ provider: 'OPENAI', model: 'x', effort: 'turbo' }))).code === 'unknown_model');
    ok('a selection of a provider without credentials -> error no_credentials', (await bad(withModel({ provider: 'ANTHROPIC', model: 'claude-sonnet-5', effort: null }))).code === 'no_credentials');
    ok('--local without a local model -> error no_credentials', (await bad({ cwd: PROJECT, flags: { local: true } })).code === 'no_credentials');
    ok('model: null is accepted', (await newSession(c, { model: null })).flags.model === null);

    // session.flags
    const sid = created.sessionId;
    c.send({ type: 'session.flags', id: 'f1', sessionId: sid, flags: { mode: 'plan', confirm: true, debug: true } });
    const merged = await c.next(type('session.flags'));
    ok('session.flags merges a partial and echoes the full flags (id echoed)', merged.id === 'f1' && merged.sessionId === sid && merged.flags.mode === 'plan' && merged.flags.confirm === true && merged.flags.debug === true && merged.flags.local === false && 'language' in merged.flags);
    const rtOfFirst = runtimes.find((r) => r.cwd === PROJECT && r.flags.mode === 'plan');
    ok('the runtime reads the merged flags live', !!rtOfFirst && rtOfFirst.flags.confirm === true);
    const flagErr = async (flags) => { c.send({ type: 'session.flags', sessionId: sid, flags }); return await c.next(type('session.error')); };
    const e1 = await flagErr({ mode: 'bogus' });
    ok('session.flags with an invalid value -> session.error bad_flags and no change', e1.code === 'bad_flags' && e1.sessionId === sid && rtOfFirst.flags.mode === 'plan');
    ok('session.flags local without a local model -> session.error no_credentials', (await flagErr({ local: true })).code === 'no_credentials' && rtOfFirst.flags.local === false);
    const modelErr = await flagErr({ model: { provider: 'NOPE', model: 'x', effort: null } });
    ok('session.flags with an invalid selection -> session.error unknown_model and no change', modelErr.code === 'unknown_model' && modelErr.sessionId === sid && rtOfFirst.flags.model === null);
    const credErr = await flagErr({ model: { provider: 'ANTHROPIC', model: 'claude-sonnet-5', effort: null } });
    ok('session.flags with a provider that has no credentials -> session.error no_credentials and no change', credErr.code === 'no_credentials' && rtOfFirst.flags.model === null);
    ok('a rejected selection is not remembered', config.loadConfig().models.selected === null);
    c.send({ type: 'session.flags', sessionId: 'no-such-session', flags: { debug: false } });
    const noSession = await c.next(type('session.error'));
    ok('session.flags on an unknown session -> session.error not_found', noSession.code === 'not_found' && noSession.sessionId === 'no-such-session');
    rtOfFirst.keysData.LOCAL_BASE_URL = 'http://localhost:1/v1'; rtOfFirst.keysData.LOCAL_MODEL = 'llama';
    c.send({ type: 'session.flags', sessionId: sid, flags: { local: true } });
    ok('--local is accepted once a local model is configured', (await c.next(type('session.flags'))).flags.local === true);

    // input validation
    const send = async (msg) => { c.send({ type: 'session.input', ...msg }); return await c.next(type('session.error')); };
    ok('empty text -> session.error bad_request', (await send({ sessionId: sid, text: '   ' })).code === 'bad_request');
    ok('missing text -> session.error bad_request', (await send({ sessionId: sid })).code === 'bad_request');
    ok('unknown session -> session.error not_found', (await send({ sessionId: 'ffffffff-ffff', text: 'hi' })).code === 'not_found');
    c.send({ type: 'session.input', text: 'hi' });
    const noId = await c.next(type('error'));
    ok('a missing sessionId -> error not_found', noId.code === 'not_found');

    stub.provider = { provider: '', model: '' };
    const noProvider = await send({ sessionId: created.sessionId, text: 'hello' });
    stub.provider = { provider: 'stub', model: 'stub-1' };
    ok('no provider configured -> session.error no_provider without running a turn', noProvider.code === 'no_provider' && noProvider.message === 'no API key configured — add one in Settings' && !rtOfFirst.calls.length);
    const withChip = await newSession(c);
    stub.provider = { provider: '', model: '' };
    const chipless = await newSession(c); // creating a session needs no provider
    stub.provider = { provider: 'stub', model: 'stub-1' };
    ok('the chip is empty strings when no provider is configured', chipless.provider === '' && chipless.model === '' && withChip.provider === 'stub');

    // session.cancel on an idle or unknown session is harmless
    c.send({ type: 'session.cancel', sessionId: sid });
    c.send({ type: 'session.cancel', sessionId: 'nope' });
    const cancelErr = await c.next(type('session.error'));
    ok('cancelling an idle session is a no-op; an unknown one is reported', cancelErr.code === 'not_found' && c.pending().length === 0);

    await c.close();
    await server.close();
}

// =============================================================================
// [E] turns: events, prompts, cancel, busy, persistence
// =============================================================================
console.log('\n[E] turns');
{
    const server = await start();
    const c = await login(server);
    const s = await newSession(c);
    const sid = s.sessionId;

    // a normal turn
    behavior.run = null;
    c.send({ type: 'session.input', id: 't1', sessionId: sid, text: 'hello server' });
    const events = await c.until(type('session.done'));
    ok('a turn emits steps, a stream, a footer and session.done in order', JSON.stringify(types(events)) === JSON.stringify(['ui.step.start', 'ui.step.update', 'ui.step.end', 'ui.stream.start', 'ui.stream.chunk', 'ui.stream.chunk', 'ui.stream.end', 'ui.footer', 'session.done']));
    ok('every event carries the session id', events.every((m) => m.sessionId === sid));
    const end = events.find(type('ui.stream.end'));
    ok('ui.stream.end has the whole streamed text', end.text === 'Echo: hello server');
    const done = events[events.length - 1];
    ok('session.done carries the usage (id echoed, not cancelled)', done.id === 't1' && done.usage.inputTokens === 1 && done.usage.calls === 1 && done.cancelled === undefined);
    const call = lastRuntime().calls[0];
    ok('runPrompt got the text, an abort signal, empty history, sessionId', call.input === 'hello server' && call.opts.signal && call.opts.signal.aborted === false && call.opts.history.length === 0 && call.opts.sessionId === sid);
    ok('no refs/editor/modeOverride unless sent', !('refs' in call.opts) && !('modeOverride' in call.opts));

    // persistence
    const file = sessionFile(sid);
    ok('the session file lives under ~/.aicode/projects/<slug>/sessions', fs.existsSync(file));
    let lines = readJsonl(file);
    ok('first line is the session header', lines[0].type === 'session' && lines[0].id === sid && lines[0].cwd === PROJECT && !Number.isNaN(Date.parse(lines[0].createdAt)) && lines[0].title === 'hello server');
    ok('then user, assistant and turn_ended in the Cursor transcript shape', lines.length === 4
        && JSON.stringify(lines[1]) === JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'hello server' }] } })
        && JSON.stringify(lines[2]) === JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Echo: hello server' }] } })
        && JSON.stringify(lines[3]) === JSON.stringify({ type: 'turn_ended' }));
    ok('the file is private to the user', process.platform === 'win32' || (fs.statSync(file).mode & 0o077) === 0);

    // history feeds the next turn; refs/editor/modeOverride pass through sanitized
    const long = 'x'.repeat(100);
    await turn(c, sid, long, {
        refs: [{ kind: 'conversation', id: 'abc' }, { kind: 'skill', name: 'demo' }, { kind: 'file', path: 'a.js' }, { kind: 'bogus' }, 'junk', { kind: 'file' }],
        editor: { activeFile: 'a.js', selection: { startLine: 3, endLine: 5, text: 'y'.repeat(9000) }, openFiles: ['a.js', 7, 'b.js'] },
    });
    const second = lastRuntime().calls[1];
    ok('the next turn receives the previous pair as history', JSON.stringify(second.opts.history) === JSON.stringify([{ role: 'user', content: 'hello server' }, { role: 'assistant', content: 'Echo: hello server' }]));
    ok('refs are validated (unknown kinds dropped)', JSON.stringify(second.opts.refs) === JSON.stringify([{ kind: 'conversation', id: 'abc' }, { kind: 'skill', name: 'demo' }, { kind: 'file', path: 'a.js' }]));
    ok('editor context is sanitized (selection capped, openFiles filtered)', second.opts.editor.activeFile === 'a.js' && second.opts.editor.selection.text.length === 4000 && second.opts.editor.selection.startLine === 3 && JSON.stringify(second.opts.editor.openFiles) === JSON.stringify(['a.js', 'b.js']));
    lines = readJsonl(file);
    ok('the second turn appends three lines and no second header', lines.length === 7 && lines.filter((l) => l.type === 'session').length === 1 && lines[4].message.content[0].text === long);

    // session.list
    c.send({ type: 'session.list', id: 'l1', cwd: PROJECT });
    const listed = await c.next(type('session.list'));
    ok('session.list returns the project sessions (id echoed)', listed.id === 'l1' && listed.sessions.length === 1);
    const entry = listed.sessions[0];
    ok('session.list entries: id, title, createdAt, updatedAt, turns', entry.id === sid && entry.title === 'hello server' && !Number.isNaN(Date.parse(entry.createdAt)) && !Number.isNaN(Date.parse(entry.updatedAt)) && entry.turns === 2);
    c.send({ type: 'session.list', cwd: path.join(PROJECT, 'unknown-project') });
    ok('session.list of an unknown project is empty', (await c.next(type('session.list'))).sessions.length === 0);
    c.send({ type: 'session.list', cwd: 'relative' });
    ok('session.list needs an absolute cwd', (await c.next(type('error'))).code === 'bad_cwd');

    // the title is the first 80 characters of the first input
    const s2 = await newSession(c);
    await turn(c, s2.sessionId, 'T'.repeat(120));
    ok('the title is the first 80 characters of the first user input', readJsonl(sessionFile(s2.sessionId))[0].title === 'T'.repeat(80));

    // a turn that only logs notes (classic action templates) is still remembered
    const s3 = await newSession(c);
    behavior.run = async (input, ui) => { ui.note('*Template* answer', '', 'cyan'); ui.note('careful', '', 'yellow'); ui.raw('raw tail'); return USAGE; };
    await turn(c, s3.sessionId, 'question for a template');
    lines = readJsonl(sessionFile(s3.sessionId));
    ok('notes and raw lines become the answer when nothing was streamed', lines[2].message.content[0].text === '*Template* answer\n\nraw tail');
    // a turn without any output is not remembered
    const s4 = await newSession(c);
    behavior.run = async (input, ui) => { ui.error(new Error('model unavailable')); return USAGE; };
    const errTurn = await turn(c, s4.sessionId, 'this fails');
    ok('a failed turn reports ui.error and still ends with session.done', errTurn.some(type('ui.error')) && errTurn[errTurn.length - 1].type === 'session.done');
    ok('a turn without an answer is not persisted', !fs.existsSync(sessionFile(s4.sessionId)));
    // a crashing runtime
    behavior.run = async () => { throw new Error('runtime exploded'); };
    const crash = await turn(c, s4.sessionId, 'crash please');
    ok('a throwing runPrompt becomes ui.error + session.done with empty usage', crash.some((m) => m.type === 'ui.error' && m.message === 'runtime exploded') && crash[crash.length - 1].usage.calls === 0);
    behavior.run = null;

    // confirm / diff / select / ask round trips
    const s5 = await newSession(c);
    behavior.run = async (input, ui) => {
        ui.diff('src/a.js', 'old\n', 'new\n');
        const first = await ui.confirm('*Apply* the change?');
        ui.fileWritten('src/a.js', { created: false, lines: 1 });
        const second = await ui.confirm('Run tests?', { initial: false });
        const picked = await ui.select('Pick one', [{ title: 'A', value: 'a', description: 'first' }, { title: 'B', value: 'b' }]);
        const typed = await ui.ask('Name?', { placeholder: 'your name' });
        ui.answer(`first=${first} second=${second} picked=${picked} typed=${typed}`, { markdown: true });
        return USAGE;
    };
    c.send({ type: 'session.input', sessionId: s5.sessionId, text: 'prompts please' });
    const diffMsg = await c.next(type('ui.diff'));
    const req1 = await c.next(type('prompt.request'));
    ok('a confirm after a diff references it', req1.kind === 'confirm' && req1.diffId === diffMsg.diffId && req1.message === '*Apply* the change?' && req1.sessionId === s5.sessionId && /^p\d+$/.test(req1.id));
    c.send({ type: 'prompt.response', id: req1.id, value: true });
    const resolved1 = await c.next(type('prompt.resolved'));
    ok('answering emits prompt.resolved {cancelled:false}', resolved1.id === req1.id && resolved1.cancelled === false);
    await c.next(type('ui.fileWritten'));
    const req2 = await c.next(type('prompt.request'));
    ok('after fileWritten the next confirm has no diffId and carries initial', req2.diffId === undefined && req2.initial === false);
    c.send({ type: 'prompt.response', id: req2.id, value: false });
    const req3 = await c.next(type('prompt.request'));
    ok('select requests list the choices', req3.kind === 'select' && JSON.stringify(req3.choices) === JSON.stringify([{ title: 'A', value: 'a', description: 'first' }, { title: 'B', value: 'b' }]));
    c.send({ type: 'prompt.response', id: req3.id, value: 'b' });
    const req4 = await c.next(type('prompt.request'));
    ok('ask requests carry the placeholder', req4.kind === 'ask' && req4.placeholder === 'your name');
    c.send({ type: 'prompt.response', id: req4.id, value: 'Pablo' });
    const answerMsg = await c.next(type('ui.answer'));
    ok('the answers reach the pipeline', answerMsg.text === 'first=true second=false picked=b typed=Pablo' && answerMsg.markdown === true);
    await c.next(type('session.done'));
    c.send({ type: 'prompt.response', id: req1.id, value: true });
    ok('answering a settled prompt -> error unknown_prompt', (await c.next(type('error'))).code === 'unknown_prompt');
    c.send({ type: 'prompt.response', value: true });
    ok('prompt.response needs an id', (await c.next(type('error'))).code === 'bad_request');

    // busy
    const s6 = await newSession(c);
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    behavior.run = async (input, ui) => { await gate; ui.answer('finished'); return USAGE; };
    c.send({ type: 'session.input', sessionId: s6.sessionId, text: 'long running' });
    await sleep(50);
    c.send({ type: 'session.input', sessionId: s6.sessionId, text: 'second input' });
    const busy = await c.next(type('session.error'));
    ok('a second input while busy -> session.error busy', busy.code === 'busy' && busy.sessionId === s6.sessionId);
    release();
    const finished = await c.next(type('session.done'));
    ok('the first turn is unaffected by the rejected one', finished.sessionId === s6.sessionId && lastRuntime().calls.length === 1);
    behavior.run = null;
    c.send({ type: 'session.input', sessionId: s6.sessionId, text: 'after it finished' });
    ok('the session accepts input again afterwards', (await c.next(type('session.done'))).sessionId === s6.sessionId);

    // cancel
    const s7 = await newSession(c);
    behavior.run = async (input, ui, opts) => {
        const confirmed = await ui.confirm('Proceed with the long task?');
        ui.note(`confirm=${confirmed} aborted=${opts.signal.aborted}`);
        return USAGE;
    };
    c.send({ type: 'session.input', sessionId: s7.sessionId, text: 'will be cancelled' });
    const pendingReq = await c.next(type('prompt.request'));
    c.send({ type: 'session.cancel', sessionId: s7.sessionId });
    const cancelEvents = await c.until(type('session.done'));
    const resolvedByCancel = cancelEvents.find(type('prompt.resolved'));
    ok('session.cancel resolves the pending prompt (cancelled:true)', resolvedByCancel && resolvedByCancel.id === pendingReq.id && resolvedByCancel.cancelled === true);
    ok('the pipeline saw a false confirm and an aborted signal', cancelEvents.some((m) => m.type === 'ui.note' && m.message === 'confirm=false aborted=true'));
    ok('session.done reports cancelled', cancelEvents[cancelEvents.length - 1].cancelled === true);
    ok('a cancelled turn is not persisted', !fs.existsSync(sessionFile(s7.sessionId)));
    behavior.run = null;
    await turn(c, s7.sessionId, 'fresh after cancel');
    ok('a cancelled turn does not enter the history', lastRuntime().calls[lastRuntime().calls.length - 1].opts.history.length === 0);

    // another connection cannot drive this one's sessions
    const other = await login(server);
    other.send({ type: 'session.input', sessionId: sid, text: 'hijack' });
    ok('another connection gets not_found for a session it does not own', (await other.next(type('session.error'))).code === 'not_found');
    other.send({ type: 'prompt.response', id: 'p1', value: true });
    ok('and cannot answer its prompts', (await other.next(type('error'))).code === 'unknown_prompt');
    await other.close();

    await c.close();
    await server.close();
}

// =============================================================================
// [F] debug visibility, redaction, JSON safety through the wire
// =============================================================================
console.log('\n[F] debug, redaction, safe payloads');
{
    const server = await start();
    const c = await login(server);
    const s = await newSession(c);
    const circular = { label: 'loop' }; circular.self = circular;
    behavior.run = async (input, ui) => {
        ui.debug(`calling with ${SECRET}`, { header: `Bearer ${SECRET}`, circular, error: new Error('inner'), deep: { list: [SECRET] } });
        ui.note(`note ${SECRET}`, { token: SECRET });
        ui.raw(`raw ${SECRET}`);
        ui.error(new Error(`failed with ${SECRET}`));
        ui.answer(`the answer may mention ${SECRET.slice(0, 7)}`);
        return USAGE;
    };
    const quiet = await turn(c, s.sessionId, 'debug off');
    ok('ui.debug is not sent while flags.debug is off', !quiet.some(type('ui.debug')));
    c.send({ type: 'session.flags', sessionId: s.sessionId, flags: { debug: true } });
    await c.next(type('session.flags'));
    const loud = await turn(c, s.sessionId, 'debug on');
    const dbg = loud.find(type('ui.debug'));
    ok('ui.debug is sent once flags.debug is on', !!dbg);
    const wireText = JSON.stringify(loud);
    ok('API key values never appear on the wire (debug, note, raw, error)', !wireText.includes(SECRET));
    ok('they are replaced by ***', dbg.message === 'calling with ***' && dbg.data.header === 'Bearer ***' && dbg.data.deep.list[0] === '***');
    ok('circular data and errors survive serialization', dbg.data.circular.self === '[Circular]' && dbg.data.error.message === 'inner');
    ok('note, raw and error are redacted too', loud.find(type('ui.note')).message === 'note ***' && loud.find(type('ui.note')).data.token === '***' && loud.find(type('ui.raw')).text === 'raw ***' && loud.find(type('ui.error')).message === 'failed with ***' && !loud.find(type('ui.error')).stack.includes(SECRET));
    behavior.run = null;
    await c.close();
    await server.close();
}

// =============================================================================
// [G] resume, disconnects, expiry, restart
// =============================================================================
console.log('\n[G] resume / disconnect / expiry');
{
    let server = await start({ sessionTtlMs: 400 });
    const c1 = await login(server);
    const s = await newSession(c1, { mode: 'ask', confirm: true });
    const sid = s.sessionId;
    behavior.run = null;
    await turn(c1, sid, 'remember this');

    // reload: a new connection resumes from memory
    const c2 = await login(server);
    c2.send({ type: 'session.resume', id: 'r1', sessionId: sid });
    const resumed = await c2.next((m) => m.type === 'session.resumed' || m.type === 'error');
    ok('session.resume from memory -> session.resumed (id echoed)', resumed.type === 'session.resumed' && resumed.id === 'r1' && resumed.sessionId === sid && resumed.cwd === PROJECT);
    ok('the resumed session keeps its flags', resumed.flags.mode === 'ask' && resumed.flags.confirm === true);
    ok('resumed turns are the transcript', JSON.stringify(resumed.turns) === JSON.stringify([{ role: 'user', text: 'remember this' }, { role: 'assistant', text: 'Echo: remember this' }]));
    ok('the resumed message carries the provider chip', resumed.provider === 'stub' && resumed.model === 'stub-1');
    // the new connection owns it now; the old one lost it
    await turn(c2, sid, 'second connection speaking');
    ok('the resuming connection can drive the session', lastRuntime().calls[lastRuntime().calls.length - 1].input === 'second connection speaking');
    c1.send({ type: 'session.input', sessionId: sid, text: 'old connection' });
    ok('the previous connection no longer owns it', (await c1.next(type('session.error'))).code === 'not_found');
    await c1.close();
    await sleep(50);
    ok('closing the old connection does not disturb the new owner', (await turn(c2, sid, 'still here')).some(type('session.done')));

    // a taken-over session interrupts the running turn of the old owner
    const sRun = await newSession(c2);
    behavior.run = async (input, ui, opts) => { const answer = await ui.confirm('wait?'); return { ...USAGE, calls: answer ? 9 : 7, aborted: opts.signal.aborted }; };
    c2.send({ type: 'session.input', sessionId: sRun.sessionId, text: 'blocked on a prompt' });
    await c2.next(type('prompt.request'));
    const c3 = await login(server);
    c3.send({ type: 'session.resume', sessionId: sRun.sessionId });
    await c3.next(type('session.resumed'));
    await sleep(100);
    ok('taking over a session aborts its running turn and settles its prompt', lastRuntime().calls[0].opts.signal.aborted === true);
    behavior.run = null;
    await c3.close();

    // disconnect aborts a running turn; the session stays resumable
    const c4 = await login(server);
    const s4 = await newSession(c4);
    let abortedSignal = null;
    behavior.run = async (input, ui, opts) => { abortedSignal = opts.signal; await new Promise((resolve) => opts.signal.addEventListener('abort', resolve)); return USAGE; };
    c4.send({ type: 'session.input', sessionId: s4.sessionId, text: 'about to lose my client' });
    await sleep(100);
    await c4.close();
    await sleep(100);
    ok('a client disconnect aborts the running turn', abortedSignal && abortedSignal.aborted === true);
    behavior.run = null;
    const c5 = await login(server);
    c5.send({ type: 'session.resume', sessionId: s4.sessionId });
    ok('and the session can be resumed afterwards (nothing persisted yet -> no turns)', (await c5.next(type('session.resumed'))).turns.length === 0);
    await c5.close();

    // memory expiry: a detached session with no persisted turns disappears after the ttl
    await sleep(700);
    const c6 = await login(server);
    c6.send({ type: 'session.resume', sessionId: s4.sessionId });
    const gone = await c6.next(type('error'));
    ok('a detached session expires after the ttl (-> error not_found)', gone.code === 'not_found');

    // unknown / malformed ids
    c6.send({ type: 'session.resume', sessionId: 'no-such-session-id' });
    ok('resuming an unknown id -> error not_found', (await c6.next(type('error'))).code === 'not_found');
    c6.send({ type: 'session.resume', sessionId: '../../../../etc/passwd' });
    ok('a path-traversal id -> error not_found', (await c6.next(type('error'))).code === 'not_found');
    c6.send({ type: 'session.resume' });
    ok('a missing id -> error not_found', (await c6.next(type('error'))).code === 'not_found');

    // restart: the persisted file brings it back
    await c6.close(); await c2.close(); await c3.close().catch(() => { });
    await server.close();
    runtimes.length = 0;
    server = await start();
    const c7 = await login(server, 'ide');
    c7.send({ type: 'session.resume', sessionId: sid });
    const fromDisk = await c7.next((m) => m.type === 'session.resumed' || m.type === 'error');
    ok('after a server restart the session resumes from its file', fromDisk.type === 'session.resumed' && fromDisk.cwd === PROJECT && fromDisk.turns.length >= 4 && fromDisk.turns[0].text === 'remember this');
    ok('a rebuilt session starts with the client defaults', fromDisk.flags.mode === 'auto' && fromDisk.flags.confirm === true);
    behavior.run = null;
    await turn(c7, sid, 'continuing after the restart');
    const history = lastRuntime().calls[0].opts.history;
    ok('the rebuilt session seeds the history from the file', history.length === 6 && history[0].content === 'remember this' && history[1].content === 'Echo: remember this');
    const after = readJsonl(sessionFile(sid));
    ok('new turns append to the same file without a second header', after.filter((l) => l.type === 'session').length === 1 && after[after.length - 3].message.content[0].text === 'continuing after the restart');

    // a session whose directory vanished cannot be rebuilt
    const doomed = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-srv-doomed-'));
    const c8 = await login(server);
    const sDoomed = await newSession(c8, undefined, doomed);
    await turn(c8, sDoomed.sessionId, 'in a directory that will vanish');
    await c8.close(); await c7.close();
    await server.close();
    fs.rmSync(doomed, { recursive: true, force: true });
    server = await start();
    const c9 = await login(server);
    c9.send({ type: 'session.resume', sessionId: sDoomed.sessionId });
    ok('a vanished project directory -> error bad_cwd', (await c9.next(type('error'))).code === 'bad_cwd');
    await c9.close();
    await server.close();
}

// =============================================================================
// [H] concurrent sessions on one connection
// =============================================================================
console.log('\n[H] concurrent sessions');
{
    const server = await start();
    const c = await login(server);
    const a = await newSession(c);
    const b = await newSession(c);
    behavior.run = async (input, ui) => {
        const step = ui.step(`working on ${input}`);
        const value = await ui.ask(`question from ${input}`);
        step.done();
        ui.answer(`${input} got ${value}`);
        return USAGE;
    };
    c.send({ type: 'session.input', sessionId: a.sessionId, text: 'alpha' });
    c.send({ type: 'session.input', sessionId: b.sessionId, text: 'beta' });
    const reqs = {};
    while (Object.keys(reqs).length < 2) { const r = await c.next(type('prompt.request')); reqs[r.sessionId] = r; }
    ok('prompt ids are unique across sessions', reqs[a.sessionId].id !== reqs[b.sessionId].id);
    const steps = c.inbox.filter(type('ui.step.start'));
    ok('step ids restart per session but carry the session id', steps.length === 2 && steps.every((m) => m.stepId === 's1') && new Set(steps.map((m) => m.sessionId)).size === 2);
    // answer in the opposite order: each answer must reach its own session
    c.send({ type: 'prompt.response', id: reqs[b.sessionId].id, value: 'B-VALUE' });
    c.send({ type: 'prompt.response', id: reqs[a.sessionId].id, value: 'A-VALUE' });
    const answers = {};
    while (Object.keys(answers).length < 2) { const r = await c.next(type('ui.answer')); answers[r.sessionId] = r.text; }
    ok('each answer reaches the session that asked', answers[a.sessionId] === 'alpha got A-VALUE' && answers[b.sessionId] === 'beta got B-VALUE');
    // (a turn may end before the other session's answer arrives: look at the whole inbox, not past the cursor)
    const doneSessions = () => new Set(c.inbox.filter(type('session.done')).map((m) => m.sessionId));
    for (let i = 0; i < 200 && doneSessions().size < 2; i++) await sleep(25);
    ok('both turns end', doneSessions().has(a.sessionId) && doneSessions().has(b.sessionId));
    behavior.run = null;
    await c.close();
    await server.close();
}

// =============================================================================
// [I] IDE bridge (ide.call / ide.result)
// =============================================================================
console.log('\n[I] IDE bridge');
{
    const server = await start({ ideTimeoutMs: 250 });
    const c = await login(server, 'ide');
    const s = await newSession(c);
    behavior.run = async (input, ui, opts, rt) => {
        const outcome = [];
        outcome.push(await rt.extras.ide.call('getDiagnostics', { path: 'a.js' }));
        try { await rt.extras.ide.call('openFile', { path: 'b.js', line: 3 }); outcome.push('no error'); } catch (e) { outcome.push(`error: ${e.message}`); }
        try { await rt.extras.ide.call('getActiveContext'); outcome.push('no error'); } catch (e) { outcome.push(`error: ${e.message}`); }
        ui.answer(JSON.stringify(outcome));
        return USAGE;
    };
    c.send({ type: 'session.input', sessionId: s.sessionId, text: 'use the ide' });
    const call1 = await c.next(type('ide.call'));
    ok('ide.call carries id, sessionId, method and args', /^i\d+$/.test(call1.id) && call1.sessionId === s.sessionId && call1.method === 'getDiagnostics' && call1.args.path === 'a.js');
    c.send({ type: 'ide.result', id: call1.id, result: [{ file: 'a.js', line: 1, column: 1, severity: 'error', message: 'boom', source: 'ts' }] });
    const call2 = await c.next(type('ide.call'));
    ok('args default to an empty object', call2.method === 'openFile' && call2.args.line === 3);
    c.send({ type: 'ide.result', id: call2.id, error: 'file not found' });
    const call3 = await c.next(type('ide.call'));
    ok('a call without args sends {}', call3.method === 'getActiveContext' && JSON.stringify(call3.args) === '{}');
    // no answer for call3 -> times out
    const answer = await c.next(type('ui.answer'), 3000);
    const outcome = JSON.parse(answer.text);
    ok('a result resolves the call', Array.isArray(outcome[0]) && outcome[0][0].message === 'boom');
    ok('an error result rejects the call', outcome[1] === 'error: file not found');
    ok('no answer -> "IDE did not answer: $method" after the timeout', outcome[2] === 'error: IDE did not answer: getActiveContext');
    await c.next(type('session.done'));
    c.send({ type: 'ide.result', id: 'i999', result: 1 });
    ok('a result for an unknown call -> error unknown_call', (await c.next(type('error'))).code === 'unknown_call');
    c.send({ type: 'ide.result', result: 1 });
    ok('ide.result needs an id', (await c.next(type('error'))).code === 'bad_request');

    // cancelling rejects the pending call
    behavior.run = async (input, ui, opts, rt) => {
        try { await rt.extras.ide.call('getDiagnostics', {}); ui.answer('resolved'); } catch (e) { ui.note(`rejected: ${e.message}`); }
        return USAGE;
    };
    c.send({ type: 'session.input', sessionId: s.sessionId, text: 'cancel the ide call' });
    await c.next(type('ide.call'));
    c.send({ type: 'session.cancel', sessionId: s.sessionId });
    const cancelled = await c.until(type('session.done'));
    ok('session.cancel rejects pending IDE calls', cancelled.some((m) => m.type === 'ui.note' && /rejected: IDE call cancelled/.test(m.message)));
    behavior.run = null;
    await c.close();
    await server.close();
}

// =============================================================================
// [J] shutdown: close() settles running turns and prompts
// =============================================================================
console.log('\n[J] shutdown');
{
    const server = await start();
    const c = await login(server);
    const s = await newSession(c);
    let seen = null;
    behavior.run = async (input, ui, opts) => { seen = { confirmed: await ui.confirm('stuck?'), aborted: opts.signal.aborted }; return USAGE; };
    c.send({ type: 'session.input', sessionId: s.sessionId, text: 'running at shutdown' });
    await c.next(type('prompt.request'));
    await server.close();
    const closed = await c.closed;
    ok('close() closes client sockets with 1001', closed.code === 1001);
    await sleep(50);
    ok('close() aborts the running turn and resolves its prompt as false', seen && seen.confirmed === false && seen.aborted === true);
    behavior.run = null;
}

// =============================================================================
// [K] models and keys over the wire (a local http stub plays OpenRouter)
// =============================================================================
console.log('\n[K] models.list / keys.* / model selection');
{
    const openrouter = require('../lib/openrouter');
    const EncryptedJsonDB = require('../helpers/db');
    const fixtureRaw = JSON.parse(fs.readFileSync(new URL('./fixtures/openrouter-models.json', import.meta.url), 'utf8'));
    const GOOD = 'sk-or-good-key-123456';
    const UNLIMITED = 'sk-or-unlimited-key-1';
    const BAD = 'sk-or-bad-key-0000';

    // the OpenRouter stand-in: /models (switchable to failing) and /key
    const seen = [];
    const mode = { models: 'ok' };
    const stubApi = http.createServer((req, res) => {
        const auth = req.headers.authorization || '';
        seen.push({ url: req.url, auth });
        const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url === '/models') return mode.models === 'fail' ? send(500, { error: 'boom' }) : send(200, fixtureRaw);
        if (req.url === '/key') {
            if (auth === `Bearer ${GOOD}`) return send(200, { data: { label: 'my-test-key', usage: 1.5, limit: 10, limit_remaining: 8.5, is_free_tier: false } });
            if (auth === `Bearer ${UNLIMITED}`) return send(200, { data: { label: 'free-spender', usage: 0, limit: null, limit_remaining: null, is_free_tier: false } });
            return send(401, { error: { message: 'No auth credentials found' } });
        }
        return send(404, {});
    });
    await new Promise((resolve) => stubApi.listen(0, '127.0.0.1', resolve));
    process.env.AICODE_OPENROUTER_API = `http://127.0.0.1:${stubApi.address().port}`;
    const requestsTo = (url) => seen.filter((r) => r.url === url).length;

    const installCatalog = (fetchedAt) => {
        const normalized = fixtureRaw.data.map(openrouter.normalizeModel).filter(Boolean);
        fs.mkdirSync(path.dirname(openrouter.cacheFile()), { recursive: true });
        fs.writeFileSync(openrouter.cacheFile(), JSON.stringify({ fetchedAt, models: normalized }) + '\n');
    };
    installCatalog(new Date().toISOString());
    config.saveConfig({ models: { selected: null, recent: ['moonshotai/kimi-k3'] } });

    // one key store shared by the server and every runtime, like `aicode serve` does
    const ENV_GROQ = 'env-groq-key-abcdefgh';
    process.env.GROQ_KEY = ENV_GROQ;
    const sharedKeys = { OPENAI_KEY: SECRET, GROQ_KEY: ENV_GROQ };
    const sharedFactory = (cwd, flags, extras) => {
        const rt = {
            cwd, flags, extras, calls: [], keysData: sharedKeys,
            describeProvider: () => ({ provider: 'stub', model: 'stub-1' }),
            usage: () => null,
            runPrompt: async (input, ui, opts) => { rt.calls.push({ input, opts }); return await echo(input, ui, opts, rt); },
        };
        runtimes.push(rt);
        return rt;
    };
    const server = await startAgentServer({ token: TOKEN, keysData: sharedKeys, runtimeFactory: sharedFactory });
    const c = await login(server);
    const ask = async (msg, expected) => { c.send(msg); return await c.next((m) => m.type === expected || m.type === 'error'); };

    // ---- models.list -------------------------------------------------------------
    const listed = await ask({ type: 'models.list', id: 'm1' }, 'models.result');
    ok('models.list answers models.result with the request id', listed.type === 'models.result' && listed.id === 'm1' && Array.isArray(listed.models));
    ok('the catalog summary counts the OpenRouter models and is fresh', listed.catalog && listed.catalog.count === 21 && listed.catalog.stale === false && typeof listed.catalog.fetchedAt === 'string');
    ok('no selection is remembered yet', listed.selected === null);
    ok('recent models come first and carry their groups', listed.models[0].id === 'moonshotai/kimi-k3' && listed.models[0].groups.includes('recent') && listed.models[0].groups.includes('featured'));
    ok('featured vendors list their newest models', listed.models.some((m) => m.id === 'anthropic/claude-sonnet-5.5' && m.groups.join() === 'featured'));
    ok('OpenRouter entries are unavailable without a key; configured providers are available', listed.models.filter((m) => m.provider === 'OPENROUTER').every((m) => m.available === false) && listed.models.some((m) => m.provider === 'OPENAI' && m.available === true));
    ok('a ModelInfo carries display pricing per 1M tokens', (() => { const sonnet = listed.models.find((m) => m.id === 'anthropic/claude-sonnet-5.5'); return sonnet && sonnet.pricing.prompt === 2 && sonnet.pricing.completion === 10 && sonnet.shortName === 'Claude Sonnet 5.5'; })());
    const filtered = await ask({ type: 'models.list', id: 'm2', query: 'kimi' }, 'models.result');
    ok('models.list filters by query', filtered.models.length >= 2 && filtered.models.every((m) => /kimi/i.test(m.id) || /kimi/i.test(m.name)));
    const none = await ask({ type: 'models.list', id: 'm3', query: 'zzz-no-such-model' }, 'models.result');
    ok('a query without matches lists nothing', none.models.length === 0);

    // ---- catalog refresh -----------------------------------------------------------
    const before = requestsTo('/models');
    const refreshed = await ask({ type: 'models.list', id: 'm4', refresh: true }, 'models.result');
    ok('refresh: true fetches the catalog before answering', requestsTo('/models') === before + 1 && refreshed.catalog.count === 21 && !('error' in refreshed));
    mode.models = 'fail';
    const failed = await ask({ type: 'models.list', id: 'm5', refresh: true }, 'models.result');
    ok('a failed refresh answers from the cache and reports the error', failed.models.length === listed.models.length && typeof failed.error === 'string' && failed.error.includes('500'));
    mode.models = 'ok';
    installCatalog(new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString());
    const calls = requestsTo('/models');
    const stale = await ask({ type: 'models.list', id: 'm6' }, 'models.result');
    ok('a stale catalog is flagged', stale.catalog.stale === true);
    for (let i = 0; i < 40 && requestsTo('/models') === calls; i++) await sleep(50);
    ok('a stale catalog is refreshed in the background after answering', requestsTo('/models') === calls + 1);
    await sleep(100);
    ok('the background refresh renews the cache', openrouter.isStale(openrouter.loadCatalog(), 24) === false);

    // ---- model selection ----------------------------------------------------------
    const sess = await newSession(c);
    const sid = sess.sessionId;
    const sessionRuntime = lastRuntime();
    const flagsOf = async (flags) => { c.send({ type: 'session.flags', id: 'sf', sessionId: sid, flags }); return await c.next((m) => m.type === 'session.flags' || m.type === 'session.error'); };
    const picked = await flagsOf({ model: { provider: 'openai', model: 'gpt-test-1', effort: 'max' } });
    ok('session.flags { model } echoes the normalized selection', picked.type === 'session.flags' && JSON.stringify(picked.flags.model) === JSON.stringify({ provider: 'OPENAI', model: 'gpt-test-1', effort: 'max' }));
    ok('the pick becomes the remembered default', JSON.stringify(config.loadConfig().models.selected) === JSON.stringify({ provider: 'OPENAI', model: 'gpt-test-1', effort: 'max' }) && config.loadConfig().models.recent[0] === 'gpt-test-1');
    await flagsOf({ model: { provider: 'OPENAI', model: 'gpt-test-2', effort: null } });
    await flagsOf({ model: { provider: 'OPENAI', model: 'gpt-test-1', effort: null } });
    ok('recent is newest first without duplicates', config.loadConfig().models.recent.slice(0, 3).join() === 'gpt-test-1,gpt-test-2,moonshotai/kimi-k3');
    for (let i = 0; i < 9; i++) await flagsOf({ model: { provider: 'OPENAI', model: `bulk-${i}`, effort: null } });
    ok('recent keeps the 8 newest', config.loadConfig().models.recent.length === 8 && config.loadConfig().models.recent[0] === 'bulk-8');
    const listedAfter = await ask({ type: 'models.list', id: 'm7' }, 'models.result');
    ok('models.list reports the remembered selection', listedAfter.selected && listedAfter.selected.model === 'bulk-8');
    const cleared = await flagsOf({ model: null });
    ok('model: null clears the session selection and the remembered one', cleared.flags.model === null && config.loadConfig().models.selected === null);
    const sel = await flagsOf({ model: { provider: 'ANTHROPIC', model: 'claude-x', effort: null } });
    ok('a provider without credentials is refused and nothing is remembered', sel.type === 'session.error' && sel.code === 'no_credentials' && config.loadConfig().models.selected === null);

    // ---- keys.* -----------------------------------------------------------------------
    const status = await ask({ type: 'keys.list', id: 'k1' }, 'keys.status');
    ok('keys.list answers keys.status with one row per provider in the default order', status.id === 'k1' && status.providers.map((p) => p.provider).join() === 'OPENROUTER,ANTHROPIC,OPENAI,GROQ,LOCAL');
    const rowOf = (message, provider) => message.providers.find((p) => p.provider === provider);
    ok('a configured key is reported masked with its source', rowOf(status, 'OPENAI').configured === true && rowOf(status, 'OPENAI').masked === 'sk-tes…2345' && rowOf(status, 'OPENROUTER').configured === false && rowOf(status, 'OPENROUTER').masked === null);
    ok('a key that came from the environment says so', rowOf(status, 'GROQ').source === 'env');

    const set = await ask({ type: 'keys.set', id: 'k2', provider: 'openrouter', value: GOOD }, 'keys.status');
    ok('keys.set answers keys.status with the key masked', set.type === 'keys.status' && set.id === 'k2' && rowOf(set, 'OPENROUTER').configured === true && rowOf(set, 'OPENROUTER').masked === 'sk-or-…3456' && rowOf(set, 'OPENROUTER').source === 'keys.json');
    ok('the raw key never travels back', !JSON.stringify(set).includes(GOOD));
    ok('the server keeps the key in the shared store (every session sees it)', sharedKeys.OPENROUTER_KEY === GOOD);
    const keysFile = path.join(TMP_HOME, '.aicode', 'keys.json');
    const stored = new EncryptedJsonDB('keys.json').load();
    ok('the key is saved encrypted in keys.json', stored.OPENROUTER_KEY === GOOD && !fs.readFileSync(keysFile, 'utf8').includes(GOOD));
    ok('keys that only came from the environment are not copied to disk', stored.GROQ_KEY === undefined && stored.OPENAI_KEY === undefined);
    if (process.platform !== 'win32') ok('keys.json is readable by its owner only', (fs.statSync(keysFile).mode & 0o077) === 0);
    const withKey = await ask({ type: 'models.list', id: 'm8' }, 'models.result');
    ok('after the key is saved the OpenRouter models become available', withKey.models.filter((m) => m.provider === 'OPENROUTER').every((m) => m.available === true));

    const emptyKey = await ask({ type: 'keys.set', id: 'k3', provider: 'openrouter', value: '   ' }, 'keys.status');
    ok('an empty key -> error invalid_key (id echoed)', emptyKey.type === 'error' && emptyKey.code === 'invalid_key' && emptyKey.id === 'k3');
    ok('a key of the wrong type -> error invalid_key', (await ask({ type: 'keys.set', provider: 'openrouter', value: 12345 }, 'keys.status')).code === 'invalid_key');
    ok('an unknown provider -> error bad_request', (await ask({ type: 'keys.set', provider: 'nope', value: 'abc' }, 'keys.status')).code === 'bad_request');
    ok('a LOCAL key needs a base URL and a model', (await ask({ type: 'keys.set', provider: 'local', value: 'http://localhost:11434/v1' }, 'keys.status')).code === 'invalid_key'
        && (await ask({ type: 'keys.set', provider: 'local', value: { baseURL: 'ftp://nope', model: 'x' } }, 'keys.status')).code === 'invalid_key');
    const local = await ask({ type: 'keys.set', provider: 'local', value: { baseURL: 'http://localhost:11434/v1', model: 'llama3' } }, 'keys.status');
    ok('a LOCAL server is configured with { baseURL, model }', rowOf(local, 'LOCAL').configured === true && rowOf(local, 'LOCAL').masked === 'http://localhost:11434/v1' && sharedKeys.LOCAL_MODEL === 'llama3');
    const unlocal = await ask({ type: 'keys.remove', provider: 'local' }, 'keys.status');
    ok('keys.remove forgets the LOCAL server', rowOf(unlocal, 'LOCAL').configured === false && sharedKeys.LOCAL_BASE_URL === undefined);

    // ---- keys.test -------------------------------------------------------------------------
    const good = await ask({ type: 'keys.test', id: 't1', provider: 'openrouter' }, 'keys.testResult');
    ok('keys.test OPENROUTER -> ok with the label and the credits left', good.id === 't1' && good.provider === 'OPENROUTER' && good.ok === true && good.detail === 'my-test-key · 8.50 credits left');
    ok('the key is sent as a Bearer token', seen.filter((r) => r.url === '/key').pop().auth === `Bearer ${GOOD}`);
    await ask({ type: 'keys.set', provider: 'openrouter', value: UNLIMITED }, 'keys.status');
    ok('a key without a limit is reported as unlimited', (await ask({ type: 'keys.test', provider: 'openrouter' }, 'keys.testResult')).detail === 'free-spender · unlimited');
    await ask({ type: 'keys.set', provider: 'openrouter', value: BAD }, 'keys.status');
    const rejected = await ask({ type: 'keys.test', provider: 'openrouter' }, 'keys.testResult');
    ok('keys.test OPENROUTER with a rejected key -> failed with "invalid key"', rejected.ok === false && rejected.detail === 'invalid key');
    const unset = await ask({ type: 'keys.test', provider: 'anthropic' }, 'keys.testResult');
    ok('keys.test of a provider without a key -> not configured', unset.ok === false && unset.detail === 'not configured');
    ok('keys.test of an unknown provider -> error bad_request', (await ask({ type: 'keys.test', provider: 'nope' }, 'keys.testResult')).code === 'bad_request');

    // ---- a removed key is noticed by the next turn -------------------------------------------
    await ask({ type: 'keys.set', provider: 'openrouter', value: GOOD }, 'keys.status');
    const orSelection = { provider: 'OPENROUTER', model: 'moonshotai/kimi-k3', effort: 'max' };
    ok('an OpenRouter model can be picked once the key is stored', (await flagsOf({ model: orSelection })).flags.model.model === 'moonshotai/kimi-k3');
    const ran = await turn(c, sid, 'hello');
    ok('a turn runs while the selected provider has credentials', ran[ran.length - 1].type === 'session.done');
    const removed = await ask({ type: 'keys.remove', id: 'k9', provider: 'openrouter' }, 'keys.status');
    ok('keys.remove drops the key from memory and from keys.json', removed.id === 'k9' && rowOf(removed, 'OPENROUTER').configured === false && sharedKeys.OPENROUTER_KEY === undefined && new EncryptedJsonDB('keys.json').load().OPENROUTER_KEY === undefined);
    const lost = await turn(c, sid, 'hello again');
    const lostError = lost.find((m) => m.type === 'session.error');
    ok('the next session.input -> session.error no_credentials without running a turn', lostError && lostError.code === 'no_credentials' && lostError.sessionId === sid && !lost.some((m) => m.type === 'session.done'));
    ok('no turn was started for it', sessionRuntime.calls.length === 1 && sessionRuntime.calls[0].input === 'hello');
    await flagsOf({ model: null });
    const afterClear = await turn(c, sid, 'hello once more');
    ok('clearing the selection lets the session run again', afterClear[afterClear.length - 1].type === 'session.done');

    // ---- nothing secret ever came back ---------------------------------------------------------
    const wire = JSON.stringify(c.inbox);
    ok('no raw key appears in anything the server sent', [GOOD, UNLIMITED, BAD, SECRET, ENV_GROQ].every((value) => !wire.includes(value)));

    await c.close();
    await server.close();
    stubApi.close();
    delete process.env.AICODE_OPENROUTER_API;
    delete process.env.GROQ_KEY;
}

// =============================================================================
// [L] the real runtime behind the server (mock model, no network)
// =============================================================================
console.log('\n[L] real runtime end to end');
{
    const Code2Prompt = require('../lib/engine');
    const models = require('../lib/models');
    const { createRuntime } = require('../lib/runtime');
    const STOP = { unified: 'stop', raw: 'stop' };
    const MODEL_USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
    const analysis = { type_of: 'question', english: 'say hello', language: 'English', action_file: '', action_reason: 'n/a', personality_file: '', personality_reason: 'n/a', needs_agent: false, skill_name: '' };
    const mock = new MockLanguageModelV3({
        doGenerate: async (options) => {
            const prompt = JSON.stringify(options.prompt);
            const body = prompt.includes('Analyze the following user input text') ? analysis : { answer: 'TEMPLATE_ANSWER' };
            return { content: [{ type: 'text', text: JSON.stringify({ schema: body }) }], finishReason: STOP, usage: MODEL_USAGE, warnings: [] };
        },
        doStream: async () => ({
            stream: convertArrayToReadableStream([
                { type: 'stream-start', warnings: [] },
                { type: 'response-metadata', id: 'r', modelId: 'mock' },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'Hello from ' },
                { type: 'text-delta', id: 't', delta: 'the mock.' },
                { type: 'text-end', id: 't' },
                { type: 'finish', finishReason: STOP, usage: MODEL_USAGE },
            ]),
        }),
    });
    models.resolveProvider = (prefs) => (prefs && prefs.length ? prefs[0] : null);
    models.createModel = () => mock;
    models.callOptions = () => ({});
    models.modelId = () => 'mock-model';
    models.estimateCost = () => 0;
    models.estimateTokens = () => 10;
    Code2Prompt.resetUsage();

    const keysData = { OPENAI_KEY: 'sk-real-runtime-test-key' };
    const server = await startAgentServer({
        token: TOKEN,
        runtimeFactory: (cwd, flags, extras) => createRuntime({ cwd, keysData, flags, debug: extras.debug, ide: extras.ide }),
    });
    const c = await login(server);
    const agent = await newSession(c, { mode: 'agent' });
    ok('the real runtime reports the provider chip', agent.provider === 'openai' && agent.model === 'mock-model');

    const events = await turn(c, agent.sessionId, 'say hello');
    const t = types(events);
    ok('the agent route streams the answer over the wire', t.includes('ui.stream.start') && t.includes('ui.stream.chunk') && events.find(type('ui.stream.end')).text === 'Hello from the mock.');
    ok('the analyzing step is announced and closed', events.some((m) => m.type === 'ui.step.start' && m.label === 'analyzing request') && events.some((m) => m.type === 'ui.step.end' && m.label === 'analyzing request' && m.ok === true));
    const footer = events.find(type('ui.footer'));
    ok('the footer carries usage and elapsed time', footer.usage.calls === 2 && typeof footer.usage.elapsedMs === 'number');
    const done = events[events.length - 1];
    ok('session.done carries the turn usage', done.type === 'session.done' && done.usage.calls === 2 && done.usage.model === 'mock-model');
    ok('the streamed answer is persisted', readJsonl(sessionFile(agent.sessionId))[2].message.content[0].text === 'Hello from the mock.');
    ok('no error was reported', !events.some((m) => m.type === 'ui.error'));

    // classic action template (auto mode): the answer arrives as a note and is remembered
    const auto = await newSession(c);
    const autoEvents = await turn(c, auto.sessionId, 'what does hello.js do?');
    ok('the template route ends with a note carrying the answer', autoEvents.some((m) => m.type === 'ui.note' && m.message.includes('TEMPLATE_ANSWER')));
    ok('the template answer is persisted for resume', readJsonl(sessionFile(auto.sessionId))[2].message.content[0].text.includes('TEMPLATE_ANSWER'));

    // two sessions running at once do not mix their usage
    const sA = await newSession(c, { mode: 'agent' });
    const sB = await newSession(c, { mode: 'agent' });
    c.send({ type: 'session.input', sessionId: sA.sessionId, text: 'first' });
    c.send({ type: 'session.input', sessionId: sB.sessionId, text: 'second' });
    const dones = [];
    while (dones.length < 2) dones.push(await c.next(type('session.done')));
    ok('parallel sessions keep separate usage', dones.every((d) => d.usage.calls === 2));
    ok('the static usage ledger stays untouched', Code2Prompt.getUsage().calls === 0);

    await c.close();
    await server.close();
}

// =============================================================================
// [M] the code index over the wire (a fake orvix: no indexing happens here)
// =============================================================================
console.log('\n[M] orvix: session status, orvix.status pushes, orvix.command');
{
    const { orvixView } = require('../lib/server/sessions');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function fakeOrvix({ enabled = true, symbols = 7, reason = null } = {}) {
        const listeners = new Set();
        const o = {
            enabled, reason, symbols, indexing: false, dirty: false, calls: [],
            status: () => ({ enabled: o.enabled, symbols: o.symbols, indexing: o.indexing, dirty: o.dirty }),
            onStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
            listenerCount: () => listeners.size,
            emit: () => { for (const fn of [...listeners]) fn(o.status()); },
            ensureIndex: async () => { o.calls.push('ensureIndex'); return { enabled: o.enabled, building: false, symbols: o.symbols, step: null }; },
            indexNow: async () => {
                o.calls.push('indexNow');
                o.indexing = true; o.emit();
                await sleep(20);
                o.indexing = false; o.symbols += 2; o.emit();
                return { ok: true, summary: { files: 3, symbols: o.symbols, added: 1, updated: 0, removed: 0 }, symbols: o.symbols };
            },
            init: async ({ agents } = {}) => { o.calls.push(['init', agents]); return { ok: true, code: 0, output: 'wrote AGENTS.md' }; },
            gain: async () => ({ compressions: 2, before: 1000, after: 400, saved: 600, ratio: 0.6 }),
        };
        return o;
    }

    ok('the view of a runtime without a code index is "off"', same(orvixView(undefined), { enabled: false, symbols: 0, indexing: false }) && same(orvixView({}), { enabled: false, symbols: 0, indexing: false }));
    ok('...a status that throws is "off" too', same(orvixView({ status: () => { throw new Error('x'); } }), { enabled: false, symbols: 0, indexing: false }));
    ok('the view keeps only enabled, symbols and indexing', same(orvixView(fakeOrvix()), { enabled: true, symbols: 7, indexing: false }));

    const fake = fakeOrvix();
    behavior.orvix = fake;
    const server = await start();
    const c = await login(server);
    const created = await newSession(c);
    behavior.orvix = null;
    ok('session.created carries the status of the code index', same(created.orvix, { enabled: true, symbols: 7, indexing: false }));
    ok('...creating a session makes sure the project has an index', fake.calls.includes('ensureIndex') && fake.listenerCount() === 1);
    const sid = created.sessionId;

    fake.indexing = true; fake.emit();
    const push = await c.next(type('orvix.status'));
    ok('a status change is pushed to the client', same(push, { type: 'orvix.status', sessionId: sid, enabled: true, symbols: 7, indexing: true }));
    ok('...without internals (no dirty flag, no reason)', !('dirty' in push) && !('reason' in push) && !('id' in push));
    fake.indexing = false; fake.symbols = 11; fake.emit();
    ok('...and the next one', (await c.next(type('orvix.status'))).symbols === 11 && fake.indexing === false);
    fake.symbols = 7;

    c.send({ type: 'orvix.command', id: 'q1', sessionId: sid, command: 'status' });
    const status = await c.next((m) => m.id === 'q1');
    ok('orvix.command status answers with the status and echoes the id', status.type === 'orvix.status' && status.sessionId === sid && status.enabled === true && status.symbols === 7 && !('output' in status));

    c.send({ type: 'orvix.command', id: 'q2', sessionId: sid, command: 'index' });
    const indexRun = await c.until((m) => m.id === 'q2');
    ok('orvix.command index runs an index pass and streams the status while it works', indexRun.filter(type('orvix.status')).length === 3 && indexRun[0].indexing === true && indexRun[1].indexing === false);
    const indexed = indexRun[indexRun.length - 1];
    ok('...and answers with what it did', indexed.output === '3 files, 9 symbols (1 added, 0 updated, 0 removed)' && indexed.symbols === 9 && indexed.indexing === false && fake.calls.includes('indexNow'));

    c.send({ type: 'orvix.command', id: 'q3', sessionId: sid, command: 'gain' });
    const gain = await c.next((m) => m.id === 'q3');
    ok('orvix.command gain reports the savings', gain.type === 'orvix.status' && gain.saved === 600 && gain.output === '2 compressions, 600 tokens saved (1000 → 400)');

    c.send({ type: 'orvix.command', id: 'q4', sessionId: sid, command: 'init', agents: ['Claude', ' codex '] });
    const init = await c.next((m) => m.id === 'q4');
    ok('orvix.command init passes the agents (normalized) and returns orvix\'s output', init.output === 'wrote AGENTS.md' && same(fake.calls[fake.calls.length - 1], ['init', ['claude', 'codex']]));
    c.send({ type: 'orvix.command', id: 'q5', sessionId: sid, command: 'init' });
    await c.next((m) => m.id === 'q5');
    ok('...with no agents orvix decides', same(fake.calls[fake.calls.length - 1], ['init', []]));

    const refused = async (message) => { c.send({ type: 'orvix.command', sessionId: sid, ...message }); return await c.next((m) => m.type === 'session.error' || m.type === 'error'); };
    const before = fake.calls.length;
    let err = await refused({ command: 'rm -rf' });
    ok('an unknown command is refused (bad_request, with the session)', err.type === 'session.error' && err.code === 'bad_request' && err.sessionId === sid && /status, index, init, gain/.test(err.message));
    err = await refused({});
    ok('a missing command is refused', err.code === 'bad_request');
    err = await refused({ command: 'init', agents: 'claude' });
    ok('init agents must be an array', err.code === 'bad_request' && /array of strings/.test(err.message));
    err = await refused({ command: 'init', agents: [1] });
    ok('...of strings', err.code === 'bad_request');
    err = await refused({ command: 'init', agents: ['claude', 'vim'] });
    ok('an unknown agent is refused before orvix runs', err.code === 'bad_request' && /unknown agent: vim/.test(err.message) && fake.calls.length === before);
    c.send({ type: 'orvix.command', sessionId: 'no-such-session', command: 'status' });
    err = await c.next((m) => m.type === 'session.error' || m.type === 'error');
    ok('a session that does not exist is not_found', err.code === 'not_found');

    // a connection that does not own the session cannot drive its index
    const intruder = await login(server, 'intruder');
    intruder.send({ type: 'orvix.command', sessionId: sid, command: 'index' });
    ok('another connection cannot run orvix.command on it', (await intruder.next((m) => m.type === 'session.error' || m.type === 'error')).code === 'not_found' && !fake.calls.slice(before).includes('indexNow'));
    await intruder.close();

    // resuming reports the status too
    await c.close();
    await sleep(30);
    const c2 = await login(server);
    c2.send({ type: 'session.resume', sessionId: sid });
    const resumed = await c2.next((m) => m.type === 'session.resumed' || m.type === 'error');
    ok('session.resumed carries the status of the code index', resumed.type === 'session.resumed' && same(resumed.orvix, { enabled: true, symbols: 9, indexing: false }));

    // the stream stops when the session is gone
    await c2.close();
    await server.close();
    ok('the status stream ends with the session (no listener is left behind)', fake.listenerCount() === 0);

    // a project where the layer is off, and a runtime without one
    const off = fakeOrvix({ enabled: false, symbols: 0, reason: 'not a git repository and fewer than 5 source files' });
    behavior.orvix = off;
    const server2 = await start();
    const d = await login(server2);
    const offSession = await newSession(d);
    behavior.orvix = null;
    ok('a disabled index is reported off and is not asked to build', offSession.orvix.enabled === false && !off.calls.includes('ensureIndex') && off.listenerCount() === 0);
    d.send({ type: 'orvix.command', id: 'o1', sessionId: offSession.sessionId, command: 'status' });
    const offStatus = await d.next((m) => m.id === 'o1');
    ok('orvix.command status says why it is off', offStatus.enabled === false && offStatus.output === 'the code index is off for this project: not a git repository and fewer than 5 source files');
    d.send({ type: 'orvix.command', id: 'o2', sessionId: offSession.sessionId, command: 'index' });
    ok('...and index does nothing', (await d.next((m) => m.id === 'o2')).output.startsWith('the code index is off for this project') && !off.calls.includes('indexNow'));
    const bare = await newSession(d);
    d.send({ type: 'orvix.command', id: 'o3', sessionId: bare.sessionId, command: 'gain' });
    ok('a runtime without a code index says so', (await d.next((m) => m.id === 'o3')).output === 'the code index is not available in this session' && same(bare.orvix, { enabled: false, symbols: 0, indexing: false }));
    await d.close();
    await server2.close();

    // an index that cannot start must not break session creation
    const broken = fakeOrvix();
    broken.ensureIndex = async () => { throw new Error('cannot start'); };
    behavior.orvix = broken;
    const server3 = await start();
    const e = await login(server3);
    const survivor = await newSession(e);
    behavior.orvix = null;
    ok('a session is still created when the index cannot start', survivor.type === 'session.created' && survivor.orvix.enabled === true);
    await e.close();
    await server3.close();
}

// =============================================================================
// [N] plans over the wire: plan.created, plan.implement, catalog.get
// =============================================================================
console.log('\n[N] plans: plan.created / plan.implement / catalog.get');
{
    const planLib = require('../lib/plans');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-srv-plans-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-srv-plans-outside-'));
    const rel = '.aicode/plans/ship-it.plan.md';
    const put = (where, text) => { fs.mkdirSync(path.dirname(where), { recursive: true }); fs.writeFileSync(where, text); };
    const TODOS = [{ id: 'a', content: 'First', status: 'pending' }, { id: 'b', content: 'Second', status: 'completed' }];
    put(path.join(project, rel), planLib.renderPlan({ title: 'Ship it', overview: 'Get it out.', markdown: '# Ship it\n\nDo the thing.\n', todos: TODOS }));
    const planText = fs.readFileSync(path.join(project, rel), 'utf8');
    fs.utimesSync(path.join(project, rel), new Date('2023-05-06T07:08:09Z'), new Date('2023-05-06T07:08:09Z'));

    const server = await start();
    const c = await login(server);
    const s = await newSession(c, undefined, project);
    const sid = s.sessionId;
    const rt = lastRuntime();
    const refused = async (message) => { c.send({ sessionId: sid, ...message }); return await c.next((m) => m.type === 'session.error' || m.type === 'error'); };

    // plan.created: what the write_plan tool tells the UI
    behavior.run = async (input, ui) => { ui.planCreated({ path: rel, title: 'Ship it', overview: 'Get it out.', todos: [{ id: 'a', content: 'First', status: 'pending' }] }); return USAGE; };
    let events = await turn(c, sid, 'plan something');
    const created = events.find(type('plan.created'));
    ok('plan.created carries the file, title, overview and todos', created && created.sessionId === sid && created.path === rel && created.title === 'Ship it' && created.overview === 'Get it out.' && same(created.todos, [{ id: 'a', content: 'First', status: 'pending' }]));
    ok('...before the turn ends', types(events).indexOf('plan.created') < types(events).indexOf('session.done'));
    behavior.run = async (input, ui) => { ui.planCreated({ path: `.aicode/plans/${SECRET}.plan.md`, title: `T ${SECRET}`, overview: `O ${SECRET}`, todos: [{ id: 'a', content: `C ${SECRET}`, status: 'pending' }] }); return USAGE; };
    events = await turn(c, sid, 'plan with a key in it');
    const masked = events.find(type('plan.created'));
    ok('a key that ends up in a plan is masked in every field', masked && !JSON.stringify(masked).includes(SECRET) && masked.title.includes('***') && masked.overview.includes('***') && masked.path.includes('***') && masked.todos[0].content.includes('***'));
    behavior.run = async (input, ui) => { ui.planCreated(); return USAGE; };
    events = await turn(c, sid, 'a plan with nothing in it');
    const empty = events.find(type('plan.created'));
    ok('a plan.created with no details is still well-formed', empty && empty.path === '' && empty.title === '' && empty.overview === '' && same(empty.todos, []));
    behavior.run = null;

    // plan.implement: a turn in Agent mode whose input is the plan file, exactly
    const lastCall = () => rt.calls[rt.calls.length - 1];
    c.send({ type: 'plan.implement', id: 'p1', sessionId: sid, path: rel });
    events = await c.until(type('session.done'));
    const text = planLib.implementText(rel, planText);
    ok('plan.implement runs the plan file as the input of a turn', lastCall().input === text && text.startsWith(`Implement the plan at ${rel}. `) && text.endsWith(planText));
    ok('...in agent mode, on the text exactly as written', lastCall().opts.modeOverride === 'agent' && lastCall().opts.verbatim === true && lastCall().opts.sessionId === sid);
    ok('...and answers like a turn: events, then session.done echoing the id', events[events.length - 1].type === 'session.done' && events[events.length - 1].id === 'p1' && events.some(type('ui.stream.end')));
    ok('...the turn is remembered with the plan as the user message', readJsonl(sessionFile(sid, project)).some((l) => l.role === 'user' && l.message.content[0].text === text));
    await turn(c, sid, 'and then?');
    ok('a normal input after it carries neither override', !('modeOverride' in lastCall().opts) && !('verbatim' in lastCall().opts) && lastCall().opts.history[0].content === text);

    put(path.join(project, 'docs', 'design.md'), '# A design\n\nBuild it.\n');
    const absolute = path.join(project, rel);
    c.send({ type: 'plan.implement', sessionId: sid, path: absolute });
    await c.until(type('session.done'));
    ok('an absolute path inside the project works, and the text names it relative', lastCall().input === text);
    c.send({ type: 'plan.implement', sessionId: sid, path: 'docs/design.md' });
    await c.until(type('session.done'));
    ok('any file of the project can be implemented, not only .aicode/plans', lastCall().input === planLib.implementText('docs/design.md', '# A design\n\nBuild it.\n'));

    const calls = rt.calls.length;
    let err = await refused({ type: 'plan.implement' });
    ok('plan.implement needs a path', err.type === 'session.error' && err.code === 'bad_request' && err.sessionId === sid && /plan file to implement/.test(err.message));
    err = await refused({ type: 'plan.implement', path: 7 });
    ok('...a string', err.code === 'bad_request' && /plan file to implement/.test(err.message));
    err = await refused({ type: 'plan.implement', path: '   ' });
    ok('...not blank', err.code === 'bad_request');
    err = await refused({ type: 'plan.implement', path: 'nope.plan.md' });
    ok('a plan that is not there is bad_request with the reason', err.code === 'bad_request' && err.message === 'plan not found: nope.plan.md');
    err = await refused({ type: 'plan.implement', path: '.aicode' });
    ok('a directory is refused', err.code === 'bad_request' && err.message === 'not a file: .aicode');
    put(path.join(outside, 'elsewhere.plan.md'), '# Not yours\n');
    err = await refused({ type: 'plan.implement', path: path.join(outside, 'elsewhere.plan.md') });
    ok('a file outside the project is refused (the path comes from a client)', err.code === 'bad_request' && /the plan must be inside the project/.test(err.message));
    err = await refused({ type: 'plan.implement', path: `../${path.basename(outside)}/elsewhere.plan.md` });
    ok('...also through ..', err.code === 'bad_request' && /the plan must be inside the project/.test(err.message));
    fs.symlinkSync(path.join(outside, 'elsewhere.plan.md'), path.join(project, 'docs', 'link.plan.md'));
    err = await refused({ type: 'plan.implement', path: 'docs/link.plan.md' });
    ok('...and through a link out of it', err.code === 'bad_request' && /the plan must be inside the project/.test(err.message));
    put(path.join(project, 'docs', 'huge.plan.md'), 'x'.repeat(planLib.MAX_PLAN_BYTES + 1));
    err = await refused({ type: 'plan.implement', path: 'docs/huge.plan.md' });
    ok('a plan too large to implement says so', err.code === 'bad_request' && /the plan is too large to implement \(\d+ KB, the limit is 100 KB\)/.test(err.message));
    ok('none of the refusals ran a turn', rt.calls.length === calls);
    c.send({ type: 'plan.implement', sessionId: 'no-such-session', path: rel });
    ok('a session that does not exist is not_found', (await c.next((m) => m.type === 'session.error' || m.type === 'error')).code === 'not_found');
    const intruder = await login(server, 'intruder');
    intruder.send({ type: 'plan.implement', sessionId: sid, path: rel });
    ok('another connection cannot implement into the session', (await intruder.next((m) => m.type === 'session.error' || m.type === 'error')).code === 'not_found' && rt.calls.length === calls);
    await intruder.close();

    // not while a turn is running, and not with nothing to run it
    let release;
    behavior.run = async () => { await new Promise((resolve) => { release = resolve; }); return USAGE; };
    c.send({ type: 'session.input', sessionId: sid, text: 'long running' });
    await sleep(50);
    err = await refused({ type: 'plan.implement', path: rel });
    ok('plan.implement while a turn runs -> busy', err.code === 'busy' && err.sessionId === sid);
    release();
    await c.next(type('session.done'));
    behavior.run = null;
    const unconfigured = await newSession(c, undefined, project);
    stub.provider = { provider: '', model: '' };
    c.send({ type: 'plan.implement', sessionId: unconfigured.sessionId, path: rel });
    err = await c.next((m) => m.type === 'session.error' || m.type === 'error');
    stub.provider = { provider: 'stub', model: 'stub-1' };
    ok('with no provider configured -> no_provider, nothing runs', err.code === 'no_provider' && lastRuntime().calls.length === 0);

    // catalog.get: plans
    c.send({ type: 'catalog.get', id: 'k1', kind: 'plans', cwd: project });
    const listed = await c.next((m) => m.id === 'k1');
    ok('catalog.get plans lists the plan files with their todos, newest first (id echoed)', listed.type === 'catalog.result' && listed.kind === 'plans' && listed.items.length >= 1);
    const item = listed.items.find((i) => i.path === rel);
    ok('...each with path, title, overview, todos and when it was changed', item && item.title === 'Ship it' && item.overview === 'Get it out.' && same(item.todos, TODOS) && item.updatedAt === '2023-05-06T07:08:09.000Z' && same(Object.keys(item).sort(), ['overview', 'path', 'title', 'todos', 'updatedAt']));
    c.send({ type: 'catalog.get', id: 'k2', kind: 'plans', cwd: project, query: 'SHIP get' });
    ok('...a query keeps those with every word, in any case', (await c.next((m) => m.id === 'k2')).items.map((i) => i.path).join() === rel);
    c.send({ type: 'catalog.get', id: 'k3', kind: 'plans', cwd: project, query: 'ship unrelated' });
    ok('...and none when a word is missing', (await c.next((m) => m.id === 'k3')).items.length === 0);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'aicode-srv-plans-bare-'));
    c.send({ type: 'catalog.get', id: 'k4', kind: 'plans', cwd: bare });
    ok('a project without plans lists none', same((await c.next((m) => m.id === 'k4')).items, []));

    // catalog.get: rules
    put(path.join(project, '.cursor', 'rules', 'style.mdc'), '---\ndescription: Code style for the web app\nglobs: src/**/*.ts\nalwaysApply: false\n---\nUse tabs.\n');
    put(path.join(project, '.cursor', 'rules', 'always.mdc'), '---\ndescription: House rules\nalwaysApply: true\n---\nBe kind.\n');
    c.send({ type: 'catalog.get', id: 'r1', kind: 'rules', cwd: project });
    const rules = await c.next((m) => m.id === 'r1');
    ok('catalog.get rules lists the project rules', rules.type === 'catalog.result' && rules.kind === 'rules' && same(rules.items.map((i) => i.name), ['always', 'style']));
    const style = rules.items.find((i) => i.name === 'style');
    ok('...with description, globs, alwaysApply and the file, and without the rule text', style.description === 'Code style for the web app' && same(style.globs, ['src/**/*.ts']) && style.alwaysApply === false && style.file === '.cursor/rules/style.mdc' && !('body' in style) && rules.items.find((i) => i.name === 'always').alwaysApply === true);
    c.send({ type: 'catalog.get', id: 'r2', kind: 'rules', cwd: project, query: 'WEB style' });
    ok('...a query matches name and description', (await c.next((m) => m.id === 'r2')).items.map((i) => i.name).join() === 'style');
    c.send({ type: 'catalog.get', id: 'r2b', kind: 'rules', cwd: project, query: 'house RULES' });
    ok('...whatever the case of the query or of the description ("House rules")', (await c.next((m) => m.id === 'r2b')).items.map((i) => i.name).join() === 'always');
    c.send({ type: 'catalog.get', id: 'r3', kind: 'rules', cwd: project, query: 'tabs' });
    ok('...but not the text of the rule', (await c.next((m) => m.id === 'r3')).items.length === 0);

    // catalog.get: skills (the project's, the user's, Cursor's), by name
    const skillFile = (root, name, description) => put(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nDo the SKILL_BODY_TEXT.\n`);
    skillFile(path.join(project, '.cursor', 'skills'), 'zebra', 'Draws stripes for the web');
    skillFile(path.join(project, '.agents', 'skills'), 'pdf-tool', 'Read and merge PDF files');
    skillFile(path.join(TMP_HOME, '.cursor', 'skills'), 'Deploy', 'Ship the app to staging');
    skillFile(path.join(project, '.agents', 'skills'), 'Zulu', 'A capital letter first: it sorts with the z\'s');
    skillFile(path.join(TMP_HOME, '.cursor', 'skills-cursor'), 'canvas', 'Cursor canvas, which needs Cursor');
    require('../lib/skills').clearCache();
    c.send({ type: 'catalog.get', id: 's1', kind: 'skills', cwd: project });
    const skillList = await c.next((m) => m.id === 's1');
    ok('catalog.get skills lists the installed skills by name, not in the order of the directories', skillList.type === 'catalog.result' && skillList.kind === 'skills' && same(skillList.items.map((i) => i.name), ['Deploy', 'pdf-tool', 'zebra', 'Zulu']));
    ok('...each with where it comes from', same(skillList.items.map((i) => i.origin), ['cursor-user', 'project', 'cursor-project', 'project']));
    const zebra = skillList.items.find((i) => i.name === 'zebra');
    ok('...its description and its SKILL.md: relative inside the project, absolute outside it', zebra.description === 'Draws stripes for the web' && zebra.file === '.cursor/skills/zebra/SKILL.md' && skillList.items.find((i) => i.name === 'Deploy').file === path.join(TMP_HOME, '.cursor', 'skills', 'Deploy', 'SKILL.md'));
    ok('...and nothing else: no instructions, no folder', same(Object.keys(zebra).sort(), ['description', 'file', 'name', 'origin']) && !JSON.stringify(skillList).includes('SKILL_BODY_TEXT'));
    ok('...a skill on the deny-list (one that needs Cursor) is not offered', !skillList.items.some((i) => i.name === 'canvas'));
    c.send({ type: 'catalog.get', id: 's2', kind: 'skills', cwd: project, query: 'STRIPES web' });
    ok('...a query keeps those with every word in the name or description, in any case', (await c.next((m) => m.id === 's2')).items.map((i) => i.name).join() === 'zebra');
    c.send({ type: 'catalog.get', id: 's3', kind: 'skills', cwd: project, query: 'deploy' });
    ok('...also in the name', (await c.next((m) => m.id === 's3')).items.map((i) => i.name).join() === 'Deploy');
    c.send({ type: 'catalog.get', id: 's4', kind: 'skills', cwd: project, query: 'SKILL_BODY_TEXT' });
    ok('...but not in the instructions', (await c.next((m) => m.id === 's4')).items.length === 0);
    c.send({ type: 'catalog.get', id: 's5', kind: 'skills', cwd: bare });
    ok('a project without skills still lists the user\'s', (await c.next((m) => m.id === 's5')).items.map((i) => i.name).join() === 'Deploy');

    // catalog.get: what it refuses
    const asked = async (message) => { c.send({ type: 'catalog.get', ...message }); return await c.next((m) => m.type === 'error' || m.type === 'session.error' || m.type === 'catalog.result'); };
    err = await asked({ id: 'e1', kind: 'bogus', cwd: project });
    ok('an unknown kind is bad_request and lists the available ones', err.type === 'error' && err.code === 'bad_request' && err.message === 'unknown catalog kind: bogus. Available: plans, rules, skills');
    err = await asked({ id: 'e2', cwd: project });
    ok('a missing kind too', err.code === 'bad_request' && /\(missing\)/.test(err.message));
    err = await asked({ id: 'e3', kind: 'toString', cwd: project });
    ok('a kind that is a property of every object is not a kind', err.code === 'bad_request' && /unknown catalog kind: toString/.test(err.message));
    err = await asked({ id: 'e4', kind: '__proto__', cwd: project });
    ok('...nor __proto__', err.code === 'bad_request');
    err = await asked({ id: 'e5', kind: 'plans' });
    ok('a missing cwd is bad_cwd', err.code === 'bad_cwd');
    err = await asked({ id: 'e6', kind: 'plans', cwd: 'relative/dir' });
    ok('...so is a relative one', err.code === 'bad_cwd');
    err = await asked({ id: 'e7', kind: 'plans', cwd: path.join(project, 'not-a-dir') });
    ok('...and one that is not there', err.code === 'bad_cwd');
    c.send({ type: 'catalog.get', id: 'q1', kind: 'plans', cwd: project, query: 42 });
    ok('a query that is not a string is no query', (await c.next((m) => m.id === 'q1')).items.length >= 1);

    await c.close();
    await server.close();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
}

fs.rmSync(TMP_HOME, { recursive: true, force: true });
fs.rmSync(PROJECT, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
